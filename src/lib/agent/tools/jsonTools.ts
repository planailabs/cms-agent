/**
 * json_query — real jq (jq-wasm, jq 1.8.2 compiled to WebAssembly) over JSON
 * files in the worktree (incl. .scratch/) or inline JSON content.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { jail } from './fsTools';
import { registerTool, type ToolDef } from './registry';
import { ALL_PHASES } from '../types';

const MAX_OUTPUT_CHARS = 50_000;

const jsonQueryTool: ToolDef = {
  name: 'json_query',
  description:
    'Run a jq program against JSON. Prefer path (a JSON file in the repo or .scratch/, e.g. web_search output) over content — pass files instead of pasting large JSON. Returns the jq output, truncated at 50k characters.',
  // No .refine here: ZodEffects serializes to an empty MCP parameter schema.
  schema: z.object({
    path: z.string().optional().describe('JSON file to query, e.g. .scratch/search.json (preferred)'),
    content: z.string().optional().describe('Inline JSON — only for small values already at hand'),
    query: z.string().describe('jq program, e.g. ".web[] | {title, url}"'),
  }),
  phases: ALL_PHASES,
  async execute(input, ctx) {
    if (Boolean(input.path) === Boolean(input.content)) {
      return JSON.stringify({ error: 'Provide exactly one of path or content' });
    }
    const raw = input.path ? fs.readFileSync(jail(ctx, input.path), 'utf8') : input.content!;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return JSON.stringify({
        error: `Not valid JSON: ${e instanceof Error ? e.message : e}`,
      });
    }
    // Lazy: wasm loads on first use, mirroring the playwright import pattern.
    const jq = await import('jq-wasm');
    const { stdout, stderr, exitCode } = await jq.raw(
      data as import('jq-wasm').JqInput,
      input.query,
    );
    if (exitCode !== 0) {
      return JSON.stringify({ error: `jq failed (exit ${exitCode}): ${stderr}` });
    }
    return stdout.length > MAX_OUTPUT_CHARS
      ? stdout.slice(0, MAX_OUTPUT_CHARS) + `\n… (truncated, ${stdout.length} chars total)`
      : stdout || '(empty output)';
  },
};

export function registerJsonTools(): void {
  registerTool(jsonQueryTool);
}
