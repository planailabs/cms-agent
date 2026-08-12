/**
 * otel-hook.mjs — the ESM instrumentation hook, and the one package it must
 * not touch.
 *
 * openai@4 keeps its shim registry in `export let` bindings and reads them
 * back through `import * as shims`. import-in-the-middle's namespace proxy
 * does not carry live bindings, so the read says "nothing registered" after
 * the write registered it, and the second registration throws at import time
 * — taking the server down at boot, which is how this was found.
 *
 * Both directions are pinned on purpose. The first test is the fix; the
 * second is the reason it exists, and it is the one that will fail the day
 * this repo moves to openai v5+ (which deleted _shims), telling us the
 * exclusion can go rather than leaving it to be copied forward forever.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIM = path.join(ROOT, 'otel-hook.mjs');
const REGISTER = path.join(
  ROOT,
  'node_modules/@opentelemetry/auto-instrumentations-node/build/src/register.js',
);

/** Import openai in a fresh node, under whatever hook `imports` registers. */
const importOpenAI = (imports: string[]): { ok: boolean; output: string } => {
  const args = ['--disable-warning=DEP0205'];
  for (const spec of imports) args.push('--import', spec);
  // A file rather than -e: the cwd decides how a bare specifier resolves, and
  // the repo root is where openai lives.
  args.push('-e', "import('openai').then(() => console.log('IMPORTED'))");
  try {
    return {
      ok: true,
      output: execFileSync(process.execPath, args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // The SDK would otherwise export to localhost:4318 and log every
        // failure into the output this test reads.
        env: { ...process.env, OTEL_SDK_DISABLED: 'true', NODE_OPTIONS: '' },
      }),
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

describe('otel-hook.mjs', () => {
  it('leaves openai importable — the shim excludes it', () => {
    const result = importOpenAI([SHIM, REGISTER]);
    expect(result.output).not.toContain('openai/shims');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('IMPORTED');
  });

  /**
   * Also the vacuity guard for the test above: without it, a shim that
   * silently registered nothing at all would import openai just fine and look
   * fixed. This registers the hook the same way the shim's one line does,
   * minus the exclusion, and openai has to fall over.
   */
  it('fails without the exclusion — the incompatibility is real', () => {
    const bare =
      'data:text/javascript,' +
      encodeURIComponent(
        `import { register } from 'node:module';` +
          `register('@opentelemetry/instrumentation/hook.mjs', ${JSON.stringify(
            `file://${ROOT}/`,
          )});`,
      );
    const result = importOpenAI([bare]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("import 'openai/shims/node'");
  });
});
