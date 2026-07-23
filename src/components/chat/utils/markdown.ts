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

  // Open regular links in a new tab.
  const links = html.replace(
    /<a /g,
    '<a target="_blank" rel="noopener noreferrer" ',
  );
  return links.replace(
    /<a target="_blank" rel="noopener noreferrer" href="(\/work\/[^"]+)"([^>]*)>([\s\S]*?)<\/a>/g,
    '<a class="chat-code-link" data-action="chat-code-link" href="$1"$2>$3<svg aria-hidden="true" viewBox="0 0 16 16"><path d="m6 4-4 4 4 4m4-8 4 4-4 4m-1-10L7 14"/></svg></a>',
  );
};
