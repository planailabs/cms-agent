/**
 * Live agent-loop integration test (ported from chat/test/chat-integration).
 * Talks to the REAL configured OpenAI-compatible endpoint — skipped unless
 * .env/.env.local provides a real OPENAI_API_KEY. In-memory persistence;
 * read tools operate on examples/basic-site.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDotenv, startServer, type TestServer } from '../test-server';
import { evaluateExchange } from '../llm-evaluator';

const dotenv = readDotenv();
const hasRealKey =
  !!dotenv.OPENAI_API_KEY && dotenv.OPENAI_API_KEY !== 'sk-test' && !!dotenv.OPENAI_MODEL;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

async function collectEvents(
  port: number,
  chatId: string,
  send: () => Promise<void>,
  doneEvents = ['done', 'question', 'error'],
  timeoutMs = 120_000,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/events?chatId=${chatId}`, {
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  await send();

  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const eventMatch = /^event: (.+)$/m.exec(chunk);
        const dataMatch = /^data: (.+)$/m.exec(chunk);
        if (!eventMatch) continue;
        events.push({
          event: eventMatch[1],
          data: dataMatch ? JSON.parse(dataMatch[1]) : {},
        });
        if (doneEvents.includes(eventMatch[1])) return events;
      }
    }
  } finally {
    controller.abort();
  }
  return events;
}

describe.skipIf(!hasRealKey)('agent loop against a real model endpoint', () => {
  let server: TestServer;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(dotenv)) process.env[k] = v;
    const { resetEnvCache } = await import('@/lib/env');
    resetEnvCache();
    server = await startServer({
      worktreePath: path.resolve(__dirname, '..', '..', 'examples', 'basic-site'),
      workflowPhase: 'plan',
    });
  });

  afterAll(() => server?.close());

  it('streams a planning turn that reads the site and stays read-only', async () => {
    const chatId = `it-${Date.now()}`;
    const events = await collectEvents(server.port, chatId, async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/chat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId,
          type: 'message',
          text: 'What pages does this site have? Just list them, no plan needed yet.',
        }),
      });
      expect(res.status).toBe(202);
    });

    const types = events.map((e) => e.event);
    expect(types).toContain('thinking');
    expect(types.at(-1)).toMatch(/done|question/);
    expect(types).not.toContain('error');

    // The model should have used read tools to inspect the site
    const toolStarts = events.filter((e) => e.event === 'tool_start').map((e) => e.data.name);
    expect(toolStarts.length).toBeGreaterThan(0);
    expect(toolStarts).not.toContain('write_file');

    const text = events
      .filter((e) => e.event === 'text_done')
      .map((e) => e.data.content as string)
      .join('\n');
    expect(text.length).toBeGreaterThan(0);

    const judgment = await evaluateExchange(
      dotenv,
      'What pages does this site have?',
      text,
      'The response mentions the pages of the site — a home/index page and an about page.',
    );
    expect(judgment.pass, judgment.reasoning).toBe(true);
  }, 180_000);
});
