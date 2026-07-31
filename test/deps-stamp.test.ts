/**
 * What "the dependencies are already installed" means.
 *
 * The stamp used to hash package.json alone, which misses the case the
 * lockfile exists for: `npm install` writes a lock, a teammate commits a
 * different one, or a resolution changes underneath an unchanged manifest —
 * all of which change what node_modules should contain. And the installer that
 * runs has to be the one whose lockfile is in the repo: running npm in a pnpm
 * checkout installs versions the site was never tested with.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { depsFingerprint, packageManagerFor } from '@/lib/preview/manager';

let worktree = '';

const write = (name: string, content: string) =>
  fs.writeFileSync(path.join(worktree, name), content);

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-deps-'));
  write('package.json', JSON.stringify({ name: 'site', dependencies: { astro: '^5' } }));
});

describe('package manager detection', () => {
  it('follows the lockfile that is actually in the checkout', () => {
    expect(packageManagerFor(worktree)).toMatchObject({ lockfile: null });
    expect(packageManagerFor(worktree).install).toContain('npm install');

    write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    expect(packageManagerFor(worktree)).toMatchObject({
      lockfile: 'pnpm-lock.yaml',
    });
    expect(packageManagerFor(worktree).install).toContain('pnpm install');
  });

  it('installs dev dependencies, whichever manager it is', () => {
    // The dev server itself usually lives in devDependencies.
    for (const [lock, marker] of [
      ['pnpm-lock.yaml', '--prod=false'],
      ['yarn.lock', '--production=false'],
      ['package-lock.json', '--include=dev'],
    ] as const) {
      fs.rmSync(path.join(worktree, 'pnpm-lock.yaml'), { force: true });
      fs.rmSync(path.join(worktree, 'yarn.lock'), { force: true });
      write(lock, 'x');
      expect(packageManagerFor(worktree).install).toContain(marker);
      fs.rmSync(path.join(worktree, lock), { force: true });
    }
  });
});

describe('the deps fingerprint', () => {
  it('changes when the lockfile changes and the manifest does not', () => {
    write('package-lock.json', '{"lockfileVersion":3,"packages":{}}');
    const before = depsFingerprint(worktree, 'package-lock.json');

    write('package-lock.json', '{"lockfileVersion":3,"packages":{"astro":"5.1.0"}}');
    expect(depsFingerprint(worktree, 'package-lock.json')).not.toBe(before);
  });

  it('changes when the manifest changes', () => {
    write('package-lock.json', '{}');
    const before = depsFingerprint(worktree, 'package-lock.json');
    write('package.json', JSON.stringify({ name: 'site', dependencies: { astro: '^6' } }));
    expect(depsFingerprint(worktree, 'package-lock.json')).not.toBe(before);
  });

  it('is stable when nothing changed, or the install would run every boot', () => {
    write('package-lock.json', '{}');
    expect(depsFingerprint(worktree, 'package-lock.json')).toBe(
      depsFingerprint(worktree, 'package-lock.json'),
    );
  });

  it('treats a lockfile that vanished as its own state', () => {
    write('package-lock.json', '{}');
    const withLock = depsFingerprint(worktree, 'package-lock.json');
    fs.rmSync(path.join(worktree, 'package-lock.json'));
    expect(depsFingerprint(worktree, 'package-lock.json')).not.toBe(withLock);
  });
});
