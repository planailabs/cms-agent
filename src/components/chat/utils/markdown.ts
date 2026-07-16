/**
 * Markdown Rendering for Chat Messages
 *
 * Uses `marked` to convert assistant markdown to sanitized HTML.
 * Only used for assistant messages — user messages remain plain text.
 */

import { Marked } from 'marked';

const marked = new Marked({
  breaks: true,
  gfm: true,
});

/**
 * Renders markdown to HTML.
 * Links open in a new tab with rel="noopener noreferrer".
 */
export const renderMarkdown = (text: string): string => {
  const html = marked.parse(text) as string;

  // Open links in new tab
  return html.replace(
    /<a /g,
    '<a target="_blank" rel="noopener noreferrer" ',
  );
};
