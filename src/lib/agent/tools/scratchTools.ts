/**
 * Scratchpad tools — a per-chat jailed folder (VAR_DIR/scratch/<chatId>)
 * where the agent can draft and prepare edits in EVERY phase (including
 * PLAN, where the repo is read-only). Contents persist across the chat's
 * phases but never touch the site until copied out via write_file in
 * EXECUTE. Exposed to the model through the in-process MCP bridge like all
 * other tools.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { env } from '@/lib/env';
import { registerTool, type ToolContext, type ToolDef } from './registry';

const MAX_FILE_CHARS = 50_000;

/** Absolute scratchpad root for this chat (created on demand). */
export function scratchRoot(chatId: string): string {
  const dir = path.join(path.resolve(env().VAR_DIR), 'scratch', chatId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve p inside the chat's scratchpad; throws on escape (incl. symlink). */
function jailScratch(ctx: ToolContext, p: string): string {
  const root = fs.realpathSync(scratchRoot(ctx.chatId));
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the scratchpad: ${p}`);
  }
  let probe = resolved;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the scratchpad via symlink: ${p}`);
  }
  return resolved;
}

function* walk(dir: string, root: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(path.join(dir, entry.name), root);
    else if (entry.isFile()) yield path.relative(root, path.join(dir, entry.name));
  }
}

const ALL_PHASES = ['plan', 'execute', 'preview', 'published'] as const;

const scratchWriteTool: ToolDef = {
  name: 'scratch_write',
  description:
    'Create or overwrite a file in your private scratchpad (usable in every phase, ' +
    'also PLAN). Use it to draft content or prepare edits before EXECUTE; scratch ' +
    'files never affect the site until you copy them into the repo with write_file.',
  schema: z.object({ path: z.string(), content: z.string() }),
  phases: [...ALL_PHASES],
  async execute(input, ctx) {
    const p = jailScratch(ctx, input.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, input.content);
    return JSON.stringify({ success: true, path: input.path });
  },
};

const scratchReadTool: ToolDef = {
  name: 'scratch_read',
  description: 'Read a file from your scratchpad.',
  schema: z.object({ path: z.string() }),
  phases: [...ALL_PHASES],
  async execute(input, ctx) {
    const p = jailScratch(ctx, input.path);
    const content = fs.readFileSync(p, 'utf8');
    return content.length > MAX_FILE_CHARS
      ? content.slice(0, MAX_FILE_CHARS) + `\n… (truncated, ${content.length} chars total)`
      : content;
  },
};

const scratchEditTool: ToolDef = {
  name: 'scratch_edit',
  description:
    'Replace an exact string in a scratchpad file. oldText must occur exactly once ' +
    'unless replaceAll is true.',
  schema: z.object({
    path: z.string(),
    oldText: z.string().min(1),
    newText: z.string(),
    replaceAll: z.boolean().default(false),
  }),
  phases: [...ALL_PHASES],
  async execute(input, ctx) {
    const p = jailScratch(ctx, input.path);
    const content = fs.readFileSync(p, 'utf8');
    const occurrences = content.split(input.oldText).length - 1;
    if (occurrences === 0) return JSON.stringify({ error: 'oldText not found in file' });
    if (occurrences > 1 && !input.replaceAll) {
      return JSON.stringify({
        error: `oldText occurs ${occurrences} times — provide more context or set replaceAll`,
      });
    }
    fs.writeFileSync(
      p,
      input.replaceAll
        ? content.split(input.oldText).join(input.newText)
        : content.replace(input.oldText, input.newText),
    );
    return JSON.stringify({ success: true, path: input.path });
  },
};

const scratchListTool: ToolDef = {
  name: 'scratch_list',
  description: 'List all files in your scratchpad (recursive).',
  schema: z.object({}),
  phases: [...ALL_PHASES],
  async execute(_input, ctx) {
    const root = jailScratch(ctx, '.');
    const files = [...walk(root, root)].sort();
    return files.join('\n') || '(scratchpad is empty)';
  },
};

const scratchDeleteTool: ToolDef = {
  name: 'scratch_delete',
  description: 'Delete a file from your scratchpad.',
  schema: z.object({ path: z.string() }),
  phases: [...ALL_PHASES],
  async execute(input, ctx) {
    const p = jailScratch(ctx, input.path);
    fs.rmSync(p);
    return JSON.stringify({ success: true, deleted: input.path });
  },
};

/** Removes a chat's scratchpad folder (chat deletion cleanup). */
export function removeScratchpad(chatId: string): void {
  const dir = path.join(path.resolve(env().VAR_DIR), 'scratch', chatId);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function registerScratchTools(): void {
  registerTool(scratchWriteTool);
  registerTool(scratchReadTool);
  registerTool(scratchEditTool);
  registerTool(scratchListTool);
  registerTool(scratchDeleteTool);
}
