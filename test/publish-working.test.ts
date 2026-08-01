import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '@/components/chat/app/state';
import { store } from '@/components/chat/app/store';
import { publishAction } from '@/components/workspace/actions';

describe('publish working state', () => {
  beforeEach(() => {
    store.state = createInitialState();
    store.state.activeChatId = 'chat-1';
    store.state.workspace.executionSha = 'abc123';
    store.state.chat = { aiChat: { phase: 'idle', messages: [] } } as never;
  });

  it('shows progress before the publish request finishes', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))));

    const publishing = publishAction();
    expect(store.state.workspace.publish).toMatchObject({ sha: 'abc123', status: 'running' });

    finish(
      new Response(JSON.stringify({ error: 'failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await publishing;
    expect(store.state.workspace.publish).toBeNull();
    vi.unstubAllGlobals();
  });
});
