/**
 * The boot page's wait stream, driven by the manager instead of by a clock.
 *
 * It used to re-read the manager's maps every 500 ms, per waiting browser —
 * work proportional to how many people are staring at a spinner, to learn
 * something the manager already knew the moment it happened. Now the manager
 * says so. What this pins is that no edge is lost in the change: the state is
 * still the truth (an event is only a reason to re-read it), a start that
 * completes before anyone subscribes is still seen, and one branch's events
 * never resolve another branch's stream.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const managerState = vi.hoisted(() => ({
  ready: new Set<string>(),
  errors: new Map<string, { message: string; at: number }>(),
  phases: new Map<string, 'deps' | 'server'>(),
  listeners: new Set<(branch: string, next: string) => void>(),
}));

vi.mock('@/lib/preview/manager', () => ({
  listInstances: () =>
    [...managerState.ready].map((branch) => ({ branch, status: 'ready' as const })),
  getStartError: (branch: string) => managerState.errors.get(branch) ?? null,
  getStartPhase: (branch: string) => managerState.phases.get(branch) ?? null,
  subscribeBranchState: (listener: (branch: string, next: string) => void) => {
    managerState.listeners.add(listener);
    return () => managerState.listeners.delete(listener);
  },
}));

import { handlePreviewWait, WAIT_PATH_RE } from '@/lib/preview/waitStream';

/** What the manager does when a start moves. */
const move = (branch: string, next: string): void => {
  if (next === 'ready') managerState.ready.add(branch);
  if (next === 'deps' || next === 'server') managerState.phases.set(branch, next);
  if (next === 'failed') managerState.errors.set(branch, { message: 'boom', at: Date.now() });
  if (next === 'gone') managerState.ready.delete(branch);
  for (const listener of [...managerState.listeners]) listener(branch, next);
};

/** Reads the stream until it closes, returning the raw SSE text. */
const collect = async (res: Response, ms = 1000): Promise<string> => {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  for (;;) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
      ),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
};

const open = (branch: string) => handlePreviewWait(branch, new Request('http://x/'));

beforeEach(() => {
  managerState.ready.clear();
  managerState.errors.clear();
  managerState.phases.clear();
  managerState.listeners.clear();
});

describe('the preview wait stream', () => {
  it('matches only DNS-safe branch labels', () => {
    expect(WAIT_PATH_RE.exec('/__preview/wait/c-abc123')?.[1]).toBe('c-abc123');
    expect(WAIT_PATH_RE.test('/__preview/wait/../etc')).toBe(false);
  });

  it('reports each phase and closes on ready', async () => {
    const res = open('c-wait1');
    const text = collect(res);
    // Nothing polls: these arrive because the manager said so.
    move('c-wait1', 'deps');
    move('c-wait1', 'server');
    move('c-wait1', 'ready');
    expect(await text).toContain('event: phase\ndata: deps');
    expect(await text).toContain('event: phase\ndata: server');
    expect(await text).toContain('event: ready');
  });

  it('closes on a recorded start failure', async () => {
    const res = open('c-wait2');
    const text = collect(res);
    move('c-wait2', 'failed');
    expect(await text).toContain('event: failed');
  });

  it('sees a preview that was already up before anyone subscribed', async () => {
    // The race the subscribe-then-read order exists for.
    managerState.ready.add('c-wait3');
    expect(await collect(open('c-wait3'))).toContain('event: ready');
  });

  it('does not resolve one branch on another branch’s events', async () => {
    const res = open('c-wait4');
    const text = collect(res, 300);
    move('c-other', 'ready');
    move('c-other', 'failed');
    const out = await text;
    expect(out).not.toContain('event: ready');
    expect(out).not.toContain('event: failed');
  });

  it('serves many waiters of the same branch from one notification', async () => {
    const streams = [open('c-wait5'), open('c-wait5'), open('c-wait5')].map((r) => collect(r));
    expect(managerState.listeners.size).toBe(3); // one subscription each, no timers
    move('c-wait5', 'ready');
    for (const text of streams) expect(await text).toContain('event: ready');
  });
});
