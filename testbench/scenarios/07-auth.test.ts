/**
 * Real-auth surface — the launcher boots this phase WITHOUT SKIP_AUTH and
 * points OIDC_ISSUER at the port this suite binds an instrumented mock IdP
 * to (oauth2-mock-server: real discovery, JWKS, RS256-signed tokens, PKCE,
 * auto-approving /authorize). Claims are set per sign-in via the service
 * hooks, which is how the allowlist paths are driven.
 *
 * Server allowlist (launcher): ALLOWED_EMAILS=alice@bench.test,
 * ALLOWED_EMAIL_DOMAIN=team.bench.test.
 */
import { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootWorkspace, launchBrowser, type Browser } from '../lib/browser';
import { benchRun } from '../lib/env';
import { recordAssert } from '../lib/judge';

const SCENARIO = '07-auth';
const { baseUrl, env: benchEnv, authIdpPort } = benchRun();

const ok = (name: string, pass: boolean, detail = '') => {
  recordAssert(SCENARIO, name, pass, detail);
  expect(pass, `${name}: ${detail}`).toBe(true);
};

interface IdpUser {
  sub: string;
  email: string;
  name: string;
}

let idp: OAuth2Server;
let currentUser: IdpUser = { sub: 'alice', email: 'alice@bench.test', name: 'Alice Bench' };

beforeAll(async () => {
  if (!authIdpPort) throw new Error('authIdpPort missing — run via `pnpm bench:auth`');
  idp = new OAuth2Server();
  await idp.issuer.keys.generate('RS256');
  idp.service.on('beforeTokenSigning', (token) => {
    Object.assign(token.payload, {
      aud: benchEnv.OIDC_CLIENT_ID,
      sub: currentUser.sub,
      email: currentUser.email,
      name: currentUser.name,
      email_verified: true,
    });
  });
  idp.service.on('beforeUserinfo', (userInfoResponse) => {
    userInfoResponse.body = { ...currentUser, email_verified: true };
  });
  await idp.start(authIdpPort, '127.0.0.1');
}, 30_000);

afterAll(async () => {
  await idp?.stop();
});

// ── Minimal cookie jar: the CMS session cookies only (the IdP sets none) ──
type Jar = Map<string, string>;
const cookieHeader = (jar: Jar): string =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const absorb = (jar: Jar, res: Response): void => {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value) jar.set(key, value);
    else jar.delete(key);
  }
};

/** Drive the full authorization-code flow as `user`; returns the cookie jar. */
async function oidcSignIn(user: IdpUser): Promise<Jar> {
  currentUser = user;
  const jar: Jar = new Map();
  const start = await fetch(`${baseUrl}/api/auth/sign-in/oauth2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ providerId: 'oidc', callbackURL: '/' }),
  });
  absorb(jar, start);
  const { url } = (await start.json()) as { url?: string };
  if (!url) throw new Error(`sign-in start failed (${start.status})`);
  // IdP authorize → 302 with code → CMS callback (sets session) → 302 to '/'
  let next: string | null = url;
  for (let hop = 0; next && hop < 8; hop++) {
    const cms = next.startsWith(baseUrl);
    const res = await fetch(next, {
      redirect: 'manual',
      headers: cms ? { cookie: cookieHeader(jar) } : {},
    });
    if (cms) absorb(jar, res);
    const loc = res.headers.get('location');
    next = loc ? (loc.startsWith('http') ? loc : `${baseUrl}${loc}`) : null;
  }
  return jar;
}

const me = (jar?: Jar) =>
  fetch(`${baseUrl}/api/me`, { headers: jar ? { cookie: cookieHeader(jar) } : {} });

describe('real auth (mock OIDC IdP)', () => {
  it('unauthenticated surface: API 401s, signin redirect, public paths', async () => {
    ok('GET /api/me without session → 401', (await me()).status === 401);
    const page = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    ok(
      'page without session redirects to /signin/',
      page.status >= 300 && page.status < 400 && (page.headers.get('location') ?? '').includes('/signin'),
      `${page.status} ${page.headers.get('location')}`,
    );
    const deep = await fetch(`${baseUrl}/chat/some-chat?window=git`, { redirect: 'manual' });
    ok(
      'deep-link redirect carries ?next= through signin',
      (deep.headers.get('location') ?? '').includes(
        `next=${encodeURIComponent('/chat/some-chat?window=git')}`,
      ),
      `${deep.status} ${deep.headers.get('location')}`,
    );
    const wait = await fetch(`${baseUrl}/__preview/wait/main`);
    ok('preview wait stream without session → 401', wait.status === 401, `got ${wait.status}`);
    const signin = await fetch(`${baseUrl}/signin/`);
    ok('signin page is public', signin.status === 200 && (await signin.text()).includes('signin'));
    const injected = await fetch(`${baseUrl}/injected-cms-agent.js`);
    ok('injected bundle stays public', injected.status === 200);
    const arch = await fetch(`${baseUrl}/architecture`, { redirect: 'manual' });
    const archBody = arch.status === 200 ? await arch.text() : '';
    ok(
      'architecture page is public and renders its diagrams',
      arch.status === 200 && archBody.includes('class="mermaid"'),
      `${arch.status} ${arch.headers.get('location') ?? ''}`,
    );
    const imp = await fetch(`${baseUrl}/api/dev/impersonate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ email: 'admin@localhost' }),
    });
    ok('dev impersonation unavailable under real auth', imp.status === 401, `got ${imp.status}`);
  });

  it('full authorization-code flow signs an allowlisted user in', async () => {
    const jar = await oidcSignIn({ sub: 'alice', email: 'alice@bench.test', name: 'Alice Bench' });
    ok('session cookie issued', [...jar.keys()].some((k) => k.includes('session_token')), [...jar.keys()].join(','));
    const res = await me(jar);
    const body = (await res.json()) as { email?: string; role?: string };
    ok('session works: /api/me → alice', res.status === 200 && body.email === 'alice@bench.test', JSON.stringify(body).slice(0, 200));
    ok('fresh OIDC account defaults to editor role', body.role === 'editor', body.role);

    // Second sign-in of the same subject reuses the account (no dup, no error)
    const jar2 = await oidcSignIn({ sub: 'alice', email: 'alice@bench.test', name: 'Alice Bench' });
    const again = await me(jar2);
    ok('repeat sign-in reuses the account', again.status === 200, `got ${again.status}`);
  });

  it('allowlist: domain rule admits, unknown email is rejected', async () => {
    const bob = await oidcSignIn({ sub: 'bob', email: 'bob@team.bench.test', name: 'Bob Team' });
    ok('ALLOWED_EMAIL_DOMAIN admits bob@team.bench.test', (await me(bob)).status === 200);

    const mallory = await oidcSignIn({ sub: 'mallory', email: 'mallory@evil.test', name: 'Mallory' });
    ok('unlisted email gets no session', (await me(mallory)).status === 401);
  });

  it('signin page drives the flow in a real browser', async () => {
    currentUser = { sub: 'alice', email: 'alice@bench.test', name: 'Alice Bench' };
    let browser: Browser | null = null;
    try {
      browser = await launchBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/\/signin\/?/, { timeout: 15_000 });
      await page.click('#signin');
      // IdP auto-approves → callback → workspace
      await page.waitForURL((u) => !/\/signin/.test(u.pathname), { timeout: 20_000 });
      await bootWorkspace(page);
      ok('browser signin lands in the workspace', true);
    } finally {
      await browser?.close();
    }
  }, 120_000);

  it('chat visibility setting: restricted hides foreign chats from editors', async () => {
    // No admin OIDC identity exists (allowlist is alice + team domain), so
    // promote bob directly in the bench DB — the toggle + admin-bypass paths
    // then run through real sessions.
    process.env.DATABASE_URL = benchEnv.DATABASE_URL;
    const { prisma } = await import('@/lib/db');
    await prisma.user.updateMany({
      where: { email: 'bob@team.bench.test' },
      data: { role: 'admin' },
    });

    const alice = await oidcSignIn({ sub: 'alice', email: 'alice@bench.test', name: 'Alice Bench' });
    const bob = await oidcSignIn({ sub: 'bob', email: 'bob@team.bench.test', name: 'Bob Team' });
    const chatsFor = async (jar: Jar) =>
      (
        (await (
          await fetch(`${baseUrl}/api/branches`, { headers: { cookie: cookieHeader(jar) } })
        ).json()) as { branches: { id: string; chats: { id: string }[] }[] }
      ).branches.flatMap((b) => b.chats.map((c) => c.id));
    const putSetting = (jar: Jar, value: boolean) =>
      fetch(`${baseUrl}/api/admin/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: cookieHeader(jar) },
        body: JSON.stringify({ chatsSharedVisibility: value }),
      });
    const historyStatus = async (jar: Jar, chatId: string) =>
      (
        await fetch(`${baseUrl}/api/chat/history?chatId=${chatId}`, {
          headers: { cookie: cookieHeader(jar) },
        })
      ).status;

    // A chat with a real creator (bob) — foreign from alice's point of view.
    // The main phase's surviving chat is the creator-less system Deployments
    // chat, which restricted mode deliberately keeps visible.
    const branchList = (await (
      await fetch(`${baseUrl}/api/branches`, { headers: { cookie: cookieHeader(bob) } })
    ).json()) as { branches: { id: string }[] };
    const created = await fetch(`${baseUrl}/api/chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(bob) },
      body: JSON.stringify({ branchId: branchList.branches[0]!.id, title: 'bob visibility probe' }),
    });
    ok('admin creates a probe chat', created.status === 201, String(created.status));
    const foreignId = ((await created.json()) as { chat: { id: string } }).chat.id;
    const systemChat = await prisma.chat.findFirst({
      where: { kind: 'deployments' },
      select: { id: true },
    });

    const before = await chatsFor(alice);
    ok('shared (default): editor sees the foreign chat', before.includes(foreignId), `${before.length} chats`);

    ok('editor cannot flip the setting', (await putSetting(alice, false)).status === 403);
    ok('admin flips shared visibility off', (await putSetting(bob, false)).status === 200);
    try {
      const restricted = await chatsFor(alice);
      ok('restricted: foreign chat gone from the editor list', !restricted.includes(foreignId), `${restricted.length} left`);
      ok('restricted: foreign chat history reads as 404', (await historyStatus(alice, foreignId)) === 404);
      if (systemChat) {
        ok('restricted: system chat stays listed', restricted.includes(systemChat.id));
        ok('restricted: system chat stays readable', (await historyStatus(alice, systemChat.id)) === 200);
      }
      const adminSees = await chatsFor(bob);
      ok('restricted: admin still sees everything', adminSees.includes(foreignId), `${adminSees.length}`);
    } finally {
      // Restore the default whatever happened above.
      await putSetting(bob, true);
    }
    const restored = await chatsFor(alice);
    ok('restored: editor sees the foreign chat again', restored.includes(foreignId), `${restored.length} chats`);
  });
});
