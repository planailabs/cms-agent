/**
 * Server startup, in its two halves.
 *
 * They are not the same kind of thing and used to be mixed: built-in
 * registration happened as a side effect of importing whichever module the
 * request path reached first, while the process-owned services sat in an `if`
 * at the top of the auth middleware.
 *
 * - `registerServerBuiltins()` is PURE and repeat-safe. Every register*() sets
 *   an entry in a Map, so calling it again after a Vite HMR reload overwrites
 *   with the fresh definitions instead of duplicating them. Anything may call
 *   it, and everything that needs the registry populated should.
 * - `startRuntimeServices()` is owned by the PROCESS: it publishes the routing
 *   table, starts the embedded proxy, recovers automatisms the previous
 *   process left running, and starts the named workers. Once, per boot.
 *
 * Production keeps its own pre-SSR proxy start in server.mjs (the middleware
 * is only reached THROUGH that proxy, so it cannot be what starts it); this
 * module is what runs once the SSR entry is up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerClientTools } from './agent/tools/clientTools';
import { registerFsTools } from './agent/tools/fsTools';
import { registerUploadTools } from './agent/tools/uploadTools';
import { registerMemoryTools } from './agent/tools/memoryTools';
import { registerContentTools } from './content/tools';
import { registerLintTools } from './agent/tools/lintTools';
import { registerStructureTools } from './agent/tools/structureTools';
import { registerDeployTools } from './agent/tools/deployTools';
import { registerChatTools } from './agent/tools/chatTools';
import { registerTaskTools } from './agent/tools/taskTools';
import { registerJsonTools } from './agent/tools/jsonTools';
import { registerScreenshotTools } from './agent/tools/screenshotTools';
import { registerCommitTools } from './agent/tools/commitTools';
import { registerCommandTools } from './agent/tools/commandTools';
import { registerAutomatismTools } from './agent/tools/automatismTools';
import { registerConflictTools } from './agent/tools/conflictTools';
import { registerSkillTools } from './agent/tools/skillTools';
import { registerCapabilityTools } from './agent/tools/capabilityTools';
import { registerPreviewTools } from './agent/tools/previewTools';
import { registerSkillScriptTools } from './agent/tools/skillScriptTools';
import { registerImageTools } from './agent/tools/imageTools';
import { registerFirecrawlTools } from './agent/tools/firecrawlTools';
import { currentRoutesJson, initRoutesFile } from './preview/manager';
import { startEmbeddedProxy } from './proxyNative';
import { startMetricsServer } from './metrics';

/**
 * Every built-in the agent can be handed. Idempotent: registries are keyed
 * Maps, so a second call replaces rather than duplicates.
 *
 * Deploy flows and their automatism types are NOT here. Registering them
 * means importing the publisher, and the publisher reaches the chat handler
 * through workflow.ts — importing it from a module the handler itself imports
 * would close a cycle, which in a production bundle is a boot crash rather
 * than a test failure. `startRuntimeServices()` imports it directly instead,
 * where nothing imports back.
 */
export function registerServerBuiltins(): void {
  registerClientTools();
  registerFsTools();
  registerUploadTools();
  registerMemoryTools();
  registerContentTools();
  registerLintTools();
  registerStructureTools();
  registerDeployTools();
  registerChatTools();
  registerTaskTools();
  registerJsonTools();
  registerScreenshotTools();
  registerCommitTools();
  registerCommandTools();
  registerAutomatismTools();
  registerConflictTools();
  registerSkillTools();
  registerCapabilityTools();
  registerPreviewTools();
  registerSkillScriptTools();
  registerImageTools();
  registerFirecrawlTools();
}

/** Workers and one-shot recovery belong to the process, not to a module
 *  graph: HMR must not start a second copy of any of them. */
const g = globalThis as typeof globalThis & { __cmsRuntimeStarted?: boolean };

/**
 * Publish routes, start the proxy, pick up what the previous process left
 * behind, and start the background workers. Safe to call more than once —
 * the second call is a no-op, which is what keeps an HMR reload from running
 * boot recovery again.
 */
export function startRuntimeServices(): void {
  if (g.__cmsRuntimeStarted) return;
  g.__cmsRuntimeStarted = true;

  // The OTel hook/register flags are ours alone. Node has already consumed
  // NODE_OPTIONS by now, so dropping it changes nothing here — but it is
  // inherited by every child we spawn with `...process.env` (publish scripts,
  // wrangler, site builds), and those resolve the bare specifiers against
  // THEIR cwd, where @opentelemetry isn't installed: ERR_MODULE_NOT_FOUND
  // before the script's first line.
  delete process.env.NODE_OPTIONS;

  registerServerBuiltins();
  initRoutesFile();
  // Legacy scratchpad storage (pre-.scratch/-in-worktree) — drop it once.
  fs.rmSync(path.join(path.resolve(process.env.VAR_DIR!), 'scratch'), {
    recursive: true,
    force: true,
  });
  // The metrics listener takes an ephemeral port, so the proxy learns where
  // it is from the routes table — republished once it is actually listening.
  startMetricsServer(initRoutesFile);
  startEmbeddedProxy(currentRoutesJson());

  // Deploy flows and their automatism types, before anything recovers a
  // persisted deploy row: an unregistered type cannot be advanced.
  void import('./publish/publisher')
    .then(() => import('./automatism'))
    .then(({ recoverAutomatisms }) => recoverAutomatisms())
    .catch((err) => console.error('[automatism] boot recovery failed:', err));

  // Branches chats fork from stay warm — their previews are what a draft
  // chat shows, and nobody should wait for a dev server to boot to see one.
  void import('./preview/prewarm')
    .then(({ startPrimaryBranchWarmer }) => startPrimaryBranchWarmer())
    .catch((err) => console.error('[prewarm] warmer failed to start:', err));

  // Worktrees and sandbox homes of chats that no longer exist are pure disk
  // cost (a checkout plus a private npm cache each) — reconcile hourly.
  void import('./worktreeCleanup')
    .then(({ startOrphanSweeper }) => startOrphanSweeper())
    .catch((err) => console.error('[cleanup] sweeper failed to start:', err));
}
