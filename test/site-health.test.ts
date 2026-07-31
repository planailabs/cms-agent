/**
 * Site health checkpoints.
 *
 * A sync rebases the draft onto the target and git reports success even when
 * the result no longer renders — a renamed component, a config both sides
 * touched. Nobody looks at the preview right after pressing Sync, so the flow
 * has to look: the check runs, and a broken site pauses the automatism the
 * same way a merge conflict does, with the agent invoked to fix it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureInstance, getStartError, prismaMock } = vi.hoisted(() => ({
  ensureInstance: vi.fn(),
  getStartError: vi.fn(),
  prismaMock: { chatTabs: { findMany: vi.fn() } },
}));

vi.mock('@/lib/preview/manager', async () => {
  const actual = await vi.importActual<typeof import('@/lib/preview/manager')>(
    '@/lib/preview/manager',
  );
  // previewOrigin stays real: where the checker looks for the dev server is
  // the thing under test here, not a detail to stub away.
  return { ...actual, ensureInstance, getStartError, stopInstance: vi.fn() };
});
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

import { astroBackend, astroErrorText } from '@/lib/site/astro';
import { staticBackend } from '@/lib/site/static';
import {
  chatPreviewRoutes,
  checkSiteHealth,
  clearSiteHealth,
  describeIssues,
  lastSiteHealth,
} from '@/lib/site/health';
import { resetActiveBackend } from '@/lib/site';
import { env } from '@/lib/env';
import { hasErrors } from '@/lib/validate';

/**
 * A dev server on a real port, answering whatever the case needs — bound to
 * the SAME host a preview binds (env HOST), because addressing it is exactly
 * what this used to get wrong: the checker probed 127.0.0.1 while the dev
 * server listened on ::1, and every page came back as "fetch failed".
 */
const server = async (
  handler: (req: Request) => Response,
): Promise<{ port: number; close: () => Promise<void> }> => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const response = handler(new Request(`http://localhost${req.url}`));
    void response.text().then((body) => {
      res.writeHead(response.status, { 'Content-Type': 'text/html' });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, env().HOST, resolve));
  const port = (srv.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => srv.close(() => r())) };
};

beforeEach(() => {
  ensureInstance.mockReset();
  getStartError.mockReset().mockReturnValue(null);
  prismaMock.chatTabs.findMany.mockReset().mockResolvedValue([]);
  resetActiveBackend();
});

afterEach(() => {
  resetActiveBackend();
});

describe('the Astro error detector', () => {
  it('reports a route the dev server cannot render, with the error text', async () => {
    const s = await server((req) =>
      new URL(req.url).pathname === '/broken'
        ? new Response(
            '<html><head><title>Error</title></head><body><h1>NoMatchingImport</h1>' +
              '<p>Could not find <code>../components/Hero.astro</code></p>' +
              '<script>console.log("overlay")</script></body></html>',
            { status: 500 },
          )
        : new Response('<html><body>fine</body></html>', { status: 200 }),
    );
    try {
      const issues = await astroBackend.detectSiteErrors!({
        baseUrl: `http://127.0.0.1:${s.port}`,
        routes: ['/', '/broken'],
        worktree: '/tmp/nope',
      });
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('/broken');
      expect(issues[0].message).toContain('NoMatchingImport');
      expect(issues[0].message).toContain('Hero.astro');
      // Page machinery is not the error.
      expect(issues[0].message).not.toContain('overlay');
      expect(issues[0].failureClass).toBe('AGENT_FIXABLE');
    } finally {
      await s.close();
    }
  });

  it('leaves a 404 alone — a missing page is the site answering, not failing', async () => {
    const s = await server(() => new Response('Not found', { status: 404 }));
    try {
      const issues = await astroBackend.detectSiteErrors!({
        baseUrl: `http://127.0.0.1:${s.port}`,
        routes: ['/gone'],
        worktree: '/tmp/nope',
      });
      expect(issues).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it('names what actually failed when it cannot reach the server at all', async () => {
    // A port that was real and is now closed — the shape of a dev server that
    // died, and the case where "fetch failed" (undici's word for every
    // transport problem) is exactly what a person debugging must not be
    // handed. The address it tried is the other half of the answer.
    const dead = await server(() => new Response('never', { status: 200 }));
    await dead.close();

    const issues = await astroBackend.detectSiteErrors!({
      baseUrl: `http://127.0.0.1:${dead.port}`,
      routes: ['/'],
      worktree: '/tmp/nope',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`http://127.0.0.1:${dead.port}/`);
    expect(issues[0].message).toMatch(/ECONNREFUSED/);
    // Not the site's fault, and not the agent's job.
    expect(issues[0].failureClass).toBe('RETRYABLE_INFRA');
  });

  it('keeps the words and drops the markup', () => {
    expect(astroErrorText('<h1>Boom</h1><pre>at src/pages/index.astro:3</pre>')).toBe(
      'Boom\nat src/pages/index.astro:3',
    );
    expect(astroErrorText('<p>a &amp; b &lt;c&gt;</p>')).toBe('a & b <c>');
    expect(astroErrorText('<div></div>')).toContain('no readable error text');
  });

  it('is not offered by a backend without runtime errors of its own', () => {
    expect(staticBackend.detectSiteErrors).toBeUndefined();
  });
});

describe('checkSiteHealth', () => {
  it('treats a dev server that will not start as the error itself', async () => {
    ensureInstance.mockRejectedValue(new Error('npm install failed (1)'));
    getStartError.mockReturnValue({ message: 'npm install failed (1): ENOSPC', at: Date.now() });

    const issues = await checkSiteHealth({ branch: 'c-1', worktree: '/tmp/wt' });
    expect(hasErrors(issues)).toBe(true);
    expect(issues[0].validator).toBe('preview-start');
    expect(issues[0].message).toContain('ENOSPC');
  });

  it('passes a site whose pages render', async () => {
    const s = await server(() => new Response('<html>ok</html>', { status: 200 }));
    ensureInstance.mockResolvedValue({ port: s.port });
    try {
      expect(await checkSiteHealth({ branch: 'c-1', worktree: '/tmp/wt' })).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it('reports a broken page through the backend', async () => {
    const s = await server(() => new Response('<h1>Oops</h1>', { status: 500 }));
    ensureInstance.mockResolvedValue({ port: s.port });
    try {
      const issues = await checkSiteHealth({ branch: 'c-1', worktree: '/tmp/wt' });
      expect(hasErrors(issues)).toBe(true);
      expect(describeIssues(issues)).toContain('Oops');
    } finally {
      await s.close();
    }
  });

  it('records every verdict, so the agent can read it back without re-checking', async () => {
    // The checkpoint runs server-side and the agent arrives afterwards; the
    // record is what site_status reports (and what a fix is measured against).
    clearSiteHealth('c-record');
    const s = await server(() => new Response('<h1>Oops</h1>', { status: 500 }));
    ensureInstance.mockResolvedValue({ port: s.port });
    try {
      await checkSiteHealth({ branch: 'c-record', worktree: '/tmp/wt', routes: ['/blog/'] });
      const report = lastSiteHealth('c-record');
      // Both probed routes answered 500 — the record keeps every failure, not
      // just the first, because the agent has to fix all of them.
      expect(report?.issues).toHaveLength(2);
      expect(report?.routes).toEqual(['/', '/blog/']);
      expect(report?.at).toBeGreaterThan(0);

      // A later healthy check replaces it — a stale failure would have the
      // agent fixing something that is no longer broken.
      await s.close();
      const healthy = await server(() => new Response('<html>ok</html>', { status: 200 }));
      ensureInstance.mockResolvedValue({ port: healthy.port });
      await checkSiteHealth({ branch: 'c-record', worktree: '/tmp/wt' });
      expect(lastSiteHealth('c-record')?.issues).toEqual([]);
      await healthy.close();
    } catch (err) {
      await s.close().catch(() => {});
      throw err;
    }
  });

  it('probes the routes the chat has open, home first and bounded', async () => {
    prismaMock.chatTabs.findMany.mockResolvedValue([
      { tabs: ['/', '/blog/', '/about/'] },
      { tabs: ['/contact/', '/team/', '/jobs/', '/press/'] },
    ]);
    const routes = await chatPreviewRoutes('chat-1');
    expect(routes[0]).toBe('/');
    expect(routes).toContain('/blog/');
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes.length).toBeLessThanOrEqual(5);
  });
});
