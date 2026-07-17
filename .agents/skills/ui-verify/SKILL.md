---
name: ui-verify
description: Verify cms-agent UI changes in a real browser against the production build — local prod-parity server, playwright via node, SSE-safe navigation, computed-visibility checks, DB fixtures.
---

# UI verification (cms-agent)

Verify UI changes against the REAL production bundle, not `astro dev` — the
prod build differs (Astro standalone server, hashed assets, layered CSS).

## 1. Run the prod build locally

```bash
pnpm build
set -a && . ./.env && set +a && SKIP_AUTH=true HOST=127.0.0.1 PORT=5321 node server.mjs
```

- `SKIP_AUTH=true` signs you in as the seeded dev admin (`admin@localhost`) —
  dashboard and all admin APIs work without OAuth.
- ALWAYS restart the server after `pnpm build`: a running server keeps the old
  server bundle but serves new hashed client assets → 404s and stale HTML that
  look like real bugs.

## 2. Drive it with playwright (no test framework needed)

Playwright is already in `node_modules`. Write a scratch script — it MUST live
in the repo root so `import 'playwright'` resolves; name it `*.local.mjs`
(gitignored) and delete it after:

```js
import { chromium } from 'playwright';
const browser = await chromium.launch({
  // NixOS: playwright's bundled chromium is absent — use the system browser
  executablePath: '/run/current-system/sw/bin/google-chrome',
  headless: true,
});
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5321/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.chat-section', { timeout: 15000 });
// … assertions …
await browser.close();
```

Rules learned the hard way:

- **Never `waitUntil: 'networkidle'`** — the workspace holds an SSE
  connection (`/api/chat/events`) open forever; it times out. Use
  `domcontentloaded` + `waitForSelector` on a concrete element
  (`.chat-section`, `.ws-address__input`, `#tab-<name>`).
- **Check computed visibility, not class presence.** `.hidden` can be
  overridden by unlayered CSS; class checks lie:
  ```js
  await page.$$eval('.tab-panel', els =>
    els.filter(e => getComputedStyle(e).display !== 'none').map(e => e.id));
  ```
- Collect failures while navigating: `page.on('pageerror', …)`,
  `page.on('console', m => m.type() === 'error' && …)`, and
  `page.on('response', r => r.status() >= 400 && …)` — a silent 404 on a
  hashed chunk breaks the app with no visible error.
- Small elements: a center click can hit a nested control (e.g. the tab
  close ×) — click the inner label locator instead
  (`page.click('.ws-tab >> nth=0 >> .ws-tab__label')`).
- Switching chats: `[data-action="ws-branch-list-toggle"]` then
  `[data-chat-id="<id>"]`.

## 3. DB fixtures

State-dependent UI (stored errors, interrupted turns, roles) is easiest to
set up directly in the local DB, then reload the page:

```bash
psql "postgresql://maciej@localhost/cmsagent?host=/run/postgresql" \
  -c "UPDATE chat SET \"lastError\"='boom' WHERE id='<chatId>';"
```

Note: chats without messages auto-send a greeting on open (which starts a
turn and clears `lastError`) — fixture a chat that HAS messages.

## 4. Background servers

When driving this from an agent harness: run the server as a proper
background task (not `&`/`nohup` inside a one-shot shell — it dies with the
shell), and `pkill -f "node server.mjs"` before starting a new one.
