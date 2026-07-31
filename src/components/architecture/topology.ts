/**
 * Architecture page — chapter 1: what the deployment looks like from outside,
 * and how a request finds its way to the CMS, a preview, or the boot page.
 */
import type { ArchSection } from './types';

export const topologySections: ArchSection[] = [
  {
    id: 'topology',
    title: 'System topology',
    intro: `One process serves everything. A native Pingora listener — a Rust
      addon loaded into the Node process over N-API — owns the public port and
      routes by <code>Host</code>: the CMS itself, one of the running branch
      preview servers, or the boot page that starts a preview on demand. There
      is no second service to deploy and no reverse proxy to configure.`,
    diagrams: [
      {
        code: `
flowchart TB
  browser(["Browser"]) --> router{{"Native listener — routes by Host"}}

  router -->|"BASE_DOMAIN"| pages
  router -->|"branch.BASE_DOMAIN"| devsrv
  router -->|"cold branch"| boot

  subgraph proc["Node process — the CMS"]
    direction TB
    pages["Astro SSR<br/>pages, API, SSE"]
    boot["Preview boot page"]
    pages --> authmod["better-auth — OIDC"]
    pages --> agent["Agent loop<br/>streaming turn machine"]
    pages --> flows["DeployFlow registry"]
    boot --> prevmgr["Preview manager"]
    agent --> mcp["In-process MCP<br/>phase-gated tools"]
    mcp --> gitengine["Git engine"]
    mcp --> vdiff["Visual diff"]
  end

  subgraph jail["bwrap jail — every site shell call"]
    direction TB
    devsrv["Branch dev servers"]
    builds["Builds, installs,<br/>run_command, MCP servers"]
  end

  prevmgr -->|"spawn"| devsrv
  prevmgr -->|"routes over N-API"| router
  flows --> builds
  agent --> model(["Model endpoint"])
  pages --> db[("PostgreSQL")]
  gitengine --> repo[("Git repo + worktrees")]
`,
      },
    ],
    notes: `<ul>
      <li><strong>The routing table is pushed, not polled.</strong> The preview
        manager calls into the addon whenever an instance becomes ready or
        stops. <code>VAR_DIR/proxy-routes.json</code> is written too, but only
        as a boot/crash fallback; <code>proxy-access.json</code> flows the
        other way and carries the per-branch last-access timestamps the idle
        sweeper reads.</li>
      <li><strong>Preview HTML is rewritten in flight.</strong> Responses from
        a branch dev server get the overlay bundle injected, so the preview can
        talk to the workspace (element picking, selection, navigation). WebSocket
        upgrades pass through untouched — that is how the site's own HMR keeps
        working inside the CMS.</li>
      <li><strong>Sessions are shared with previews.</strong> The auth cookie is
        scoped to <code>.BASE_DOMAIN</code>, so a preview subdomain is
        authenticated by the same sign-in; the addon holds a copy of the live
        session tokens so it can reject anonymous preview traffic without a
        round trip into Node.</li>
      <li><strong>Nothing the site owns runs on the host.</strong> Dev servers,
        <code>npm install</code>, publish builds and repo-configured MCP servers
        all execute inside the bubblewrap jail — see
        <a href="#sandbox">the sandbox section</a>.</li>
    </ul>`,
    source: [
      'src/lib/proxyNative.ts',
      'src/lib/preview/manager.ts',
      'proxy/src',
      'server.mjs',
    ],
  },

  {
    id: 'routing',
    title: 'Request routing and preview boot',
    intro: `A preview subdomain is a promise, not a running server. When the
      branch has no live dev server the listener rewrites the request to an
      internal boot path; the CMS answers with a small page that opens an SSE
      stream and reloads itself the moment the preview is ready. The user sees
      a progress line instead of a connection error.`,
    diagrams: [
      {
        caption: 'Host resolution',
        code: `
flowchart TD
  req(["Incoming request"]) --> host{"Host"}
  host -->|"BASE_DOMAIN"| cms["CMS: Astro SSR + API"]
  host -->|"unknown host"| nf["404 — the listener answers directly"]
  host -->|"branch.BASE_DOMAIN"| known{"Route in the table?"}

  known -->|"yes"| upstream["Proxy to that dev server"]
  known -->|"no"| rewrite["Rewrite to __preview/boot/branch"]

  upstream --> kind{"Response type"}
  kind -->|"HTML"| inject["Inject the overlay bundle"]
  kind -->|"WebSocket upgrade"| pass["Pass through — site HMR"]
  kind -->|"anything else"| raw["Untouched"]

  rewrite --> stamp["Stamp X-Cms-Proxy<br/>on the upstream request"]
  cms --> stamp
  stamp --> mw["Astro middleware"]
  mw --> front{"X-Cms-Proxy valid?"}
  front -->|"no — reached the app port directly"| note["403 with the public address"]
  front -->|"yes"| authed{"Signed in?"}
  authed -->|"no"| signin["Redirect to /signin/"]
  authed -->|"yes"| bootpage["Boot page + ensureInstance"]
`,
      },
      {
        caption: 'Boot handshake',
        code: `
sequenceDiagram
  autonumber
  participant B as Browser
  participant P as Native listener
  participant M as Middleware
  participant PM as Preview manager
  participant D as Dev server (jail)

  B->>P: GET branch.BASE_DOMAIN/
  P->>M: rewrite to __preview/boot/branch
  M->>PM: ensureInstance(branch)
  M-->>B: boot page (progress + SSE client)
  B->>M: GET __preview/wait/branch (SSE)
  PM->>D: npm install if the deps hash moved
  Note over PM,D: phase "deps"
  PM->>D: spawn the dev server
  Note over PM,D: phase "server"
  PM->>PM: poll HTTP until it answers
  PM->>P: routing table updated
  PM-->>M: routes changed
  M-->>B: SSE: ready
  B->>P: reload branch.BASE_DOMAIN/
  P->>D: proxy + inject overlay
`,
      },
    ],
    notes: `<ul>
      <li><strong>Direct hits on the CMS host are redirected, not served.</strong>
        <code>&lt;branch&gt;.BASE_DOMAIN</code> is the only place the boot page
        belongs. Asking the CMS host for the internal boot path would refresh-loop
        forever, so the middleware bounces the browser to the real preview host
        and lets the listener rewrite it from there.</li>
      <li><strong>The app answers only through its front door.</strong>
        Everything the middleware does assumes the listener already routed the
        host, authorized the preview and rewrote the path — so a request that
        arrives at the app's own port skipped all of it. The listener stamps
        <code>X-Cms-Proxy</code> with a token derived from the shared
        <code>BETTER_AUTH_SECRET</code>, replacing any value the client sent;
        without it the CMS returns 403 and the public address instead of a
        page. Deriving the token rather than forwarding the secret keeps it out
        of upstream logs. There is no opt-out, development included: a CMS
        reached on its own port cannot route a preview host or inject the
        overlay, so what it serves is a half-working workspace whose failures
        read as application bugs. The two implementations are pinned to one
        token by a shared test vector — they ship in the same image, and a
        mismatch would refuse every request. The one exception is the build
        itself: prerendered routes run their middleware at build time, where no
        proxy exists, and are served as static files that never reach the
        middleware again — so the guard steps aside for them, or its own
        response ends up baked into the shipped bundles.</li>
      <li><strong>The boot page is authenticated.</strong> Both it and its SSE
        wait stream require a session — an anonymous visitor is redirected to
        sign-in, and the stream answers 401.</li>
      <li><strong>Failures are shown, not swallowed.</strong> A start that dies
        before it accepts HTTP is recorded per branch with the tail of the dev
        server's own output, and the boot page renders that text with a
        <em>Retry</em> button. Retry re-runs the start with a forced dependency
        re-install, which is the repair path for a half-installed worktree.</li>
      <li><strong>Historical previews are read-only.</strong>
        <code>v-&lt;sha&gt;.BASE_DOMAIN</code> resolves to a detached checkout of
        that commit, so any published state can be looked at without touching a
        branch.</li>
    </ul>`,
    source: [
      'src/middleware.ts',
      'src/lib/proxyGuard.ts',
      'proxy/src/auth.rs',
      'src/lib/preview/bootPage.ts',
      'src/lib/preview/waitStream.ts',
      'src/lib/injected/bundle.ts',
    ],
  },
];
