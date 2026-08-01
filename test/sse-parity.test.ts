/**
 * Every SSE event the server sends has a listener, and every listener has a
 * sender.
 *
 * Both halves fail silently, which is why they need a test rather than
 * vigilance. A broadcast nobody registered for simply disappears — the code
 * looks like it updates the UI and does not. A listener for an event nobody
 * emits is worse than dead: it reads as a live path, so state that is really
 * only carried by the 'state' snapshot looks separately handled, and the next
 * person removes the snapshot line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SSE_EVENTS } from '@/components/chat/actions/chat/sse';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** broadcast(chatId, 'name', …) — the only way an event reaches a browser. */
const BROADCAST = /\bbroadcast\(\s*[^,]+,\s*'([a-z_]+)'/g;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.astro')) out.push(full);
  }
  return out;
};

const producedEvents = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(BROADCAST)) {
      const name = match[1];
      found.set(name, [...(found.get(name) ?? []), path.relative(SRC, file)]);
    }
  }
  return found;
};

describe('the SSE vocabulary', () => {
  it('has a listener for everything the server broadcasts', () => {
    const produced = [...producedEvents().keys()].sort();
    const registered = new Set<string>(SSE_EVENTS);
    const unheard = produced.filter((e) => !registered.has(e));
    expect(unheard).toEqual([]);
  });

  it('registers nothing the server never sends', () => {
    const produced = new Set(producedEvents().keys());
    const unsent = [...SSE_EVENTS].filter((e) => !produced.has(e));
    expect(unsent).toEqual([]);
  });

  it('actually finds the producers (guards the regex itself)', () => {
    // A regex that silently matched nothing would make both tests above pass
    // forever. These three are load-bearing and cannot go away quietly.
    const produced = producedEvents();
    for (const event of ['done', 'state', 'text_done']) {
      expect(produced.get(event)?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
