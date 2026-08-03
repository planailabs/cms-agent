/**
 * applyChatState — the client side of the streamed-state model: plain
 * replacement, stale-seq drop, restore staleGuard, sidebar effects, and the
 * emergent publish-card/diff behaviors the deleted legacy handlers used to
 * special-case.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '@/components/chat/app/store';
import { createInitialWorkspaceState, promptDismissed } from '@/components/workspace/state';
import {
  applyChatState,
  type ChatStateSnapshot,
} from '@/components/chat/actions/chat/session';

const snap = (over: Partial<ChatStateSnapshot> = {}): ChatStateSnapshot => ({
  seq: 1,
  epoch: 'e1',
  chatId: 'chat-1',
  title: 'Chat one',
  kind: 'workflow',
  archived: false,
  workflowPhase: 'execute',
  branchId: 'branch-1',
  workBranch: 'c-one',
  planJson: { summary: 'plan' },
  executionSha: 'sha1',
  executions: [{ sha: 'sha1', summary: 'first', revertedBySha: null }],
  publication: null,
  automatism: null,
  targetAhead: true,
  tabs: null,
  turnPhase: 'idle',
  canResume: false,
  pendingQuestion: null,
  lastError: null,
  ...over,
});

beforeEach(() => {
  store.state.activeChatId = 'chat-1';
  store.state.workflowPhase = 'plan';
  store.state.branches = [
    {
      id: 'branch-1',
      name: 'main',
      chats: [{ id: 'chat-1', title: 'old', workflowPhase: 'plan' } as never],
    } as never,
  ];
  store.state.workspace = createInitialWorkspaceState();
});

describe('applyChatState', () => {
  it('applies a snapshot by plain replacement', () => {
    // distinct epoch per test — the module-level guard map persists
    applyChatState(snap({ epoch: 'apply-test' }));
    expect(store.state.workflowPhase).toBe('execute');
    expect(store.state.activeBranchId).toBe('branch-1');
    expect(store.state.workspace.plan).toEqual({ summary: 'plan' });
    expect(store.state.workspace.executionSha).toBe('sha1');
    expect(store.state.workspace.executions).toEqual([{ sha: 'sha1', summary: 'first' }]);
    expect(store.state.workspace.targetAhead).toBe(true);
    // publish card null when no publication (plan-round reset is emergent)
    expect(store.state.workspace.publish).toBeNull();
    // sidebar summary follows
    expect(store.state.branches[0].chats[0].title).toBe('Chat one');
    expect(store.state.branches[0].chats[0].workflowPhase).toBe('execute');
  });

  it('drops stale seq within an epoch, accepts a new epoch', () => {
    applyChatState(snap({ epoch: 'stale-test', seq: 5, title: 'Five' }));
    applyChatState(snap({ epoch: 'stale-test', seq: 4, title: 'Four' }));
    expect(store.state.activeChatTitle).toBe('Five');
    applyChatState(snap({ epoch: 'stale-test-2', seq: 1, title: 'Restarted' }));
    expect(store.state.activeChatTitle).toBe('Restarted');
  });

  it('skips a seq-0 restore snapshot when live events overtook the fetch', () => {
    applyChatState(snap({ epoch: 'guard-test', seq: 7, title: 'Live' }));
    // history fetched at seq 3, applied after live seq 7 → stale, skipped
    applyChatState(snap({ seq: 0, title: 'Stale history' }), undefined, { staleGuard: 3 });
    expect(store.state.activeChatTitle).toBe('Live');
    // resync (no staleGuard): seq-0 snapshot applies server-wins
    applyChatState(snap({ seq: 0, title: 'Resync' }));
    expect(store.state.activeChatTitle).toBe('Resync');
  });

  it('splices archived chats out of the sidebar', () => {
    applyChatState(snap({ epoch: 'archive-test', archived: true }));
    expect(store.state.branches[0].chats).toHaveLength(0);
    expect(store.state.activeChatArchived).toBe(true);
  });

  it('resets the diff viewer only when the phase changes', () => {
    applyChatState(snap({ epoch: 'diff-test', seq: 1 }));
    store.state.workspace.diff.loaded = true;
    applyChatState(snap({ epoch: 'diff-test', seq: 2 })); // same phase
    expect(store.state.workspace.diff.loaded).toBe(true);
    applyChatState(snap({ epoch: 'diff-test', seq: 3, workflowPhase: 'preview' }));
    expect(store.state.workspace.diff.loaded).toBe(false);
  });

  it('routes tabs only to the owning user and never to own echoes', async () => {
    const { TABS_CLIENT_ID } = await import('@/components/workspace/tabsSync');
    store.state.user = { id: 'u1' } as never;
    const settle = () => new Promise((r) => setTimeout(r, 10));

    // another user's tabs — ignored
    applyChatState(
      snap({ epoch: 'tabs-1', tabs: { tabs: ['/a/'], activeIndex: 0, byUserId: 'u2' } }),
    );
    await settle();
    expect(store.state.workspace.previewTabs).toEqual(['/']);

    // own echo (same clientId) — ignored
    applyChatState(
      snap({ epoch: 'tabs-2', tabs: { tabs: ['/b/'], activeIndex: 0, byUserId: 'u1' } }),
      TABS_CLIENT_ID,
    );
    await settle();
    expect(store.state.workspace.previewTabs).toEqual(['/']);

    // own user, other session — applied
    applyChatState(
      snap({ epoch: 'tabs-3', tabs: { tabs: ['/c/', '/d/'], activeIndex: 1, byUserId: 'u1' } }),
      'another-session',
    );
    await settle();
    expect(store.state.workspace.previewTabs).toEqual(['/c/', '/d/']);
    expect(store.state.workspace.activeTabIndex).toBe(1);
    expect(store.state.workspace.previewRoute).toBe('/d/');
  });

  it('derives the remote turn state without downgrading optimistic waiting', () => {
    const mc = { phase: 'idle', messages: [] } as never as NonNullable<
      NonNullable<typeof store.state.chat>['aiChat']
    >;
    store.state.chat = { aiChat: mc } as never;

    // pending question → question card (prompt from the snapshot)
    applyChatState(
      snap({
        epoch: 'turn-1',
        seq: 1,
        turnPhase: 'waiting_for_answer',
        pendingQuestion: { toolName: 'propose_plan', input: { summary: 's' } },
      }),
    );
    expect(mc.phase).toBe('question');
    expect(mc.clientPrompt?.toolName).toBe('propose_plan');

    // resolved elsewhere → back to idle, prompt cleared
    applyChatState(snap({ epoch: 'turn-1', seq: 2 }));
    expect(mc.phase).toBe('idle');
    expect(mc.clientPrompt).toBeUndefined();

    // persisted failure → error with message
    applyChatState(snap({ epoch: 'turn-1', seq: 3, lastError: 'boom' }));
    expect(mc.phase).toBe('error');
    expect(mc.error).toBe('boom');

    // crash recovery: tool_pending with no client turn in flight → Continue
    applyChatState(snap({ epoch: 'turn-1', seq: 4 }));
    applyChatState(
      snap({ epoch: 'turn-1', seq: 5, turnPhase: 'tool_pending', canResume: true }),
    );
    expect(mc.canContinue).toBe(true);

    // A model request interrupted by a restart is equally resumable.
    applyChatState(
      snap({ epoch: 'turn-1', seq: 6, turnPhase: 'running', canResume: true }),
    );
    expect(mc.phase).toBe('idle');
    expect(mc.canContinue).toBe(true);

    // A live server-owned tool call is not an interruption.
    mc.phase = 'tool';
    applyChatState(
      snap({ epoch: 'turn-1', seq: 7, turnPhase: 'tool_pending', canResume: false }),
    );
    expect(mc.phase).toBe('tool');
    expect(mc.canContinue).toBe(false);

    // optimistic waiting is never downgraded by an idle snapshot…
    mc.phase = 'waiting' as typeof mc.phase;
    applyChatState(snap({ epoch: 'turn-1', seq: 8 }));
    expect(mc.phase).toBe('waiting');

    // …EXCEPT on reconnect resync (a lost 'done' must not spin forever)
    applyChatState(snap({ epoch: 'turn-1', seq: 9 }), undefined, {
      allowIdleDowngrade: true,
    });
    expect(mc.phase).toBe('idle');
  });

  it('keeps a dismissed card dismissed across snapshots, but not across prompts', () => {
    const mc = { phase: 'idle', messages: [] } as never as NonNullable<
      NonNullable<typeof store.state.chat>['aiChat']
    >;
    store.state.chat = { aiChat: mc } as never;
    const pending = {
      epoch: 'dismiss-test',
      turnPhase: 'waiting_for_answer' as const,
      pendingQuestion: { toolName: 'finish_execution', input: { summary: 'done' } },
    };

    applyChatState(snap({ ...pending, seq: 1 }));
    const dismissed = () =>
      promptDismissed('finish_execution', store.state.activeChatId, store.state.workspace);
    expect(dismissed()).toBe(false);

    // "Not yet — keep chatting" (workspace/actions.dismissFinishExecution):
    // the composer takes the card's place. Snapshots rebuild clientPrompt and
    // transitions clear it, so the decision is recorded outside both — any
    // later state event used to put the card back over the composer.
    store.state.workspace.dismissedPrompt = {
      chatId: 'chat-1',
      toolName: 'finish_execution',
    };
    applyChatState(snap({ ...pending, seq: 2 }));
    expect(dismissed()).toBe(true);

    // A DIFFERENT question is a new decision — never pre-dismissed.
    applyChatState(
      snap({
        ...pending,
        seq: 3,
        pendingQuestion: { toolName: 'ask_question', input: { question: 'which?' } },
      }),
    );
    expect(mc.clientPrompt?.toolName).toBe('ask_question');
    expect(store.state.workspace.dismissedPrompt).toBeNull();

    // …and so is the same card coming back after the question was resolved.
    store.state.workspace.dismissedPrompt = { chatId: 'chat-1', toolName: 'finish_execution' };
    applyChatState(snap({ epoch: 'dismiss-test', seq: 4 })); // idle, nothing pending
    expect(store.state.workspace.dismissedPrompt).toBeNull();
  });

  it('drops stale sequenced snapshots entirely (sidebar included)', () => {
    applyChatState(snap({ epoch: 'stale-side', seq: 5, title: 'Fresh' }));
    applyChatState(snap({ epoch: 'stale-side', seq: 3, title: 'Old' }));
    expect(store.state.branches[0].chats[0].title).toBe('Fresh');
  });

  it('ignores snapshots for chats that are not active beyond sidebar sync', () => {
    store.state.activeChatId = 'other-chat';
    applyChatState(snap({ epoch: 'inactive-test', title: 'Renamed' }));
    expect(store.state.branches[0].chats[0].title).toBe('Renamed'); // sidebar yes
    expect(store.state.workflowPhase).toBe('plan'); // active state untouched
  });
});
