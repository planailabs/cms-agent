/**
 * Lint tools — run the TARGET SITE's own linters inside the branch worktree
 * and feed results back to the agent; lint_fix applies autofixes (EXECUTE
 * only). Linters are CLI-only tools of the managed repo, so we spawn them
 * via `npx --no-install` (never downloading on the fly); a site without a
 * given linter gets a clear "not installed" answer instead of a crash.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { registerTool, type ToolContext, type ToolDef } from './registry';

const OUTPUT_CAP = 30_000;

interface RunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

function run(cwd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['--no-install', ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const collect = (d: Buffer) => {
      if (output.length < OUTPUT_CAP) output += d.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: String(err), timedOut });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output: output.slice(0, OUTPUT_CAP), timedOut });
    });
  });
}

export interface DetectedLinters {
  eslint: boolean;
  prettier: boolean;
  astroCheck: boolean;
  lintScript: string | null;
}

/** Detect what the target site actually uses (deps + config files). */
export function detectLinters(repoRoot: string): DetectedLinters {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  } catch {
    // no package.json — nothing to detect
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasConfig = (...names: string[]) => names.some((n) => fs.existsSync(path.join(repoRoot, n)));

  return {
    eslint:
      !!deps.eslint ||
      hasConfig('eslint.config.js', 'eslint.config.mjs', '.eslintrc.json', '.eslintrc.cjs', '.eslintrc.js'),
    prettier: !!deps.prettier || hasConfig('.prettierrc', '.prettierrc.json', 'prettier.config.js', 'prettier.config.mjs'),
    astroCheck: !!deps['@astrojs/check'],
    lintScript: pkg.scripts?.lint ?? null,
  };
}

const lintTool: ToolDef = {
  name: 'lint',
  description:
    "Run the site's own linters (eslint / prettier --check / astro check, whatever the repo has) and return the diagnostics. Use before finishing an execution.",
  schema: z.object({
    tool: z
      .enum(['auto', 'eslint', 'prettier', 'astro-check'])
      .default('auto')
      .describe('Which linter; auto runs everything the site has configured.'),
    paths: z.array(z.string()).optional().describe('Limit to specific files (default: whole repo).'),
  }),
  phases: ['plan', 'execute', 'preview', 'published'],
  async execute(input, ctx) {
    const detected = detectLinters(ctx.worktreePath);
    const wanted = input.tool;
    const sections: string[] = [];
    const targets = input.paths?.length ? input.paths : ['.'];

    const none =
      (wanted === 'auto' && !detected.eslint && !detected.prettier && !detected.astroCheck) ||
      (wanted === 'eslint' && !detected.eslint) ||
      (wanted === 'prettier' && !detected.prettier) ||
      (wanted === 'astro-check' && !detected.astroCheck);
    if (none) {
      return JSON.stringify({
        detected,
        note: 'The site has no matching linter installed — nothing to run.',
      });
    }

    if (detected.eslint && (wanted === 'auto' || wanted === 'eslint')) {
      const r = await run(ctx.worktreePath, ['eslint', '--no-color', ...targets], 90_000);
      sections.push(
        `## eslint (exit ${r.exitCode}${r.timedOut ? ', TIMED OUT' : ''})\n${r.output.trim() || 'clean'}`,
      );
    }
    if (detected.prettier && (wanted === 'auto' || wanted === 'prettier')) {
      const r = await run(ctx.worktreePath, ['prettier', '--check', ...targets], 90_000);
      sections.push(
        `## prettier --check (exit ${r.exitCode}${r.timedOut ? ', TIMED OUT' : ''})\n${r.output.trim() || 'clean'}`,
      );
    }
    if (detected.astroCheck && (wanted === 'auto' || wanted === 'astro-check')) {
      const r = await run(ctx.worktreePath, ['astro', 'check'], 180_000);
      sections.push(
        `## astro check (exit ${r.exitCode}${r.timedOut ? ', TIMED OUT' : ''})\n${r.output.trim() || 'clean'}`,
      );
    }
    return sections.join('\n\n');
  },
};

const lintFixTool: ToolDef = {
  name: 'lint_fix',
  description:
    "Apply the site's own autofixes (eslint --fix, prettier --write) to the given paths (or everything changed). Only fixes mechanically; re-run lint afterwards.",
  schema: z.object({
    paths: z.array(z.string()).optional().describe('Files to fix (default: files modified in this chat).'),
  }),
  phases: ['execute'],
  async execute(input, ctx) {
    const detected = detectLinters(ctx.worktreePath);
    const targets = input.paths?.length
      ? input.paths
      : ctx.modifiedPaths.size > 0
        ? [...ctx.modifiedPaths]
        : ['.'];
    const sections: string[] = [];

    if (!detected.eslint && !detected.prettier) {
      return JSON.stringify({ detected, note: 'No autofixing linter installed in the site.' });
    }
    if (detected.eslint) {
      const r = await run(ctx.worktreePath, ['eslint', '--no-color', '--fix', ...targets], 120_000);
      sections.push(`## eslint --fix (exit ${r.exitCode})\n${r.output.trim() || 'done'}`);
    }
    if (detected.prettier) {
      const r = await run(ctx.worktreePath, ['prettier', '--write', ...targets], 120_000);
      sections.push(`## prettier --write (exit ${r.exitCode})\n${r.output.trim() || 'done'}`);
    }
    for (const t of targets) if (t !== '.') ctx.modifiedPaths.add(t);
    return sections.join('\n\n');
  },
};

export function registerLintTools(): void {
  registerTool(lintTool);
  registerTool(lintFixTool);
}
