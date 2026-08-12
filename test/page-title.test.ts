/**
 * The tab title as a progress indicator.
 *
 * The behavior worth pinning is the sticky one: "Done" is for the tab nobody
 * is looking at, and looking at it is what clears it. Get that wrong in
 * either direction and the title either never reports the end of a turn, or
 * reports it forever.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '@/components/chat/app/store';
import { APP_NAME } from '@/components/chat/constants';

/** Minimal document: the watcher only reads `hidden`, `title` and listeners. */
interface FakeDocument {
  hidden: boolean;
  title: string;
  listeners: Array<() => void>;
  addEventListener(type: string, fn: () => void): void;
  documentElement: { lang: string };
}

const installDocument = (): FakeDocument => {
  const doc: FakeDocument = {
    hidden: false,
    title: APP_NAME,
    listeners: [],
    addEventListener(_type, fn) {
      this.listeners.push(fn);
    },
    documentElement: { lang: 'en' },
  };
  (globalThis as { document?: unknown }).document = doc;
  return doc;
};

const setPhase = (phase: string): void => {
  store.state.chat = { aiChat: { phase, messages: [] } } as never;
  store.notify();
};

// One document for the suite: the watcher registers its visibilitychange
// listener once, and a fresh fake per test would leave it listening to a
// document nobody can reach.
const doc = installDocument();
let started = false;

beforeEach(async () => {
  doc.title = APP_NAME;
  store.state.activeChatId = 'chat-1';
  store.state.activeChatTitle = 'Rewrite the pricing page';
  store.state.branches = [];
  store.state.chat = null;
  if (!started) {
    // Imported after `document` exists — the watcher subscribes on start.
    const { startPageTitleWatcher } = await import('@/components/chat/ui/pageTitle');
    startPageTitleWatcher();
    started = true;
  }
  doc.hidden = false;
  store.notify();
});

describe('page title', () => {
  it('reports a running turn', () => {
    for (const phase of ['waiting', 'streaming', 'tool', 'compacting']) {
      setPhase(phase);
      expect(doc.title).toBe('● Working — Rewrite the pricing page');
    }
  });

  it('goes back to the app name for an idle chat', () => {
    setPhase('streaming');
    setPhase('idle');
    expect(doc.title).toBe(APP_NAME);
  });

  it('flags a turn that ended while the tab was in the background', () => {
    setPhase('streaming');
    doc.hidden = true;
    setPhase('idle');
    expect(doc.title).toBe('✓ Done — Rewrite the pricing page');
  });

  it('clears the flag the moment the tab is looked at', () => {
    setPhase('streaming');
    doc.hidden = true;
    setPhase('idle');
    doc.hidden = false;
    for (const listener of doc.listeners) listener(); // visibilitychange
    expect(doc.title).toBe(APP_NAME);
  });

  it('does not flag a turn the user watched finish', () => {
    setPhase('streaming');
    setPhase('idle'); // tab visible throughout
    expect(doc.title).toBe(APP_NAME);
  });

  /** A question is the turn ending too — it is exactly when you are needed. */
  it('flags a turn that ended on a question', () => {
    setPhase('streaming');
    doc.hidden = true;
    setPhase('question');
    expect(doc.title).toBe('✓ Done — Rewrite the pricing page');
  });

  it('prefers the live sidebar title, which the agent renames mid-turn', () => {
    store.state.branches = [
      {
        id: 'b1',
        name: 'main',
        chats: [{ id: 'chat-1', title: 'Pricing page rewrite', workflowPhase: 'plan', workBranch: 'c-1', createdBy: null }],
      },
    ];
    setPhase('streaming');
    expect(doc.title).toBe('● Working — Pricing page rewrite');
  });

  it('stays the plain app name when no chat is open', () => {
    store.state.activeChatId = null;
    store.state.activeChatTitle = null;
    setPhase('streaming');
    expect(doc.title).toBe(APP_NAME);
  });
});
