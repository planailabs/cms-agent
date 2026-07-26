/**
 * API surface probes — no model turns. Sequential: later probes reuse ids
 * created by earlier ones (branch → chat → files/tabs/uploads).
 */
import { describe, expect, it } from 'vitest';
import { BenchClient } from '../lib/client';
import { recordAssert } from '../lib/judge';

const SCENARIO = '01-api';
const client = new BenchClient();
const asUser = new BenchClient();

// 1x1 red PNG
const PNG_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const state: { branchId?: string; chatId?: string; benchBranchId?: string; uploadId?: string } = {};

const ok = (name: string, pass: boolean, detail = '') => {
  recordAssert(SCENARIO, name, pass, detail);
  expect(pass, `${name}: ${detail}`).toBe(true);
};

describe('api probes', () => {
  it('judge smoke: JUDGE_MODEL grades good and bad outcomes correctly', async () => {
    // Direct evaluator calls — the bad case SHOULD fail and must not land in
    // the run report as a failure.
    const { judge } = await import('../../test/llm-evaluator');
    const { benchRun } = await import('../lib/env');
    const step = 'The user asked for the capital of France; the app answered.';
    const criteria = 'The answer names Paris.';
    const good = await judge(benchRun().env, {
      step,
      criteria,
      artifacts: [{ kind: 'text', label: 'answer', content: 'The capital of France is Paris.' }],
    });
    expect(good.pass, good.reasoning).toBe(true);
    const bad = await judge(benchRun().env, {
      step,
      criteria,
      artifacts: [{ kind: 'text', label: 'answer', content: 'The capital of France is Berlin.' }],
    });
    expect(bad.pass, bad.reasoning).toBe(false);
    recordAssert(SCENARIO, 'judge smoke (good/bad discrimination)', true);
  });

  it('version + me + impersonation', async () => {
    const version = await client.get('/api/version');
    ok('GET /api/version', version.status === 200 && !!(version.json as { version?: string }).version);

    const me = await client.get('/api/me');
    const meJson = me.json as { email?: string; role?: string };
    ok('GET /api/me is admin under SKIP_AUTH', me.status === 200 && meJson.email === 'admin@localhost');

    const patch = await client.req('PATCH', '/api/me', { theme: 'dark' });
    const meAfter = (await client.get('/api/me')).json as { theme?: string };
    ok('PATCH /api/me theme roundtrip', patch.status === 200 && meAfter.theme === 'dark');
    await client.req('PATCH', '/api/me', { theme: 'system' });

    const list = await client.get('/api/dev/impersonate');
    const users = (list.json as { users?: { email: string }[] }).users ?? [];
    ok('GET /api/dev/impersonate lists seeded users', list.status === 200 && users.length >= 3);

    const bad = await client.req('POST', '/api/dev/impersonate', { email: 'nobody@nowhere' });
    ok('POST impersonate rejects unknown email', bad.status === 400);

    await asUser.as('user@localhost');
    const asUserMe = (await asUser.get('/api/me')).json as { email?: string };
    ok('impersonation cookie switches identity', asUserMe.email === 'user@localhost');
  });

  it('branches: list, create, validation', async () => {
    const list = await client.get('/api/branches');
    const branches = (list.json as { branches?: { id: string; name: string }[] }).branches ?? [];
    const main = branches.find((b) => b.name === 'main');
    ok('GET /api/branches syncs git branches (main present)', list.status === 200 && !!main);
    state.branchId = main?.id;

    const created = await client.req('POST', '/api/branches', { name: 'bench-probe' });
    const createdJson = created.json as { branch?: { id: string } };
    ok('POST /api/branches creates a branch', created.status === 201 && !!createdJson.branch?.id);
    state.benchBranchId = createdJson.branch?.id;

    const invalid = await client.req('POST', '/api/branches', { name: 'Bad_Name!' });
    ok('POST /api/branches rejects non-DNS-safe name', invalid.status === 400);
    const reserved = await client.req('POST', '/api/branches', { name: 'c-reserved' });
    ok('POST /api/branches rejects reserved prefix', reserved.status === 400);
  });

  it('chats: create, history, context, tabs', async () => {
    const created = await client.req('POST', '/api/chats', { branchId: state.branchId });
    const chat = (created.json as { chat?: { id: string } }).chat;
    ok('POST /api/chats creates a workflow chat', created.status === 201 && !!chat?.id);
    state.chatId = chat!.id;

    const noBranch = await client.req('POST', '/api/chats', {});
    ok('POST /api/chats requires branchId', noBranch.status === 400);

    const history = await client.get(`/api/chat/history?chatId=${state.chatId}`);
    ok('GET /api/chat/history', history.status === 200);

    const context = await client.req('POST', '/api/chat/context', {
      chatId: state.chatId,
      url: 'http://main.localhost/',
      route: '/',
    });
    ok('POST /api/chat/context beacon', context.status === 200);

    const putTabs = await client.req('PUT', '/api/chat/tabs', {
      chatId: state.chatId,
      tabs: ['/', '/about'],
      activeIndex: 1,
    });
    const tabs = (await client.get(`/api/chat/tabs?chatId=${state.chatId}`)).json as {
      tabs?: string[];
      activeIndex?: number;
    };
    ok(
      'PUT+GET /api/chat/tabs roundtrip',
      putTabs.status === 200 && tabs.tabs?.length === 2 && tabs.activeIndex === 1,
    );

    const caps = await client.get(`/api/agent/capabilities?chat=${state.chatId}`);
    ok('GET /api/agent/capabilities', caps.status === 200);
  });

  it('files browser: dir, file, jail', async () => {
    const dir = await client.get(`/api/files/${state.chatId}?path=.`);
    const entries = (dir.json as { entries?: { name: string; dir: boolean }[] }).entries ?? [];
    ok('GET /api/files dir listing', dir.status === 200 && entries.length > 0);

    const firstFile = entries.find((e) => !e.dir);
    if (firstFile) {
      const file = await client.get(`/api/files/${state.chatId}?path=${encodeURIComponent(firstFile.name)}`);
      ok('GET /api/files file content', file.status === 200 && typeof (file.json as { content?: string }).content === 'string');
    }

    const jail = await client.get(`/api/files/${state.chatId}?path=${encodeURIComponent('../../../etc/passwd')}`);
    ok('GET /api/files rejects jail escape', jail.status >= 400 && jail.status < 500);
  });

  it('uploads: multipart + metadata', async () => {
    const uploaded = await client.upload('probe.png', 'image/png', PNG_FIXTURE, state.chatId);
    const upload = (uploaded.json as { upload?: { id: string } }).upload;
    ok('POST /api/uploads stores a chat-scoped PNG', uploaded.status === 201 && !!upload?.id);
    state.uploadId = upload?.id;

    const meta = await client.get(`/api/uploads?id=${state.uploadId}`);
    const metaJson = (meta.json as { upload?: { filename?: string; sha256?: string } }).upload;
    ok('GET /api/uploads metadata', meta.status === 200 && metaJson?.filename === 'probe.png');

    const noFile = await client.req('POST', '/api/uploads', {});
    ok('POST /api/uploads rejects non-multipart', noFile.status === 400);
  });

  it('window sessions: upsert, fetch, ownership, delete', async () => {
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    const put = await client.req('PUT', '/api/window-sessions', {
      id,
      label: 'bench window',
      state: { v: 1, chatId: state.chatId },
    });
    const list = (await client.get('/api/window-sessions')).json as { sessions?: { id: string }[] };
    ok('PUT+GET /api/window-sessions', put.status === 200 && !!list.sessions?.some((s) => s.id === id));

    const single = await client.get(`/api/window-sessions/${id}`);
    ok('GET /api/window-sessions/[id]', single.status === 200);

    const foreign = await asUser.get(`/api/window-sessions/${id}`);
    ok('window session hidden from other users', foreign.status >= 400);

    const del = await client.req('DELETE', `/api/window-sessions/${id}`);
    const gone = await client.get(`/api/window-sessions/${id}`);
    ok('DELETE /api/window-sessions/[id]', del.status === 200 && gone.status === 404);
  });

  it('memory, publications, archived', async () => {
    const memory = await client.get('/api/memory');
    ok('GET /api/memory', memory.status === 200);
    const bogus = await client.req('POST', '/api/memory', { id: 'nope', action: 'approve' });
    ok('POST /api/memory bogus id is a client error', bogus.status >= 400 && bogus.status < 500);
    const badAction = await client.req('POST', '/api/memory', { id: 'x' });
    ok('POST /api/memory requires action', badAction.status === 400);

    const pubs = await client.get('/api/publications');
    ok('GET /api/publications', pubs.status === 200);

    const archived = await client.get('/api/chats/archived');
    ok('GET /api/chats/archived', archived.status === 200);
  });

  it('admin routes are 403 for editors', async () => {
    const routes = [
      '/api/admin/branches',
      '/api/admin/chats',
      '/api/admin/previews',
      '/api/admin/uploads',
      '/api/admin/users',
      '/api/admin/settings',
      '/api/admin/usage',
      '/api/admin/grants',
    ];
    for (const route of routes) {
      const res = await asUser.get(route);
      ok(`editor GET ${route} → 403`, res.status === 403, `got ${res.status}`);
    }
  });

  it('injected bundles are served', async () => {
    const bootstrap = await client.get('/injected-cms-agent.js');
    ok('/injected-cms-agent.js is JS', bootstrap.status === 200 && bootstrap.text.includes('cms:agent-ready'));
    const module_ = await client.get('/injected-agent-module.js');
    ok('/injected-agent-module.js is JS', module_.status === 200 && module_.text.length > 1000);
    const annotate = await client.get('/injected-annotate.js');
    ok('/injected-annotate.js exposes __cmsAnnotate', annotate.status === 200 && annotate.text.includes('__cmsAnnotate'));
  });

  it('workflow transition guards without a plan', async () => {
    const approve = await client.req('POST', `/api/chats/${state.chatId}/approve-plan`, {});
    ok('approve-plan without pending plan is a 4xx', approve.status >= 400 && approve.status < 500, `got ${approve.status}`);
    const unknown = await client.req('POST', '/api/chats/does-not-exist/approve-plan', {});
    ok('approve-plan unknown chat → 404', unknown.status === 404);
  });
});
