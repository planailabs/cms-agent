/**
 * Draft chats: "new chat" opens an empty conversation with no Chat row, and
 * the first message creates it. Plus the warm-spare branch a created chat
 * adopts instead of waiting for a cold worktree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureBranch: vi.fn(async (_branch: string, _base?: string) => {}),
  ensureInstance: vi.fn(async (_branch: string) => ({})),
  pinBranch: vi.fn((_branch: string) => {}),
  unpinBranch: vi.fn((_branch: string) => {}),
  pinned: [] as string[],
  postMessage: vi.fn(),
}));
const { ensureBranch, ensureInstance, pinBranch, unpinBranch, postMessage } = mocks;

vi.mock('@/lib/git/engine', () => ({
  defaultBranch: async () => 'main',
  ensureBranch: mocks.ensureBranch,
}));
vi.mock('@/lib/preview/manager', () => ({
  ensureInstance: mocks.ensureInstance,
  isInstanceActive: () => false,
  pinBranch: mocks.pinBranch,
  unpinBranch: mocks.unpinBranch,
  pinnedBranches: () => mocks.pinned,
}));
vi.mock('@/components/chat/actions/chat/sse', () => ({
  connectEvents: vi.fn(async () => {}),
  disconnectEvents: vi.fn(),
  postMessage: mocks.postMessage,
}));

import { store } from '@/components/chat/app/store';
import { startDraftChat } from '@/components/chat/actions/chat';
import { sendChatMessage } from '@/components/chat/actions/chat/stateMachine';
import {
  claimWorkBranch,
  ensureSpareBranch,
  resetPrewarmForTests,
  warmPrimaryBranches,
} from '@/lib/preview/prewarm';
import { prisma } from '@/lib/db';

describe('draft chat', () => {
  beforeEach(() => {
    // The composer's chip sync touches the DOM; nothing here renders, so a
    // querySelector that finds nothing is enough (no jsdom in this suite).
    vi.stubGlobal('document', {
      querySelector: () => null,
      documentElement: { lang: 'en' },
    });
    store.state.branches = [{ id: 'b1', name: 'main', chats: [] }];
    store.state.activeChatId = 'old-chat';
    postMessage.mockClear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('opens with no chat row behind it', () => {
    startDraftChat('b1');

    expect(store.state.activeChatId).toBeNull();
    expect(store.state.activeBranchId).toBe('b1');
    expect(store.state.workflowPhase).toBe('plan');
    // The composer needs its container, empty — that is the first-run view.
    expect(store.state.chat?.aiChat?.messages).toEqual([]);
  });

  it('creates the chat on the first message, then sends it', async () => {
    startDraftChat('b1');
    const fetchMock = vi.fn(async () =>
      Response.json({ chat: { id: 'chat-new', title: 'New chat', workflowPhase: 'plan' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendChatMessage('make the footer bigger');

    expect(fetchMock).toHaveBeenCalledWith('/api/chats', expect.objectContaining({ method: 'POST' }));
    expect(store.state.activeChatId).toBe('chat-new');
    // The typed message survives the creation round trip.
    expect(store.state.chat?.aiChat?.messages.at(-1)?.content).toBe('make the footer bigger');
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', text: 'make the footer bigger' }),
    );
  });

  it('keeps the draft when the chat cannot be created', async () => {
    startDraftChat('b1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    await sendChatMessage('hello');

    expect(store.state.activeChatId).toBeNull();
    expect(store.state.chat?.aiChat?.phase).toBe('error');
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('pre-warmed work branch', () => {
  beforeEach(() => {
    resetPrewarmForTests();
    ensureBranch.mockClear();
    ensureInstance.mockClear();
  });

  it('adopts the warm branch for a chat on the default branch', async () => {
    ensureSpareBranch();
    await vi.waitFor(() => expect(ensureInstance).toHaveBeenCalled());
    const warmed = ensureInstance.mock.calls[0][0];
    expect(warmed).toMatch(/^c-[0-9a-f]{12}$/);
    expect(ensureBranch).toHaveBeenCalledWith(warmed, 'main');

    expect(await claimWorkBranch('main')).toBe(warmed);
    // Claiming starts the next one rather than handing the same branch twice.
    await vi.waitFor(() => expect(ensureInstance).toHaveBeenCalledTimes(2));
    expect(await claimWorkBranch('main')).not.toBe(warmed);
  });

  it('never hands a main-based spare to a chat targeting another branch', async () => {
    ensureSpareBranch();
    await vi.waitFor(() => expect(ensureInstance).toHaveBeenCalled());
    const warmed = ensureInstance.mock.calls[0][0];

    const claimed = await claimWorkBranch('release');
    expect(claimed).not.toBe(warmed);
    expect(claimed).toMatch(/^c-[0-9a-f]{12}$/);
    // The spare stays available for the next default-branch chat.
    expect(await claimWorkBranch('main')).toBe(warmed);
  });
});

describe('primary branch warmer', () => {
  beforeEach(() => {
    resetPrewarmForTests();
    ensureInstance.mockClear();
    pinBranch.mockClear();
    unpinBranch.mockClear();
    mocks.pinned = [];
  });

  it('pins and starts every branch a chat can be created from', async () => {
    await prisma.branch.upsert({
      where: { name: 'main' },
      update: {},
      create: { name: 'main' },
    });
    await prisma.branch.upsert({
      where: { name: 'warm-release' },
      update: {},
      create: { name: 'warm-release' },
    });

    await warmPrimaryBranches();

    const started = ensureInstance.mock.calls.map((c) => c[0]);
    expect(started).toContain('main');
    expect(started).toContain('warm-release');
    expect(pinBranch.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(started));
    // Work branches are not primary — they warm through the spare instead.
    expect(started.some((b) => b.startsWith('c-'))).toBe(false);

    await prisma.branch.delete({ where: { name: 'warm-release' } });
  });

  it('drops the pin when a branch goes away', async () => {
    mocks.pinned = ['main', 'deleted-branch'];
    await warmPrimaryBranches();
    expect(unpinBranch).toHaveBeenCalledWith('deleted-branch');
    expect(unpinBranch).not.toHaveBeenCalledWith('main');
  });
});
