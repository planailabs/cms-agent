/**
 * Production entry — plain Astro standalone server.
 * The public entrypoint is the Pingora sidecar (proxy/); this server only
 * listens on the internal CMS port and never proxies preview traffic itself.
 */
import { createServer } from 'node:http';
import { handler } from './dist/server/entry.mjs';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4321);

const httpServer = createServer(handler);

httpServer.listen(PORT, HOST, () => {
  console.log(`cms-agent running on http://${HOST}:${PORT}`);
});
