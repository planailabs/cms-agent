import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { PROXY_HEADER, proxyToken } from '@/lib/proxyGuard';

const nativePath = process.env.PROXY_NATIVE_PATH;
const suite = nativePath ? describe : describe.skip;
const servers: Array<http.Server | net.Server> = [];

function listen(server: http.Server | net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

function request(
  port: number,
  host: string,
  cookie?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
  });
}

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

suite('embedded native proxy', () => {
  it('runs Pingora, applies routes directly, and validates Better Auth sessions', async () => {
    let lastUpstreamHeaders: http.IncomingHttpHeaders = {};
    const upstream = http.createServer((request_, response) => {
      lastUpstreamHeaders = request_.headers;
      response.setHeader('content-type', 'text/html');
      response.end('<html><head></head><body>upstream</body></html>');
    });
    const upstreamPort = await listen(upstream);
    const portProbe = net.createServer();
    const proxyPort = await listen(portProbe);
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));

    const secret = 'native-proxy-integration-secret';
    Object.assign(process.env, {
      PROXY_LISTEN: `127.0.0.1:${proxyPort}`,
      BASE_DOMAIN: 'cms.test',
      VAR_DIR: fs.mkdtempSync('/tmp/cms-proxy-test-'),
      CMS_UPSTREAM: `127.0.0.1:${upstreamPort}`,
      PUBLIC_SCHEME: 'http',
      PREVIEW_REQUIRE_AUTH: 'true',
      BETTER_AUTH_SECRET: secret,
    });

    const native = createRequire(import.meta.url)(nativePath!) as {
      startProxy(): void;
      setProxyRoutes(routes: string): void;
      setProxySessions(sessions: Array<{ token: string; expiresAtMs: number }>): void;
    };
    native.startProxy();
    native.setProxyRoutes(
      JSON.stringify({
        cms: `127.0.0.1:${upstreamPort}`,
        previews: { branch: `127.0.0.1:${upstreamPort}` },
      }),
    );
    native.setProxySessions([{ token: 'valid-session', expiresAtMs: Date.now() + 60_000 }]);

    let base: { status: number; body: string } | undefined;
    for (let attempt = 0; attempt < 100 && !base; attempt++) {
      try {
        base = await request(proxyPort, 'cms.test');
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(base?.status).toBe(200);

    const signedCookie = (token: string) => {
      const signature = createHmac('sha256', secret).update(token).digest('base64');
      return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
    };
    const allowed = await request(proxyPort, 'branch.cms.test', signedCookie('valid-session'));
    const missing = await request(proxyPort, 'branch.cms.test');
    const unknown = await request(proxyPort, 'branch.cms.test', signedCookie('unknown-session'));

    expect(allowed.status).toBe(200);
    expect(allowed.body).toContain('/__cms/injected-cms-agent.js');
    expect(missing.status).toBe(302);
    expect(unknown.status).toBe(302);

    // Proof-of-proxy header: the Rust side must stamp exactly what the TS
    // side derives, or the CMS rejects every proxied request as if it had
    // come in around the proxy (src/lib/proxyGuard.ts).
    expect(lastUpstreamHeaders[PROXY_HEADER]).toBe(proxyToken(secret));

    // And a client cannot smuggle its own value through: insert_header
    // replaces whatever arrived under that name.
    await request(proxyPort, 'cms.test', undefined, { [PROXY_HEADER]: 'forged' });
    expect(lastUpstreamHeaders[PROXY_HEADER]).toBe(proxyToken(secret));
  });
});
