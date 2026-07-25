/**
 * Production entry — plain Astro standalone server.
 * The middleware starts the native Pingora public listener; this HTTP server
 * remains the internal Astro upstream.
 */
import { createServer } from 'node:http';

// Must be set before the import below: in standalone mode the Astro entry
// autostarts its own listener on HOST:PORT unless this is disabled → EADDRINUSE.
process.env.ASTRO_NODE_AUTOSTART = 'disabled';
const { handler } = await import('./dist/server/entry.mjs');

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4321);

const httpServer = createServer(handler);

// HOST must match what the embedded proxy dials (routes-file `cms` mirrors HOST):
// e.g. HOST=::1 in dev where astro dev also binds IPv6.
httpServer.listen(PORT, HOST, () => {
  console.log(`cms-agent running on http://${HOST}:${PORT}`);
});
