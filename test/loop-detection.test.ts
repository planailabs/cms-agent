/**
 * Tool-call loop detection: 3 identical (name, args) calls within the last
 * 5 flag a loop; interleaved distinct calls and key-order differences behave
 * as expected.
 */
import { describe, expect, it } from 'vitest';
import { createLoopDetector } from '@/lib/agent/toolLoop';

describe('createLoopDetector', () => {
  it('flags the 3rd identical consecutive call', () => {
    const detect = createLoopDetector();
    expect(detect('read_file', { path: 'a.md' })).toBeNull();
    expect(detect('read_file', { path: 'a.md' })).toBeNull();
    const warning = detect('read_file', { path: 'a.md' });
    expect(warning).toMatch(/Loop detected/);
    expect(JSON.parse(warning!).error).toContain('read_file');
  });

  it('catches A-B-A-B-A alternation', () => {
    const detect = createLoopDetector();
    expect(detect('read_file', { path: 'a' })).toBeNull();
    expect(detect('grep', { pattern: 'x' })).toBeNull();
    expect(detect('read_file', { path: 'a' })).toBeNull();
    expect(detect('grep', { pattern: 'x' })).toBeNull();
    expect(detect('read_file', { path: 'a' })).toMatch(/Loop detected/);
  });

  it('is argument-key-order independent', () => {
    const detect = createLoopDetector();
    detect('edit_file', { path: 'a', oldText: 'x' });
    detect('edit_file', { oldText: 'x', path: 'a' });
    expect(detect('edit_file', { path: 'a', oldText: 'x' })).toMatch(/Loop detected/);
  });

  it('does not flag identical calls spread beyond the window', () => {
    const detect = createLoopDetector();
    expect(detect('read_file', { path: 'a' })).toBeNull();
    for (let i = 0; i < 4; i++) expect(detect('list_dir', { path: `${i}` })).toBeNull();
    // first 'a' read has left the 5-call window
    expect(detect('read_file', { path: 'a' })).toBeNull();
    for (let i = 0; i < 4; i++) expect(detect('list_dir', { path: `x${i}` })).toBeNull();
    expect(detect('read_file', { path: 'a' })).toBeNull();
  });

  it('distinguishes different arguments and tools', () => {
    const detect = createLoopDetector();
    expect(detect('read_file', { path: 'a' })).toBeNull();
    expect(detect('read_file', { path: 'b' })).toBeNull();
    expect(detect('grep', { path: 'a' })).toBeNull();
    expect(detect('read_file', { path: 'a' })).toBeNull();
  });
});
