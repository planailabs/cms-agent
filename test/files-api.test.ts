/**
 * Code-browser files API: worktree listing/reading, jail enforcement
 * (relative + absolute escapes), skip dirs, and binary detection.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { prisma } from '@/lib/db';
import { GET } from '@/pages/api/files/[chatId]';

let chatId: string;

const get = async (p: string) => {
  const res = await GET({
    params: { chatId },
    url: new URL(`http://localhost/api/files/${chatId}?path=${encodeURIComponent(p)}`),
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-files-'));
  const repo = path.join(tmp, 'site');
  fs.mkdirSync(path.join(repo, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'index.md'), '# Home\nline two\nline three\n');
  fs.writeFileSync(path.join(repo, 'demo.ts'), 'const x = 1;\nexport default x;\n');
  fs.writeFileSync(path.join(repo, 'src', 'pages', 'about.md'), '# About\n');
  fs.writeFileSync(path.join(repo, 'node_modules', 'x.js'), 'skip me');
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  const git = simpleGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.name', 'T');
  await git.addConfig('user.email', 't@t');
  await git.add(['-A']);
  await git.commit('init');

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = path.join(tmp, 'var');
  const { resetEnvCache } = await import('@/lib/env');
  resetEnvCache();

  await prisma.chat.deleteMany({ where: { workBranch: 'c-filesapi1' } });
  const branch = await prisma.branch.upsert({
    where: { name: 'files-api-target' },
    create: { name: 'files-api-target' },
    update: {},
  });
  // the work branch is created from main on first ensureWorktree
  const chat = await prisma.chat.create({
    data: { branchId: branch.id, workBranch: 'c-filesapi1', title: 'Files test' },
  });
  chatId = chat.id;
  // target branch must exist in git for ensureWorktree(work, target)
  await git.raw(['branch', 'files-api-target']);
});

describe('files API', () => {
  it('lists the worktree root, skipping build/VCS dirs', async () => {
    const { status, body } = await get('.');
    expect(status).toBe(200);
    const names = (body.entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain('index.md');
    expect(names).toContain('src');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
  }, 60_000);

  it('lists subdirectories and reads files', async () => {
    const dir = await get('src/pages');
    expect((dir.body.entries as Array<{ name: string }>)[0].name).toBe('about.md');
    const file = await get('index.md');
    expect(file.status).toBe(200);
    expect(file.body.content).toContain('line two');
    expect(file.body.truncated).toBe(false);
  });

  it('highlights known languages per line, none for unknown', async () => {
    const { body } = await get('demo.ts');
    expect(body.content).toContain('const x');
    const hl = body.highlighted as string[] | null;
    expect(Array.isArray(hl)).toBe(true);
    expect(hl!.length).toBeGreaterThanOrEqual(2);
    expect(hl![0]).toContain('<span style="color:');
    expect(hl![0]).toContain('const');

    const md = await get('index.md');
    expect(Array.isArray(md.body.highlighted)).toBe(true);
  }, 60_000);

  it('flags binary files instead of returning bytes', async () => {
    const { body } = await get('blob.bin');
    expect(body.binary).toBe(true);
    expect(body.content).toBeUndefined();
  });

  it('rejects escapes (relative and absolute)', async () => {
    expect((await get('../outside')).status).toBe(400);
    expect((await get('/etc/passwd')).status).toBe(400);
  });

  it('404s missing paths and unknown chats', async () => {
    expect((await get('nope.md')).status).toBe(404);
    const res = await GET({
      params: { chatId: 'does-not-exist' },
      url: new URL('http://localhost/api/files/x?path=.'),
    } as never);
    expect(res.status).toBe(404);
  });
});
