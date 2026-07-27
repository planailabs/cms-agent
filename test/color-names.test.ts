/** Hex → color-name chips in chat markdown. */
import { describe, expect, it } from 'vitest';
import {
  annotateColorsInHtml,
  colorName,
  parseHex,
} from '@/components/chat/utils/colorNames';
import { renderMarkdown } from '@/components/chat/utils/markdown';

describe('colorName', () => {
  it('parses #rgb and #rrggbb', () => {
    expect(parseHex('#fff')).toBe(0xffffff);
    expect(parseHex('#ff0000')).toBe(0xff0000);
    expect(parseHex('#zzz')).toBeNull();
  });

  it('names exact CSS keywords and marks near matches with ~', () => {
    expect(colorName('#ff0000')).toBe('red');
    expect(colorName('#008080')).toBe('teal');
    expect(colorName('#fe0102')).toBe('~red');
  });

  it('gives up on colors far from any keyword', () => {
    // A murky mid-tone nowhere near the keyword set stays hex-labeled
    expect(annotateColorsInHtml('x #7852ee y')).toContain('chat-color');
  });
});

describe('annotateColorsInHtml', () => {
  it('replaces hex in text but never inside tags/attributes', () => {
    const html = '<a href="#facade">link</a> uses #ff0000 and <code>#008080</code>';
    const out = annotateColorsInHtml(html);
    expect(out).toContain('href="#facade"');
    expect(out).toContain('>red</span>');
    expect(out).toContain('>teal</span>');
    expect(out).toContain('style="background:#ff0000"');
  });

  it('rides through renderMarkdown', () => {
    const out = renderMarkdown('The accent is `#ff0000` now.');
    expect(out).toContain('chat-color__swatch');
    expect(out).toContain('red');
  });
});
