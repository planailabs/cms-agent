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

vi.mock('@/lib/preview/manager', () => ({ ensureInstance, getStartError, stopInstance: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

import { astroBackend, astroErrorText } from '@/lib/site/astro';
import { staticBackend } from '@/lib/site/static';
import { chatPreviewRoutes, checkSiteHealth, describeIssues } from '@/lib/site/health';
import { resetActiveBackend } from '@/lib/site';
import { hasErrors } from '@/lib/validate';

/** A dev server on a real port, answering whatever the case needs. */
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
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
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

  it('reports a route that never answers rather than passing it', async () => {
    // Nothing listens on this port; the fetch fails outright.
    const issues = await astroBackend.detectSiteErrors!({
      baseUrl: 'http://127.0.0.1:1',
      routes: ['/'],
      worktree: '/tmp/nope',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('could not be loaded');
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
