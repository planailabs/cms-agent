/**
 * No static import cycle may cross the chat ↔ workspace boundary.
 *
 * Workspace actions reach into the chat actions by design (a workspace button
 * starts a turn), so the chat side must reach back through a DYNAMIC import —
 * which is why session.ts loads tabsSync with `void import(...)`. A static
 * edge in that direction closes a cycle across the two halves of the client,
 * and the production bundle then dies at boot on whichever binding the cycle
 * evaluates first: a blank page, with every unit test still green. That
 * shipped once, from a one-line import in the SSE dispatcher.
 *
 * Static and cheap on purpose. Bundling cannot prove it: esbuild resolves the
 * same cycle happily, so test/client-boot.test.ts boots a bundle that the
 * production build would not. Cycles WITHIN one half are left alone — several
 * exist and ship fine; the boundary is what breaks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve('src');
const ENTRY = path.resolve('src/components/chat/main.ts');
const CHAT = path.resolve('src/components/chat');
const WORKSPACE = path.resolve('src/components/workspace');

/** Value imports only: `import type` is erased, `import(...)` is the escape. */
const staticImports = (file: string): string[] => {
  const code = fs.readFileSync(file, 'utf8').replace(/\bimport\s*\(/g, 'DYNAMIC(');
  return [...code.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1],
  );
};

const resolveSpec = (fromFile: string, spec: string): string | null => {
  const base = spec.startsWith('@/')
    ? path.resolve('src', spec.slice(2))
    : spec.startsWith('.')
      ? path.resolve(path.dirname(fromFile), spec)
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null; // a package, or an asset — not our graph
};

/** Every static import cycle reachable from the client entry. */
function findCycles(entry: string): string[][] {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (file: string): void => {
    if (state.get(file) === 'done') return;
    const start = stack.indexOf(file);
    if (start >= 0) {
      cycles.push([...stack.slice(start), file]);
      return;
    }
    stack.push(file);
    state.set(file, 'open');
    for (const spec of staticImports(file)) {
      const target = resolveSpec(file, spec);
      if (target) visit(target);
    }
    stack.pop();
    state.set(file, 'done');
  };

  visit(entry);
  return cycles;
}

const under = (file: string, dir: string): boolean => file.startsWith(dir + path.sep);

describe('client import graph', () => {
  it('has no cycle spanning the chat and workspace halves', () => {
    const crossing = findCycles(ENTRY).filter(
      (cycle) => cycle.some((f) => under(f, CHAT)) && cycle.some((f) => under(f, WORKSPACE)),
    );
    expect(
      crossing.map((c) => c.map((f) => path.relative(SRC, f)).join(' → ')),
      'a chat module reaches the workspace statically — use `void import(...)` instead',
    ).toEqual([]);
  });

  it('sees the graph it claims to check', () => {
    // A resolver that silently resolved nothing would make the rule vacuous.
    const edges = staticImports(ENTRY)
      .map((spec) => resolveSpec(ENTRY, spec))
      .filter(Boolean);
    expect(edges.length).toBeGreaterThan(0);
  });
});
