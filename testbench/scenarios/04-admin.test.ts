/**
 * Admin surface — runs after 03 so the views reflect real journey data.
 * Editors' 403s are covered in 01; this file works as admin@localhost.
 */
import { describe, expect, it } from 'vitest';
import { BenchClient } from '../lib/client';
import { recordAssert } from '../lib/judge';
import { loadJourney } from '../lib/journey';

const SCENARIO = '04-admin';
const admin = new BenchClient();

// 1x1 PNG for the upload-delete roundtrip
const PNG_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ok = (name: string, pass: boolean, detail = '') => {
  recordAssert(SCENARIO, name, pass, detail);
  expect(pass, `${name}: ${detail}`).toBe(true);
};

describe('admin surface', () => {
  it('branches, chats, previews reflect the run', async () => {
    const branches = (await admin.get('/api/admin/branches')).json as {
      branches?: { name: string }[];
    };
    ok('admin branches lists main', (branches.branches ?? []).some((b) => b.name === 'main'));

    const chats = (await admin.get('/api/admin/chats')).json as { chats?: { id: string }[] };
    ok('admin chats returns rows', (chats.chats ?? []).length > 0);
    const journey = loadJourney();
    if (journey) {
      ok(
        'admin chats includes the journey chat',
        (chats.chats ?? []).some((c) => c.id === journey.chatId),
      );
    } else {
      recordAssert(SCENARIO, 'admin chats includes the journey chat', true, 'n/a — e2e group not run');
    }

    const previews = await admin.get('/api/admin/previews');
    ok('admin previews returns instance state', previews.status === 200);
    const stop = await admin.req('POST', '/api/admin/previews', { branch: 'main', action: 'stop' });
    ok('admin preview stop accepted', stop.status === 202 || stop.status === 200, `got ${stop.status}`);
  });

  it('uploads: list, sort, delete roundtrip', async () => {
    const up = await admin.upload('admin-probe.png', 'image/png', PNG_FIXTURE);
    const id = (up.json as { upload?: { id: string } }).upload?.id;
    ok('admin can upload', up.status === 201 && !!id);

    const sorted = await admin.get('/api/admin/uploads?sort=size&dir=desc');
    const uploads = (sorted.json as { uploads?: { id: string }[] }).uploads ?? [];
    ok('admin uploads sorted listing', sorted.status === 200 && uploads.some((u) => u.id === id));

    const del = await admin.req('DELETE', `/api/admin/uploads?id=${id}`);
    ok('admin upload delete', del.status === 200);
  });

  it('users: search and role roundtrip', async () => {
    const users = (await admin.get('/api/admin/users?q=user2')).json as {
      users?: { id: string; email: string; role: string }[];
    };
    const user2 = users.users?.find((u) => u.email === 'user2@localhost');
    ok('admin user search finds user2', !!user2);

    const promote = await admin.req('POST', '/api/admin/users', { userId: user2!.id, role: 'admin' });
    const demote = await admin.req('POST', '/api/admin/users', { userId: user2!.id, role: 'editor' });
    ok('role set roundtrip', promote.status === 200 && demote.status === 200);
    const bad = await admin.req('POST', '/api/admin/users', { userId: user2!.id, role: 'root' });
    ok('invalid role rejected', bad.status === 400);
  });

  it('settings + system prompt extension roundtrips', async () => {
    const before = (await admin.get('/api/admin/settings')).json as {
      attachmentsOnePerMessage?: boolean;
    };
    const flipped = await admin.req('PUT', '/api/admin/settings', {
      attachmentsOnePerMessage: !before.attachmentsOnePerMessage,
    });
    const restored = await admin.req('PUT', '/api/admin/settings', {
      attachmentsOnePerMessage: before.attachmentsOnePerMessage,
    });
    ok('settings PUT roundtrip', flipped.status === 200 && restored.status === 200);

    const users = (await admin.get('/api/admin/users?q=user@localhost')).json as {
      users?: { id: string; email: string }[];
    };
    const editor = users.users?.find((u) => u.email === 'user@localhost');
    const put = await admin.req('PUT', '/api/admin/system-prompt-extension', {
      userId: editor!.id,
      content: 'Bench extension: keep answers short.',
    });
    const got = (await admin.get(`/api/admin/system-prompt-extension?userId=${editor!.id}`)).json as {
      content?: string;
    };
    const cleared = await admin.req('PUT', '/api/admin/system-prompt-extension', {
      userId: editor!.id,
      content: '',
    });
    ok(
      'system prompt extension roundtrip',
      put.status === 200 && got.content?.includes('Bench extension') === true && cleared.status === 200,
    );
  });

  it('usage and grants', async () => {
    const usage = await admin.get('/api/admin/usage?days=7');
    ok('usage aggregates', usage.status === 200);
    if (loadJourney()) {
      const perUser = (usage.json as { perUser?: { inputTokens?: number }[] }).perUser ?? [];
      ok('usage shows journey tokens', perUser.length > 0);
    }

    const users = (await admin.get('/api/admin/users?q=admin@localhost')).json as {
      users?: { id: string }[];
    };
    const created = await admin.req('POST', '/api/admin/grants', {
      userId: users.users?.[0]?.id,
      actions: ['implement'],
      pathScope: ['src/content/**'],
      maxRisk: 'content',
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const grantId = (created.json as { grant?: { id: string } }).grant?.id;
    ok('grant created', created.status === 201 && !!grantId);
    const list = (await admin.get('/api/admin/grants')).json as { grants?: { id: string }[] };
    ok('grant listed', (list.grants ?? []).some((g) => g.id === grantId));
    const revoked = await admin.req('DELETE', `/api/admin/grants?id=${grantId}`);
    ok('grant revoked', revoked.status === 200);
  });

  it('dashboard is admin-only', async () => {
    const asAdmin = await admin.get('/dashboard');
    ok('dashboard renders for admin', asAdmin.status === 200 && asAdmin.text.includes('<html'));
    const editor = new BenchClient();
    await editor.as('user@localhost');
    const asEditor = await editor.get('/dashboard');
    ok(
      'dashboard blocked for editors',
      asEditor.status >= 300 || !asEditor.text.includes('dashboard'),
      `got ${asEditor.status}`,
    );
  });
});
