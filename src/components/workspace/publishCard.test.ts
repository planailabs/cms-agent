import { describe, expect, it } from 'vitest';
import {
  publishCardReducer,
  MAX_PUBLISH_LOG_LINES,
  type PublishCardState,
} from './publishCard';

describe('publishCardReducer', () => {
  it('start → log → done(ok) produces a succeeded card with the log', () => {
    let s = publishCardReducer(null, { type: 'start', sha: 'abc123', publicationId: 'p1' });
    s = publishCardReducer(s, { type: 'log', publicationId: 'p1', line: 'building…' });
    s = publishCardReducer(s, { type: 'log', publicationId: 'p1', line: 'deploying…' });
    s = publishCardReducer(s, { type: 'done', publicationId: 'p1', ok: true, sha: 'abc123' });

    expect(s).toMatchObject({
      sha: 'abc123',
      publicationId: 'p1',
      lines: ['building…', 'deploying…'],
      status: 'succeeded',
    });
  });

  it('done(!ok) records the error for retry', () => {
    let s = publishCardReducer(null, { type: 'start', sha: 'abc123' });
    s = publishCardReducer(s, { type: 'done', publicationId: 'p2', ok: false, error: 'boom' });
    expect(s?.status).toBe('failed');
    expect(s?.error).toBe('boom');
    expect(s?.sha).toBe('abc123'); // retry re-uses the same sha
  });

  it('ignores events from a different publication', () => {
    const s = publishCardReducer(null, { type: 'start', sha: 'a', publicationId: 'p1' })!;
    expect(publishCardReducer(s, { type: 'log', publicationId: 'px', line: 'x' })).toBe(s);
    expect(publishCardReducer(s, { type: 'done', publicationId: 'px', ok: true })).toBe(s);
  });

  it('adopts a publication started elsewhere (no local start)', () => {
    const s = publishCardReducer(null, { type: 'log', publicationId: 'p9', line: 'hello' });
    expect(s).toMatchObject({ publicationId: 'p9', lines: ['hello'], status: 'running' });
  });

  it('caps the log length', () => {
    let s: PublishCardState | null = publishCardReducer(null, {
      type: 'start',
      sha: 'a',
      publicationId: 'p1',
    });
    for (let i = 0; i < MAX_PUBLISH_LOG_LINES + 10; i++) {
      s = publishCardReducer(s, { type: 'log', publicationId: 'p1', line: `l${i}` });
    }
    expect(s?.lines.length).toBe(MAX_PUBLISH_LOG_LINES);
    expect(s?.lines[s.lines.length - 1]).toBe(`l${MAX_PUBLISH_LOG_LINES + 9}`);
  });
});
