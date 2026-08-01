/**
 * Architecture page — chapter 3: the runtime pieces the state machines sit on.
 * Git model, warm previews, tool gating, the jail, state streaming, the
 * preview overlay, and every lock in the system.
 */
import type { ArchSection } from './types';

export const runtimeSections: ArchSection[] = [
  {
    id: 'git-model',
    title: 'Git and branch model',
    intro: `Branch equals subdomain equals draft. Every chat owns a private work
      branch based on the target branch it will merge into, so chats on the same
      target never block each other; the target is locked only for the moment of
      the publish merge. History is append-only — undo is a revert commit, never
      a rewrite.`,
    diagrams: [
      {
        caption: 'One chat, from first edit to published',
        code: `
gitGraph
  commit id: "site history"
  commit id: "someone else published"
  branch c-4f2a1b
  checkout c-4f2a1b
  commit id: "execution: write the post"
  commit id: "execution: link it from the index"
  commit id: "undo of the second one" type: REVERSE
  commit id: "execution: link it properly"
  commit id: "sync team knowledge"
  checkout main
  merge c-4f2a1b id: "publish"
  commit id: "deploy flow ran" type: HIGHLIGHT
`,
      },
      {
        caption: 'Naming and storage',
        code: `
flowchart LR
  subgraph names["Names are the API"]
    target["Target branch<br/>main, or a long-lived branch"]
    work["Work branch — c-hex<br/>one per chat, hidden from listings"]
    hist["v-sha<br/>read-only historical preview"]
  end

  subgraph disk["On disk, under VAR_DIR"]
    wt["worktrees/branch"]
    home["sandbox/home/key<br/>npm cache, per branch and per chat"]
    art["artifacts/sha<br/>tarball + checksum manifest"]
  end

  target -->|"chat created — branch off"| work
  work -->|"publish merge"| target
  work -->|"after publish — reset onto the new target"| work
  target --> hist
  work --> wt
  target --> wt
  work --> home
  target --> art
`,
      },
    ],
    notes: `<ul>
      <li><strong>One commit per execution.</strong> The agent commits each
        completed step itself; finalize validates and commits whatever is left —
        typically only the synced team knowledge — as one self-contained commit
        recorded as an <code>Execution</code> row.</li>
      <li><strong>Undo is a revert.</strong> Reverting an execution creates a
        revert commit under the work branch lock and marks the original row with
        the sha that undid it. Nothing is rebased away, so a published history
        can always be read back. The revert commit gets an
        <code>Execution</code> row of its own — see the next point for why.</li>
      <li><strong>Every publishable head is a row.</strong> Publishing binds the
        exact sha the human reviewed, and the sha the workspace offers is the
        newest non-reverted <code>Execution</code>. So any commit that becomes
        the work-branch head has to be recorded, or the chat is stuck: it keeps
        offering a sha the branch has moved past, and only a further change
        would ever advance it. Two paths move the head without the agent
        committing — a revert, and the sync rebase, which rewrites every commit
        and invalidates every recorded sha at once. Sync therefore re-anchors
        the rows onto the rewritten commits (matched by subject, in rebase
        order) and records the new head if nothing else claims it.</li>
      <li><strong>A publish builds a commit that is on no branch.</strong> The
        deploy automatism's validate step writes the tree the merge would
        produce into the object store as a dangling commit and builds that. The
        branch graph stays exactly as it was until the build passes.</li>
      <li><strong>Branch names are DNS-safe by validation.</strong> They are
        hostnames, so the name check runs before anything is created; work
        branches use a generated hex suffix, which is also how branch listings
        know to hide them.</li>
      <li><strong>A stray real branch keeps its commits.</strong> Cleanup may
        reclaim a checkout it cannot account for, but it only ever deletes the
        git ref of generated work branches — a branch someone pushed minutes ago
        has regenerable working files and irreplaceable commits.</li>
      <li><strong>A clean sync can still break the site.</strong> Git reports
        success for a rebase that renamed a component out from under a page, and
        nobody looks at the preview right after pressing Sync. So the flow looks:
        a check step asks the site backend whether the draft still renders (an
        Astro dev server answers a compile error with a 500; a static site has no
        such answer, so it is not asked) and a broken draft pauses the flow like
        a merge conflict does — the chat is forced into EXECUTE, the error is
        posted as the agent's brief, and resuming re-runs the check instead of
        trusting the fix.</li>
    </ul>`,
    source: [
      'src/lib/git/engine.ts',
      'src/lib/git/identity.ts',
      'src/lib/branchSync.ts',
      'src/lib/site/health.ts',
      'src/lib/agent/tools/commitTools.ts',
      'src/lib/publish/publisher.ts',
    ],
  },

  {
    id: 'warm-pool',
    title: 'Warm previews and orphan cleanup',
    intro: `Two background loops keep the stage from being cold and the disk
      from filling up. One keeps the branches chats fork from running and a
      single spare work branch installed ahead of the next chat; the other
      reconciles what is on disk against what the database still claims.`,
    diagrams: [
      {
        caption: 'Warming',
        code: `
flowchart TD
  tick(["Every 60 seconds"]) --> primary["Pin every branch a chat can start from"]
  primary --> drop["Unpin branches that disappeared"]
  drop --> each{"For each primary branch"}
  each -->|"already starting or running"| skip["Leave it alone — killing a slow start<br/>makes it begin again"]
  each -->|"cold"| warmup["ensureInstance — one at a time"]
  skip --> spare
  warmup --> spare{"Spare work branch present?"}
  spare -->|"yes, or warming"| doneA(["Wait for the next tick"])
  spare -->|"no"| mint["Mint c-hex off the default branch<br/>worktree, install, dev server"]
  mint --> doneA

  claim(["New chat created"]) --> adopt{"Targets the default branch?"}
  adopt -->|"yes, spare ready"| behind{"Target moved since it was warmed?"}
  adopt -->|"no"| cold["Mint a cold branch name"]
  behind -->|"yes"| reset["Reset it onto the target<br/>node_modules survives"]
  behind -->|"no"| take
  reset --> take["Adopt it — no install to wait for"]
  take --> refill["Start warming the next spare"]
`,
      },
      {
        caption: 'Hourly orphan sweep',
        code: `
flowchart TB
  scan(["Directories under VAR_DIR"]) --> keep{"Claimed by anything live?"}

  subgraph keeplist["The keep list"]
    direction TB
    k1["Work branch of an existing chat"]
    k2["A Branch row, or the default branch"]
    k3["A spare or warming pool branch"]
    k4["A preview serving right now"]
    k5["A live chat id, or the shared home"]
  end

  keeplist -.-> keep
  keep -->|"yes"| stay["Left untouched"]
  keep -->|"no"| kind{"Generated work branch?"}
  kind -->|"yes"| full["Stop the preview, remove the worktree,<br/>delete the ref, drop the sandbox home"]
  kind -->|"no"| partial["Remove the checkout only —<br/>the git ref is never deleted"]
`,
      },
    ],
    notes: `<ul>
      <li><strong>Exactly one spare, on purpose.</strong> Creating a worktree is
        cheap; the first install in it is not. One pre-installed branch removes
        that wait for the next chat. It is deliberately not pinned — the idle
        sweeper may stop its dev server, and the installed worktree, the part
        that cost time, survives that.</li>
      <li><strong>Only default-branch chats may adopt it.</strong> The spare is
        branched off the default branch, so a chat targeting anything else would
        start from the wrong content.</li>
      <li><strong>A spare catches up before it is adopted.</strong> It was
        branched off the target when it was warmed and then waited, so every
        publish in between left it a commit further behind — a chat starting on
        it would edit stale content, diff against the wrong base, and have to
        sync before it could publish, which is the very wait the pool exists to
        remove. Claiming resets it onto the target first. Nothing has been
        committed to a spare, so there is nothing to preserve, and
        <code>node_modules</code> is gitignored: the expensive half of the
        warm-up survives the reset. A reset that fails is logged and the branch
        handed over anyway — no worse than before the attempt.</li>
      <li><strong>Cleanup is keep-list driven, never pattern driven.</strong>
        A name nobody claims is leftovers. That ordering matters: the pool's
        spare has no chat by design and a running preview may outlive its row,
        and both would look exactly like garbage to a pattern matcher.</li>
      <li><strong>One failure does not stop the sweep.</strong> A locked worktree
        is logged and skipped; the rest of the pass continues. Both loops run on
        named tickers that skip a tick while the previous one is still going —
        see <a href="#locks">locks and concurrency guards</a> for why the newest
        module evaluation owns them.</li>
      <li><strong>Sandbox homes are keyed twice.</strong> Preview installs key by
        branch, while command runs, linting and codebase memory key by chat id —
        so both namespaces are reconciled.</li>
    </ul>`,
    source: ['src/lib/preview/prewarm.ts', 'src/lib/worktreeCleanup.ts'],
  },

  {
    id: 'tools',
    title: 'Tool registry and phase gating',
    intro: `Tools are declared once — name, description, zod schema, the phases
      they belong to, and optionally the chat kinds or deploy flows they are
      scoped to. The set offered to the model for a turn is derived from the
      chat's persisted phase, and the same predicate is checked again when a
      call actually arrives.`,
    diagrams: [
      {
        code: `
flowchart TD
  reg["registerTool — schema, phases, kinds, flows"] --> registry[("Tool registry")]

  turn(["Turn starts"]) --> derive["toolsForPhase: persisted phase,<br/>chat kind, deploy flow"]
  registry --> derive
  derive --> bridge["In-process MCP server<br/>over an in-memory transport"]
  bridge --> asfn["Exposed as OpenAI function tools"]
  asfn --> model(["Model"])

  model -->|"tool call"| dispatch{"Client-side tool?"}
  dispatch -->|"yes — no execute function"| pause["Pause the turn, ask the browser"]
  dispatch -->|"no"| checks

  subgraph checks["executeTool re-checks, in order"]
    c1{"Known name?"}
    c2{"Allowed for this chat kind?"}
    c3{"Belongs to this deploy flow?"}
    c4{"Allowed in this phase?"}
    c5{"Input matches the schema?"}
  end

  checks -->|"any check fails"| refuse["Return an error as the tool result —<br/>the turn continues"]
  checks -->|"all pass"| exec["Execute against the chat worktree"]

  ext["External MCP servers<br/>admin-global and repo-local"] --> group{"Is its group loaded?"}
  group -->|"no"| never["Never attached —<br/>the server does not start"]
  group -->|"yes"| access{"mcpAccess for the phase<br/>and the chat kind"}
  access -->|"read-only only"| filter["Keep the tools that<br/>declare readOnlyHint"]
  access -->|"full access"| bridged
  filter --> bridged["Merged into the tool namespace,<br/>inside the jail"]
  bridged -.-> bridge
`,
      },
      {
        caption: 'Which external tools a turn gets',
        code: `
flowchart LR
  g0{"MCP group"} -->|"phase default, or loaded earlier"| q0
  g0 -->|"anything else"| off["Absent until load_mcp<br/>asks for it"]
  q0{"Chat kind"} -->|"deployments monitor"| ro["Every source, but only<br/>declared read-only tools"]
  q0 -->|"workflow or deployment"| q1{"Source"}
  q1 -->|"codebase-memory, Context7"| all["Every tool, in every phase"]
  q1 -->|"admin mcp.json, repo .mcp.json"| q2{"Phase"}
  q2 -->|"EXECUTE"| full["Every tool"]
  q2 -->|"PLAN or PUBLISHED"| partial["Only the tools that<br/>declare readOnlyHint"]
`,
      },
    ],
    notes: `<ul>
      <li><strong>Hiding is not enforcement.</strong> A tool outside the current
        phase is rejected in the executor even if the model invents the call, so
        a hallucinated write in the read-only phase fails as data, not as a
        crash.</li>
      <li><strong>Client-side tools are the ones with no implementation.</strong>
        <code>ask_question</code>, <code>pick_color</code> and
        <code>finish_execution</code> exist only as schemas; reaching one pauses
        the turn and hands the payload to the browser to render as a card.</li>
      <li><strong>Errors come back as results.</strong> Schema failures and
        thrown exceptions are serialized into the tool result rather than
        aborting the turn — the agent can read what went wrong and try
        something else.</li>
      <li><strong>Deployment chats borrow the EXECUTE tool set.</strong> Their
        stored phase is <code>published</code>, but the context handed to the
        registry says execute, which is what lets them resolve conflicts.</li>
      <li><strong>A paused automatism brings its own tools.</strong> The failed
        step declares what its repair needs — conflict tools for a rebase, the
        site diagnostics for a broken page, read-only publication state for a
        deploy — and that set REPLACES the phase's for the repair turn. The
        phase describes what the user's work is up to; a stopped step is a
        different job. It also means the flow no longer moves the chat into
        EXECUTE behind the user's back just to unlock writes, and no longer
        owes it a restore afterwards.</li>
      <li><strong>Starting or ending a repair ends the run.</strong> The tool
        set and the prompt were built for that contract, so
        <code>resume_automatism</code> ends the run exactly the way a
        workflow-phase flip does and the handler starts a fresh one — the user
        still sees a single turn.</li>
      <li><strong>External MCP servers are first-class but jailed.</strong>
        Servers defined in an admin-global config and in the branch's own repo
        config are bridged into the same tool namespace; the whole runtime for
        them executes inside the sandbox, and the global config wins name
        collisions.</li>
      <li><strong>The phase boundary covers them too.</strong> The sandbox
        protects the host and the secrets; it cannot know that PLAN means
        read-only, so a mutating third-party server used to be reachable while
        the phase was. A custom server's full tool set now arrives with
        EXECUTE, and while the phase is read-only it contributes only the tools
        that say they are. The two integrations we ship and configure
        ourselves, the codebase graph and Context7, stay available
        throughout.</li>
      <li><strong>A server's declaration is taken at face value.</strong> A
        tool that declares MCP's <code>readOnlyHint</code> is treated as
        read-only on that word alone — which is what lets a docs or lookup
        server be useful during planning. Silence is not a declaration, so a
        tool that says nothing waits for EXECUTE. The same reduction is what
        the deployments monitor runs on, in every phase.</li>
      <li><strong>The bridge has to carry the annotation.</strong> Custom
        servers reach the agent through the mcporter bridge, whose tool listing
        projects annotations away; the bridge therefore reads them off the raw
        MCP client and re-attaches them. Without that one step every custom
        tool would count as mutating and planning would see none of them.</li>
      <li><strong>Repo-defined servers are trusted on purpose.</strong> A
        branch's <code>.mcp.json</code> is content the client put into their
        own site repository, so the question it raises is when a server may
        run, not whether it may exist — and in production it runs inside the
        sandbox either way. The phase is the gate; the jail is the
        containment.</li>
      <li><strong>The gate is the phase, never the sandbox mode.</strong>
        <code>SANDBOX_MODE=none</code> is a development fallback; if it changed
        the tool set, what gets tested would not be what ships.</li>
      <li><strong>Tools are loaded per group, not all at once.</strong> Every
        MCP server is a group of its own, and several can share a set they
        declare in the same config. A turn starts with the chat's defaults;
        anything else the agent loads with <code>load_mcp</code> after finding
        it with <code>query_mcps</code>, and the load lasts for the rest of the
        chat. A group nobody asked for costs no prompt tokens and never starts
        its server — which is the part hiding the tools alone would not
        buy.</li>
      <li><strong>Skills are selected before the prompt is written.</strong> A
        small router model reads the skill and group indexes and names what
        this request is likely to need; <code>query_skills</code> reaches the
        rest. It deliberately has no fallback: if routing fails, the turn
        fails, because the alternative — quietly listing every skill again —
        is exactly the cost this removes and nothing would ever surface
        it.</li>
    </ul>`,
    source: [
      'src/lib/agent/tools/registry.ts',
      'src/lib/automatism.ts',
      'src/lib/agent/mcp/index.ts',
      'src/lib/agent/mcp/policy.ts',
      'src/lib/agent/mcp/groups.ts',
      'src/lib/agent/mcp/custom.ts',
      'src/lib/agent/mcp/bridgeEntry.ts',
      'src/lib/agent/skillRouter.ts',
      'src/lib/agent/tools/capabilityTools.ts',
      'src/lib/agent/prompt.ts',
    ],
  },

  {
    id: 'sandbox',
    title: 'The sandbox jail',
    intro: `Everything the managed site can influence runs inside a bubblewrap
      jail: dependency installs, the preview dev server, publish builds, the
      command tool, and any MCP server the repository defines. The jail starts
      from an empty root — only what is explicitly bound in exists.`,
    diagrams: [
      {
        code: `
flowchart TB
  subgraph host["On the host"]
    squash[("Nix-built squashfs<br/>one store per node major")]
    wtdir[("The chat's worktree")]
    homedir[("Per-session HOME")]
  end

  squash -->|"squashfuse, or extracted<br/>when /dev/fuse is missing"| store
  wtdir --> work
  homedir --> home

  subgraph jailbox["bwrap jail — empty root, deny by default"]
    direction LR
    store["/nix/store<br/>bound OVER the app's"]
    work["/work<br/>read-only for a script without write"]
    home["/home/sandbox"]
    skill["/skill — read-only<br/>only when a skill script runs"]
    etc["minimal /etc — DNS<br/>absent when the run has no network"]
    tmp["tmpfs, proc, dev"]
  end

  jailbox --> inside

  subgraph inside["Everything the site can influence"]
    direction LR
    npm["npm install"]
    dev["Preview dev server"]
    build["Publish builds"]
    cmd["run_command"]
    mcpsrv["Repo-defined MCP servers"]
  end

  major(["SANDBOX_NODE_MAJOR"]) -.->|"picks the store"| store
  net(["SANDBOX_ALLOW_NETWORK"]) -.->|"installs need it"| inside
`,
      },
    ],
    notes: `<ul>
      <li><strong>A skill's scripts run here too, with less.</strong> A skill
        may ship scripts; the model names a declared one and the registry
        supplies the path, so nothing it says selects a file. The skill's own
        directory is mounted read-only at <code>/skill</code>, arguments go as
        argv rather than through a shell, and the defaults are narrower than
        <code>run_command</code>: a read-only <code>/work</code> and no network
        unless the skill declared otherwise. A script only mentioned in a
        skill's prose is runnable but can never carry those declarations — the
        same rule the MCP policy applies to undeclared tools.</li>
      <li><strong>"Read-only" tools are not exempt.</strong> Linters, formatters
        and framework checks execute the repository's own config files as code.
        Running one on the host with the inherited environment would be remote
        code execution plus credential exfiltration in the same call — so they
        are jailed like everything else, and no child ever receives a copy of the
        server's environment.</li>
      <li><strong>Repo-defined MCP servers are acceptable only because of the
        jail.</strong> They get exactly the privileges the command tool already
        has: the worktree, a clean environment, and the sandbox toolset.</li>
      <li><strong>The container needs a targeted seccomp profile.</strong>
        bubblewrap has to create user and mount namespaces and mount a fresh
        <code>/proc</code>; the shipped profile allows precisely that and nothing
        broader.</li>
      <li><strong>Environment binaries are absolute store symlinks.</strong> They
        resolve inside the jail and nowhere else, so host-side checks have to
        inspect the link itself rather than follow it.</li>
      <li><strong>Several node majors ship in one image.</strong> Each is a
        self-contained store inside the squashfs, deduplicated at build time;
        only the selected major is materialized at runtime.</li>
    </ul>`,
    source: [
      'src/lib/sandbox/index.ts',
      'src/lib/agent/mcp/bridgeEntry.ts',
      'src/lib/agent/skillScripts.ts',
      'src/lib/agent/tools/skillScriptTools.ts',
      'deploy/seccomp',
    ],
  },

  {
    id: 'state-sync',
    title: 'Streamed chat state',
    intro: `Workflow and side state — phase, plan, executions, publish card,
      automatism step bar, task list, title, turn state — is one server-computed
      snapshot. It is rebuilt and broadcast in full after any mutation, and the
      client applies it by plain replacement. There is no patch protocol and no
      merge.`,
    diagrams: [
      {
        code: `
sequenceDiagram
  autonumber
  participant M as Any mutation
  participant E as emitChatState
  participant B as buildChatState
  participant DB as Database
  participant S as SSE subscribers
  participant C as Client

  M->>E: chat id
  E->>E: coalesce same-tick calls into one
  E->>B: build
  B->>DB: chat, executions, tasks, publication, automatism, target-ahead
  B-->>E: snapshot
  E->>E: stamp the next seq for this chat
  E->>S: broadcast state
  S-->>C: state event
  C->>C: drop it if seq is older than the applied one
  C->>C: otherwise replace wholesale — server wins

  Note over B,C: /api/chat/history and the SSE connect replay<br/>call the same builder, so they cannot drift
`,
      },
    ],
    notes: `<ul>
      <li><strong>Add state by adding it to the snapshot.</strong> Anything
        persisted server-side and included in the builder reaches history, the
        live stream and reconnect replay for free. A card rendered only from a
        bespoke event vanishes on reload.</li>
      <li><strong>Only append-only things bypass it.</strong> Transcript tokens,
        publish log lines, automatism messages and the commit anchor are streams,
        not state, and a snapshot genuinely cannot express them.</li>
      <li><strong>The full event vocabulary</strong> on the per-chat stream:
        <code>state</code>, <code>thinking</code>, <code>text_delta</code>,
        <code>text_done</code>, <code>tool_start</code>, <code>tool_end</code>,
        <code>question</code>, <code>compaction_start</code>,
        <code>compaction</code>, <code>automatism</code>,
        <code>execution_committed</code>, <code>publish_log</code>,
        <code>compare_stale</code>, <code>open_compare</code>,
        <code>ui_language</code>, <code>stopped</code>,
        <code>done</code>, <code>error</code>. Everything that is not in the
        append-only list above is derivable from the snapshot — and the list is
        exactly what the client listens for. Events nobody emits used to sit in
        both halves (a <code>version_restored</code> the browser never heard, a
        <code>publish_done</code> nobody sent), which reads as a live path and
        hides the fact that the snapshot is doing the work.</li>
      <li><strong>Sequence and epoch are a stale-drop guard, nothing more.</strong>
        The sequence is per chat and per process; the epoch is regenerated on
        restart so clients reset with it. History snapshots carry sequence zero
        and are skipped when a live one arrived during the fetch.</li>
      <li><strong>Tabs are per user.</strong> A snapshot carries tab state only
        when the change that triggered it was a tab write, and it names the
        owning user — other clients ignore it. Absent means "no information",
        never "no tabs".</li>
      <li><strong>Emission is fail-soft.</strong> A snapshot that cannot be built
        is logged and dropped; state broadcasting must never break the mutation
        that triggered it.</li>
      <li><strong>The registry lives on the global object.</strong> In
        development the server module graph is hot-reloaded, and a plain
        module-level map would split into old and new instances — live
        connections stranded in the old one, every broadcast silently going
        nowhere. Connections, locks, sequence counters and preview instances all
        avoid that the same way.</li>
    </ul>`,
    source: ['src/lib/agent/chatState.ts', 'src/lib/agent/bus.ts', 'src/pages/api/chat/events.ts'],
  },

  {
    id: 'compare-alignment',
    title: 'Compare alignment',
    intro: `The before/after views compare two renderings of a page whose
      content moved. Aligning them is not an image problem — the same paragraph
      simply sits at a different y once something above it grew — so the
      comparison is anchored on CONTENT, and the shots are re-rendered with real
      spacing rather than sliced on a canvas.`,
    diagrams: [
      {
        caption: 'From two pages to two comparable shots',
        code: `
flowchart TD
  cap["Screenshot each side<br/>(main instance, branch instance)"] --> mark["Collect content markers<br/>tag + text prefix + occurrence"]
  mark --> lcs["Match the two marker lists<br/>LCS, order-preserving"]
  lcs --> conf{"Confidence above the floor?"}
  conf -->|"no"| plain["Plain shots — the panes still<br/>work, they just do not co-scroll"]
  conf -->|"yes"| part["Partition both shots into rectangles<br/>by full-span gaps (guillotine cuts)"]
  part --> shape{"Trees match by shape?"}
  shape -->|"no"| leaf["Align that region as one 1-D leaf"]
  shape -->|"yes"| plan["Per leaf: how much filler each side needs"]
  leaf --> plan
  plan --> inject["Re-render with spacer divs injected<br/>— a real reflow, not a canvas slice"]
  inject --> conv{"Residual above the threshold?"}
  conv -->|"yes, and improving"| plan
  conv -->|"no, or it regressed"| out["before-aligned / after-aligned<br/>+ the marker docs beside them"]
`,
      },
    ],
    notes: `<ul>
      <li><strong>Markers are computed, never stored in the page.</strong> One
        collector expression runs in Playwright before a capture and in the
        side-by-side iframes through the overlay's eval channel, so both paths
        see the same identities. Build-time attributes would mean modifying
        every managed site's build; injected DOM markers would mutate the page
        under test.</li>
      <li><strong>Identity is content, not position.</strong> Tag plus a
        whitespace-normalized text prefix (the src for images), with an
        occurrence counter for duplicates — stable exactly where the content is
        unchanged, which is what an alignment needs.</li>
      <li><strong>Alignment is 2-D.</strong> Horizontal bands cannot express a
        row of cards where one grew; recursive rectangle partitioning splits
        that row into columns first, so each card expands on its own side.</li>
      <li><strong>Filler is real layout.</strong> The aligned pair is produced
        by injecting spacer elements and re-rendering, so text reflows and
        sticky elements behave — a canvas that slid pixels around would show a
        page that could never exist.</li>
      <li><strong>It converges or it stops.</strong> Correction repeats while
        the residual keeps improving, and a round that makes it materially worse
        ends the process on the previous result. Low structural confidence skips
        alignment altogether rather than inventing a correspondence: the
        unaligned panes are honest, a wrong alignment is not.</li>
      <li><strong>Every run reports itself.</strong> One
        <code>[align-metrics]</code> line per alignment, from both the live
        panes and the server screenshots: marker counts, match confidence,
        spacers injected, corrective rounds, residual drift before and after,
        and whether it aborted or regressed. The two paths run the same engine
        on the same pages, so a divergence between them is a bug in one
        environment — and no heuristic here should be changed on a hunch when
        the numbers are this cheap to collect.</li>
    </ul>`,
    source: [
      'src/lib/compare/markers.ts',
      'src/lib/compare/layout.ts',
      'src/lib/compare/converge.ts',
      'src/lib/compare/inject.ts',
      'src/lib/compare/telemetry.ts',
      'src/lib/diff/screenshot.ts',
      'src/components/workspace/diffScroll.ts',
      'src/components/workspace/onionAlign.ts',
      'src/components/workspace/highlightAlign.ts',
    ],
  },

  {
    id: 'overlay',
    title: 'Preview overlay protocol',
    intro: `The preview is a live iframe of the branch's own dev server, with a
      small bundle injected by the proxy. It reports what the user is looking at
      and what they select, which is how "chat about this" and element picking
      work without the CMS ever scraping the page.`,
    diagrams: [
      {
        code: `
sequenceDiagram
  autonumber
  participant W as Workspace
  participant F as Preview iframe
  participant API as /api/chat/context
  participant AG as Agent

  F->>W: cms:navigation — url and matched route
  W->>W: update the route chip and diff pane
  F->>W: cms:selection — the selected text and its anchor
  W->>W: offer "chat about this" as a context chip

  W->>F: cms:start-element-pick
  F->>F: highlight elements under the cursor
  alt the user picks one
    F->>W: cms:element — selector, text, geometry
  else the user presses escape
    F->>W: cms:pick-cancel
  end

  W->>API: post the chip as page context
  API->>AG: attached to the next message

  Note over W,F: the workspace only accepts messages whose source<br/>is the preview iframe's own window
`,
      },
    ],
    notes: `<ul>
      <li><strong>The origin check is a source check.</strong> Messages are
        matched against the iframe's <code>contentWindow</code>, not merely an
        origin string — preview hosts are user-created subdomains, so identity by
        window reference is the property that actually holds.</li>
      <li><strong>Element edits travel as context, not commands.</strong>
        Every chat message sent during edit mode carries the bounded annotation
        set. Questions leave it pending; only an explicit request to apply the
        edits makes the agent call <code>use_element_edits</code>, capture the
        before/requested/annotated shots, and close edit mode for that user.</li>
      <li><strong>Edit mode is the same bundle.</strong> The injected module carries
        the editing behavior and hint banner; workspace tools live in the edit
        rail flyout while the active tool, undo, undo-all and redo stay visible
        above the preview. There is no separate handoff button.</li>
      <li><strong>The compare view uses the same live frames.</strong> Before and
        after are two preview iframes with synchronized scrolling, plus a
        screenshot overlay with changed regions highlighted and an onion slider —
        screenshots are only for the highlight layer, not for the content.</li>
    </ul>`,
    source: [
      'src/components/workspace/preview.ts',
      'src/components/workspace/rail.ts',
      'src/components/chat/actions/chat/stateMachine.ts',
      'src/lib/agent/messageUtils.ts',
      'src/lib/agent/prompt.ts',
      'src/lib/agent/tools/chatTools.ts',
      'src/pages/api/chat/message.ts',
      'src/injected/protocol.ts',
      'src/injected/module',
      'src/lib/handoff/elementEdit.ts',
    ],
  },

  {
    id: 'locks',
    title: 'Locks and concurrency guards',
    intro: `Nothing in the system takes a global lock. Each guard is scoped to
      exactly the resource it protects, which is what lets several chats plan,
      execute and preview at the same time while a publish is merging.`,
    diagrams: [
      {
        code: `
flowchart TD
  subgraph inproc["In-process, on the global object"]
    turn["Turn lock — per chat<br/>one conversation turn at a time"]
    branch["Branch mutation lock — per work branch<br/>commit, revert, rebase"]
    targetl["Target branch lock<br/>held only for the publish merge"]
    installq["Install queue<br/>one npm install at a time"]
    pullflag["Starting-sync set<br/>survives a double click"]
  end

  subgraph durable["In the database"]
    ver["Chat.entityVersion<br/>conditional updates, 409 on a lost race"]
    idem["Approval.idempotencyKey<br/>unique — a retry is rejected,<br/>not replayed"]
    autos["Automatism status and step<br/>resume is exact"]
  end

  hmr["Development hot reload"] -.->|"would fork a module-level map"| inproc
`,
      },
    ],
    notes: `<p>What each one actually protects:</p>
    <table>
      <thead><tr><th>Guard</th><th>Scope</th><th>Blocks</th></tr></thead>
      <tbody>
        <tr><td>Turn lock</td><td>One chat</td><td>A second turn in the same chat. An automatism's repair turn waits for it (up to ten minutes — the agent that resumed the step is usually still finishing), folds a second failure into the invocation already waiting, and says so in the chat if it cannot start at all.</td></tr>
        <tr><td>Branch mutation lock</td><td>One work branch</td><td>Concurrent commits, reverts and rebases on that worktree.</td></tr>
        <tr><td>Target branch lock</td><td>One target branch</td><td>Two publishes merging into the same branch. Held for the merge only, not for the deploy.</td></tr>
        <tr><td>Install queue</td><td>The whole process</td><td>Parallel dependency installs, which only starve each other into the timeout.</td></tr>
        <tr><td>Entity version</td><td>One chat row</td><td>Two editors deciding at once. The loser is told the chat moved.</td></tr>
        <tr><td>Idempotency key</td><td>One approval</td><td>Duplicate audit rows from a retried request. It rejects the duplicate; it does not replay the first result, so a retry that arrives after the original succeeded gets an error rather than the publication it asked about.</td></tr>
      </tbody>
    </table>
    <p>All of the in-process guards hang off the global object rather than
      module scope, for the same reason the connection registry does: the
      development server reloads module graphs, and a split lock map is a lock
      that does not lock.</p>
    <p><strong>Background tickers invert that rule.</strong> The handle is
      global, but the callback belongs to the module evaluation that created
      it — and after a reload that evaluation's dynamic imports only throw
      <code>module runner has been closed</code>. So a ticker is keyed by name
      and the newest evaluation <em>replaces</em> the old one, and a ticker
      whose graph is already gone cancels itself on its next tick. Returning
      early because a timer already existed is what silently stopped preview
      warming and orphan cleanup after the first dev reload.</p>`,
    source: [
      'src/lib/agent/bus.ts',
      'src/lib/agent/workflow.ts',
      'src/lib/preview/manager.ts',
      'src/lib/ticker.ts',
    ],
  },
];
