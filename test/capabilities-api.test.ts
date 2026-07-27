/**
 * GET /api/agent/capabilities — per-chat skills/MCP status for the overview
 * modal. Plugins come from a fixture root; the worktree is a temp dir with a
 * branch-local skill; MCPs report their not-attached reasons (no sandbox in
 * the test env, no Context7 key).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const wt = vi.hoisted(() => ({ path: '' }));
vi.mock('@/lib/git/engine', () => ({ ensureWorktree: vi.fn(async () => wt.path) }));

import { prisma } from '@/lib/db';
import { resetPluginCache } from '@/lib/agent/plugins';
import { GET } from '@/pages/api/agent/capabilities';

const ACTOR = { id: 'caps-api-user', name: 'Caps Tester' };

const get = (chatId: string) =>
  GET({ url: new URL(`http://localhost/api/agent/capabilities?chat=${chatId}`), locals: { user: { id: 'u-test-admin', role: 'admin' } }, } as never);

let chatId: string;

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-caps-test-'));
  const write = (rel: string, content: string) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write(
    '.agents/plugins/marketplace.json',
    JSON.stringify({
      name: 'caps-marketplace',
      plugins: [{ name: 'demo', source: { source: 'local', path: './plugins/demo' } }],
    }),
  );
  write(
    'plugins/demo/.codex-plugin/plugin.json',
    JSON.stringify({ name: 'demo', version: '1.0.0', skills: './skills/' }),
  );
  write(
    'plugins/demo/skills/hello/SKILL.md',
    '---\nname: hello\ndescription: Installed greeting.\n---\n\nHi.\n',
  );
  write('plugins/demo/AGENTS.md', 'Be excellent.\n');
  process.env.CMS_PLUGINS_ROOT = root;
  resetPluginCache();

  wt.path = path.join(root, 'worktree');
  write(
    'worktree/.agents/skills/hello/SKILL.md',
    '---\nname: hello\ndescription: Branch greeting.\n---\n\nBranch hi.\n',
  );

  delete process.env.CONTEXT7_API_KEY;
  delete process.env.SANDBOX_DIR;

  await prisma.user.deleteMany({ where: { id: ACTOR.id } });
  const u = await prisma.user.create({
    data: { id: ACTOR.id, name: ACTOR.name, email: 'caps-api@example.com' },
  });
  const branch = await prisma.branch.upsert({
    where: { name: 'main' },
    update: {},
    create: { name: 'main', createdById: u.id },
  });
  await prisma.chat.deleteMany({ where: { workBranch: 'c-capsapi1' } });
  const chat = await prisma.chat.create({
    data: { branchId: branch.id, workBranch: 'c-capsapi1', createdById: u.id, title: 'Caps' },
  });
  chatId = chat.id;
});

describe('capabilities API', () => {
  it('404s unknown chats', async () => {
    expect((await get('no-such-chat')).status).toBe(404);
  });

  it('reports skills (branch shadows installed) and MCP reasons', async () => {
    const res = await get(chatId);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      skills: Array<{ name: string; source: string; shadowed: boolean }>;
      rules: Array<{ plugin: string }>;
      mcps: Array<{ name: string; attached: boolean; reason?: string }>;
    };

    const branchHello = data.skills.find((s) => s.source === 'branch');
    const installedHello = data.skills.find((s) => s.source === 'plugin' && s.name === 'hello');
    expect(branchHello?.name).toBe('hello');
    expect(branchHello?.shadowed).toBe(false);
    expect(installedHello?.shadowed).toBe(true);
    expect(data.rules).toEqual([{ plugin: 'demo' }]);

    const byName = Object.fromEntries(data.mcps.map((m) => [m.name, m]));
    expect(byName['codebase-memory']).toMatchObject({ attached: false, reason: 'unavailable' });
    expect(byName['context7']).toMatchObject({ attached: false, reason: 'no-key' });
  });
});
