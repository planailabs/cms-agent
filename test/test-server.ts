/**
 * Standalone test HTTP server — exercises the real agent handler via
 * POST + SSE without auth or DB persistence (ported from chat/test/).
 * Runnable standalone: npx vite-node test/test-server.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import {
  acquireTurnLock,
  addConnection,
  broadcast,
  releaseTurnLock,
  type SSEWriter,
} from '../src/lib/agent/bus';
import { handleChatMessage } from '../src/lib/agent/handler';
import { memoryRecords } from '../src/lib/agent/persistence';
import type { WorkflowPhase } from '../src/lib/agent/types';

export function readDotenv(mode = 'development'): Record<string, string> {
  const cwd = process.cwd();
  const env: Record<string, string> = {};

  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const files = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
  for (const file of files) {
    try {
      const content = readFileSync(resolve(cwd, file), 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'")) {
          val = val.slice(1, -1);
        }
        env[key] = val;
      }
    } catch {
      // File doesn't exist — skip
    }
  }
  return env;
}

export interface TestServer {
  port: number;
  close: () => void;
}

export interface TestServerOptions {
  /** Worktree the read tools operate on (e.g. a copy of examples/basic-site). */
  worktreePath?: string;
  workflowPhase?: WorkflowPhase;
}

export async function startServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);

    // ── GET /api/chat/events — SSE ──────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/chat/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const chatId = url.searchParams.get('chatId') ?? 'test-chat';
      const writer: SSEWriter = {
        write(event, data) {
          try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch {
            /* closed */
          }
        },
        end() {
          try {
            res.end();
          } catch {
            /* already ended */
          }
        },
      };
      const unsubscribe = addConnection(chatId, writer);

      const pingInterval = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(pingInterval);
          unsubscribe();
        }
      }, 30_000);

      req.on('close', () => {
        clearInterval(pingInterval);
        unsubscribe();
      });
      return;
    }

    // ── POST /api/chat/message ──────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/chat/message') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const chatId: string = body.chatId ?? 'test-chat';

      const lockId = acquireTurnLock(chatId);
      if (!lockId) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A conversation turn is already in progress' }));
        return;
      }

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted' }));

      void (async () => {
        try {
          await handleChatMessage('test-user', 'en', { ...body, chatId }, {
            skipPersistence: true,
            worktreePath: opts.worktreePath,
            workflowPhase: opts.workflowPhase,
          });
        } catch (err) {
          console.error('[test-server] Handler error:', err);
          broadcast(chatId, 'error', {
            type: 'error',
            message: err instanceof Error ? err.message : 'Internal error',
          });
        } finally {
          releaseTurnLock(chatId, lockId);
        }
      })();
      return;
    }

    // ── POST /api/chat/reset — clear in-memory state ────────────────────
    if (req.method === 'POST' && url.pathname === '/api/chat/reset') {
      memoryRecords.clear();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return new Promise((resolveP) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveP({
        port,
        close: () => {
          server.close();
        },
      });
    });
  });
}
