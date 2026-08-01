/**
 * The local-start readiness probe (scripts/wait-for-proxy.mjs).
 *
 * The real system it waits on is lazy: `astro dev` evaluates the middleware —
 * and with it the code that starts the embedded proxy — only when a request
 * reaches the app. A probe that watches the proxy port alone therefore waits
 * out its whole deadline on a server that is perfectly healthy. The fixture
 * below reproduces exactly that shape: the "proxy" does not exist until the
 * "app" has been asked for something.
 */
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const PROBE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'wait-for-proxy.mjs',
);
const PAGE = '<html><head><title>Architecture — CMS Agent</title></head><body></body></html>';

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

const close = (server: http.Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const runProbe = (env: Record<string, string>): Promise<number> =>
  new Promise((resolve) => {
    execFile('node', [PROBE], { env: { ...process.env, ...env } }, (err) =>
      resolve(err ? ((err as { code?: number }).code ?? 1) : 0),
    );
  });

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe('the readiness probe', () => {
  it('knocks on the app so the proxy it is waiting for comes up', async () => {
    let proxy: http.Server | null = null;
    let proxyPort = 0;
    let knocks = 0;

    // Stands in for `astro dev`: the proxy starts on the first request, the
    // way importing the middleware module does it in the real server.
    const app = http.createServer((_req, res) => {
      knocks++;
      if (!proxy) {
        proxy = http.createServer((_r, pres) => pres.end(PAGE));
        proxy.listen(proxyPort, '127.0.0.1');
        servers.push(proxy);
      }
      res.statusCode = 403; // the proxy guard refuses direct requests
      res.end('use the proxy');
    });
    servers.push(app);
    const appPort = await listen(app);

    // A port the "proxy" will claim once the app has been knocked on.
    const placeholder = http.createServer();
    proxyPort = await listen(placeholder);
    await close(placeholder);

    const code = await runProbe({
      HOST: '127.0.0.1',
      INTERNAL_PORT: String(appPort),
      PROXY_PORT: String(proxyPort),
      BASE_DOMAIN: 'localhost',
    });

    expect(knocks).toBeGreaterThan(0);
    expect(code).toBe(0);
  }, 60_000);

  it('stays unready while nothing serves the CMS', async () => {
    const app = http.createServer((_req, res) => res.end('ok'));
    servers.push(app);
    const appPort = await listen(app);
    // A proxy port that answers, but with someone else's page.
    const other = http.createServer((_req, res) => res.end('<title>Some other app</title>'));
    servers.push(other);
    const otherPort = await listen(other);

    expect(
      await runProbe({
        HOST: '127.0.0.1',
        INTERNAL_PORT: String(appPort),
        PROXY_PORT: String(otherPort),
        BASE_DOMAIN: 'localhost',
      }),
    ).toBe(1);
  }, 60_000);
});
