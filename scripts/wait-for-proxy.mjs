/**
 * One readiness probe for the local development start: exit 0 once the public
 * proxy serves the CMS, non-zero otherwise. `scripts/start-local.sh` runs it
 * in a loop.
 *
 * The knock on the internal port is the part that is easy to leave out and
 * impossible to notice afterwards: `astro dev` loads middleware lazily, and
 * the module that starts the embedded proxy is only evaluated when a request
 * reaches the app. Polling the proxy port alone waits for a listener nothing
 * is going to create — until the ten-minute deadline gives up on a server that
 * was healthy the whole time.
 *
 * Env: HOST, INTERNAL_PORT, BASE_DOMAIN, PROXY_PORT (default 8080).
 */
import http from 'node:http';

/** Resolves to {status, body}, or null for any failure — a probe has one
 *  question to answer and every error is the same answer. */
const fetchText = (options, timeoutMs) =>
  new Promise((resolve) => {
    const req = http.get(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve(null));
  });

const internalPort = Number(process.env.INTERNAL_PORT || 4321);
const proxyPort = Number(process.env.PROXY_PORT || 8080);
const host = process.env.HOST || '127.0.0.1';
const baseDomain = process.env.BASE_DOMAIN || 'localhost';

// The response does not matter — the proxy guard may well refuse a request
// that did not come through the proxy. Loading the module is the whole point.
// The first one compiles the app, hence the generous timeout.
await fetchText({ host, port: internalPort, path: '/' }, 30_000);

const res = await fetchText(
  {
    host: '127.0.0.1',
    port: proxyPort,
    path: '/architecture',
    headers: { host: `${baseDomain}:${proxyPort}` },
  },
  5_000,
);

const servesCms = res?.body.includes('<title>Architecture — CMS Agent</title>');
process.exit(res?.status === 200 && servesCms ? 0 : 1);
