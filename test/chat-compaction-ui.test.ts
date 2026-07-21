import { describe, expect, it } from 'vitest';
import { renderMessageBubbles } from '@/components/chat/ui/chat/bubbles';
import { renderCompactionIndicator } from '@/components/chat/ui/chat/indicators';

describe('chat compaction UI', () => {
  it('shows a durable summary card', () => {
    const html = renderMessageBubbles({
      phase: 'idle',
      messages: [{ role: 'compaction', content: '**Current state:** tests pass' }],
    });
    expect(html).toContain('data-card="compaction"');
    expect(html).toContain('Current state:');
    expect(html).toContain('tests pass');
  });

  it('shows background progress while compacting', () => {
    const html = renderCompactionIndicator({ phase: 'compacting', messages: [] });
    expect(html).toContain('Compacting');
    expect(html).toContain('animate-spin');
  });
});
