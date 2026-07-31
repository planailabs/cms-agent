/**
 * Draft chats: "new chat" opens an empty conversation with no Chat row, and
 * the first message creates it. Plus the warm-spare branch a created chat
 * adopts instead of waiting for a cold worktree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureBranch: vi.fn(async (_branch: string, _base?: string) => {}),
  branchExists: vi.fn(async (_branch: string) => true),
  ensureInstance: vi.fn(async (_branch: string) => ({})),
  pinBranch: vi.fn((_branch: string) => {}),
  unpinBranch: vi.fn((_branch: string) => {}),
  pinned: [] as string[],
  postMessage: vi.fn(),
}));
const { branchExists, ensureBranch, ensureInstance, pinBranch, unpinBranch, postMessage } = mocks;

vi.mock('@/lib/git/engine', () => ({
  defaultBranch: async () => 'main',
  ensureBranch: mocks.ensureBranch,
  // The warmer asks before it warms: a Branch row whose ref is gone must not
  // be recreated by warming it.
  branchExists: mocks.branchExists,
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
import { renderRail } from '@/components/workspace/rail';
import { canEnterEditMode, renderPreviewToolbar } from '@/components/workspace/preview';
import {
  clearAttachments,
  getStagedAttachments,
  stageFiles,
} from '@/components/chat/actions/chat/attachments';
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

  afterEach(() => {
    clearAttachments();
    vi.unstubAllGlobals();
  });

  it('opens with no chat row behind it', () => {
    startDraftChat('b1');

    expect(store.state.activeChatId).toBeNull();
    expect(store.state.activeBranchId).toBe('b1');
    expect(store.state.workflowPhase).toBe('plan');
    // The composer needs its container, empty — that is the first-run view.
    expect(store.state.chat?.aiChat?.messages).toEqual([]);
  });

  it('keeps preview tools enabled before the chat gets a work branch', () => {
    startDraftChat('b1');

    expect(canEnterEditMode(store.state)).toBe(true);
    const rail = renderRail(store.state);
    for (const action of ['ws-edit-mode', 'ws-element-pick']) {
      expect(rail.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0]).not.toContain(
        'disabled',
      );
    }
  });

  it('splits edit controls between the rail flyout and toolbar', () => {
    startDraftChat('b1');
    store.state.workspace.elementEdit.active = true;
    store.state.workspace.elementEdit.tool = 'swap';
    store.state.workspace.elementEdit.undoDepth = 2;

    const rail = renderRail(store.state);
    expect(rail).toContain('ws-edit-menu');
    expect(rail).toContain('ws-edit-menu__item is-active');
    for (const action of ['ws-edit-tool', 'ws-edit-exit']) {
      expect(rail).toContain(`data-action="${action}"`);
    }
    expect(rail).not.toContain('data-action="ws-edit-undo"');
    expect(rail).not.toContain('data-action="ws-edit-clear"');

    const toolbar = renderPreviewToolbar(store.state);
    expect(toolbar).toContain('class="ws-mini-button is-active" data-edit-active-tool="swap"');
    expect(toolbar).toContain('data-action="ws-edit-undo"');
    expect(toolbar).toContain('data-action="ws-edit-clear"');
    expect(toolbar).toContain('data-action="ws-edit-clear"><svg');
    expect(toolbar).toContain('Undo all');
    expect(toolbar).toContain('data-action="ws-edit-handoff"');

    store.state.workspace.elementEdit.undoDepth = 0;
    expect(renderPreviewToolbar(store.state)).not.toContain('data-action="ws-edit-undo"');
    store.state.workspace.elementEdit.undoDepth = 1;
    expect(renderPreviewToolbar(store.state)).toContain('data-action="ws-edit-undo"');
    expect(renderPreviewToolbar(store.state)).not.toContain('data-action="ws-edit-clear"');
    store.state.workspace.elementEdit.canRedo = true;
    expect(renderPreviewToolbar(store.state)).toContain('data-action="ws-edit-redo"><svg');

    store.state.workspace.elementEdit.active = false;
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

  it('creates the chat before uploading the first attachment', async () => {
    startDraftChat('b1');
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/chats'
        ? Response.json({ chat: { id: 'chat-new', title: 'New chat', workflowPhase: 'plan' } })
        : Response.json({ upload: { id: 'upload-1' } }, { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await stageFiles([new File(['hello'], 'notes.md', { type: 'text/plain' })]);
    await vi.waitFor(() => expect(getStagedAttachments()[0]?.status).toBe('ready'));

    expect(store.state.activeChatId).toBe('chat-new');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/chats', '/api/uploads']);
  });

  // The composer's change handler calls stageFiles and then resets
  // input.value to allow re-picking the same file — which empties the LIVE
  // FileList it just handed over. From a draft the chat is created first, so
  // the loop ran after that reset and staged nothing: the chat appeared, the
  // chip never did, and the file was silently dropped.
  it('keeps the picked file when the input is reset before the chat exists', async () => {
    startDraftChat('b1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/chats'
          ? Response.json({ chat: { id: 'chat-new', title: 'New chat', workflowPhase: 'plan' } })
          : Response.json({ upload: { id: 'upload-1' } }, { status: 201 }),
      ),
    );

    const live = [new File(['hello'], 'notes.md', { type: 'text/plain' })];
    const staging = stageFiles(live);
    live.length = 0; // input.value = '' — the FileList empties in place
    await staging;

    await vi.waitFor(() => expect(getStagedAttachments()[0]?.status).toBe('ready'));
    expect(getStagedAttachments().map((a) => a.filename)).toEqual(['notes.md']);
  });

  it('does not hijack a chat the user switched to mid-creation', async () => {
    startDraftChat('b1');
    const draft = store.state.chat!.aiChat!;
    // The create round trip resolves only after the user opened another chat.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        store.state.activeChatId = 'chat-user-opened';
        store.state.chat = { ...store.state.chat!, aiChat: { messages: [], phase: 'idle' } };
        return Response.json({ chat: { id: 'chat-late', title: 'New chat' } });
      }),
    );

    await sendChatMessage('hello');

    expect(store.state.activeChatId).toBe('chat-user-opened');
    expect(postMessage).not.toHaveBeenCalled();
    expect(draft.messages).toEqual([]); // the abandoned draft is left alone
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

  it('never warms a Branch row whose git ref is gone — warming would recreate it', async () => {
    await prisma.branch.upsert({ where: { name: 'main' }, update: {}, create: { name: 'main' } });
    await prisma.branch.upsert({
      where: { name: 'deleted-in-repo' },
      update: {},
      create: { name: 'deleted-in-repo' },
    });
    // The branch was deleted in the repo; the row has not been reconciled yet.
    branchExists.mockImplementation(async (b: string) => b !== 'deleted-in-repo');
    ensureInstance.mockClear();
    pinBranch.mockClear();

    await warmPrimaryBranches();

    // ensureInstance → ensureWorktree → ensureBranch would resurrect the ref,
    // and the ghost branch would then have a preview of its own.
    expect(ensureInstance.mock.calls.map((c) => c[0])).not.toContain('deleted-in-repo');
    expect(pinBranch.mock.calls.map((c) => c[0])).not.toContain('deleted-in-repo');
    expect(ensureInstance.mock.calls.map((c) => c[0])).toContain('main');

    branchExists.mockImplementation(async () => true);
    await prisma.branch.delete({ where: { name: 'deleted-in-repo' } });
  });

  it('drops the pin when a branch goes away', async () => {
    mocks.pinned = ['main', 'deleted-branch'];
    await warmPrimaryBranches();
    expect(unpinBranch).toHaveBeenCalledWith('deleted-branch');
    expect(unpinBranch).not.toHaveBeenCalledWith('main');
  });
});
