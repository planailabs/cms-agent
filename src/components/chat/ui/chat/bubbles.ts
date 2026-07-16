/**
 * Chat Bubbles — renders user, assistant, and cancel message bubbles
 * for the AI chat conversation.
 */

import { escapeHtml } from '../../utils/html';
import { renderMarkdown } from '../../utils/markdown';

import type { ChatState } from '../../app/state';

type AiChat = NonNullable<ChatState['aiChat']>;

const renderToolCall = (msg: AiChat['messages'][number]): string => {
  const tool = msg.tool!;
  const input = tool.input !== undefined ? JSON.stringify(tool.input, null, 2) : '';
  const status = tool.running ? '<span class="animate-pulse">running…</span>' : '';
  return `
      <details class="group my-1 text-xs text-(--text-muted)">
        <summary class="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-(--surface-elevated)">
          <span class="opacity-70">⚙</span>
          <code class="font-mono">${escapeHtml(tool.name)}</code>
          ${status}
          <span class="ml-auto opacity-50 transition-transform group-open:rotate-90">›</span>
        </summary>
        <div class="ml-4 mt-1 space-y-1 border-l border-(--border-muted) pl-3">
          ${input ? `<pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">${escapeHtml(input.slice(0, 2000))}</pre>` : ''}
          ${tool.result ? `<pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] opacity-80">→ ${escapeHtml(tool.result)}</pre>` : ''}
        </div>
      </details>
    `;
};

export const renderMessageBubbles = (mc: AiChat): string =>
  mc.messages
    .map((msg) => {
      if (msg.role === 'tool' && msg.tool) {
        return renderToolCall(msg);
      }
      if (msg.role === 'cancel') {
        return `
            <div class="flex justify-end">
              <p class="max-w-[min(100%,640px)] rounded-3xl px-5 py-3 text-sm italic text-(--text-muted)">
                ${escapeHtml(msg.content)}
              </p>
            </div>
          `;
      }
      if (msg.role === 'user') {
        return `
            <div class="flex justify-end">
              <p class="max-w-[min(100%,640px)] rounded-3xl bg-(--surface-elevated) px-5 py-3 text-base text-(--text-primary)">
                ${escapeHtml(msg.content)}
              </p>
            </div>
          `;
      }
      return `
          <div class="flex justify-start">
            <div class="chat-markdown max-w-[min(100%,640px)] text-base leading-relaxed text-(--text-primary)">
              ${renderMarkdown(msg.content)}
            </div>
          </div>
        `;
    })
    .join('');
