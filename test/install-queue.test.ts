/**
 * Site dependency installs are serialized process-wide: warming a branch,
 * priming a spare and creating a chat all reach ensureDeps, and parallel npm
 * installs starve each other until one dies on its timeout.
 */
import { describe, expect, it } from 'vitest';
import { queueInstall } from '@/lib/preview/manager';

/** The queue hops several microtasks before the next run() starts. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('install queue', () => {
  it('runs one install at a time, in order', async () => {
    const first = deferred();
    const second = deferred();
    const running: string[] = [];

    const a = queueInstall(async () => {
      running.push('a:start');
      await first.promise;
      running.push('a:end');
      return 'a';
    });
    const b = queueInstall(async () => {
      running.push('b:start');
      await second.promise;
      return 'b';
    });

    try {
      // b must not have started while a is still installing.
      await tick();
      expect(running).toEqual(['a:start']);

      first.resolve();
      await a;
      await tick();
      expect(running).toEqual(['a:start', 'a:end', 'b:start']);
    } finally {
      // Never leave the shared queue blocked — the next test waits on it.
      first.resolve();
      second.resolve();
    }
    await expect(b).resolves.toBe('b');
  });

  it('keeps draining after a failed install', async () => {
    const failed = queueInstall(async () => {
      throw new Error('npm install failed (null)');
    });
    await expect(failed).rejects.toThrow('npm install failed');
    // The caller sees its own error; the queue itself stays usable.
    await expect(queueInstall(async () => 'next')).resolves.toBe('next');
  });
});
