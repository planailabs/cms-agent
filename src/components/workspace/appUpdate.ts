/**
 * App-update watcher: polls /api/version and, when the deployed commit no
 * longer matches the commit this tab was served with (a redeploy happened),
 * flushes the window session and reloads. The reload is silent — the window
 * keeps its sessionStorage id, so bootWindowSession restores exactly where it
 * was (see windowSession.ts). Only reloads when the app is idle (agent not
 * mid-turn) so a running conversation is never interrupted.
 *
 * The tab's own commit comes from the authed SSR page (#app dataset), not a
 * bundle constant — the exact build must never leak to anonymous callers.
 */
import { getAppBuild } from '../chat/constants';
import { store } from '../chat/app/store';
import { flushWindowSessionSave } from './windowSession';

const POLL_MS = 60_000;

const serverCommit = async (): Promise<string | null> => {
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { commit?: string };
    return typeof data.commit === 'string' ? data.commit : null;
  } catch {
    return null;
  }
};

const agentBusy = (): boolean => {
  const phase = store.state.chat?.aiChat?.phase;
  return phase === 'waiting' || phase === 'streaming' || phase === 'tool';
};

let started = false;

export const startUpdateWatcher = (): void => {
  if (started) return;
  started = true;
  // The commit this tab was served with (from the authed #app dataset).
  // Nothing to compare against on a dev build without a commit.
  const ownCommit = getAppBuild().commit;
  if (!ownCommit) return;

  let updated = false; // latched once a newer build is seen

  const check = async (): Promise<void> => {
    const commit = updated ? ownCommit : await serverCommit();
    if (commit && commit !== ownCommit) updated = true;
    // Reload only when idle: a mid-turn reload would drop the live stream.
    if (updated && !agentBusy()) {
      flushWindowSessionSave();
      location.reload();
    }
  };

  setInterval(() => void check(), POLL_MS);
  // Also re-check when the tab regains focus (returning after a deploy) and
  // when the agent goes idle after a latched update.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  store.subscribe(() => {
    if (updated && !agentBusy()) void check();
  });
};
