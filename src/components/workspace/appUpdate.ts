/**
 * App-update watcher: polls /api/version and, when the deployed commit no
 * longer matches this tab's baked-in APP_COMMIT (a redeploy happened),
 * flushes the window session and reloads. The reload is silent — the window
 * keeps its sessionStorage id, so bootWindowSession restores exactly where it
 * was (see windowSession.ts). Only reloads when the app is idle (agent not
 * mid-turn) so a running conversation is never interrupted.
 */
import { APP_COMMIT } from '../chat/constants';
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
  // Nothing to compare against on a dev build without a baked commit.
  if (!APP_COMMIT) return;

  let updated = false; // latched once a newer build is seen

  const check = async (): Promise<void> => {
    const commit = updated ? APP_COMMIT : await serverCommit();
    if (commit && commit !== APP_COMMIT) updated = true;
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
