/**
 * Chat Bubbles — renders user, assistant, and cancel message bubbles
 * for the AI chat conversation.
 */

import { escapeHtml } from '../../utils/html';
import { renderMarkdown } from '../../utils/markdown';

import type { ChatState } from '../../app/state';

type AiChat = NonNullable<ChatState['aiChat']>;

export const renderMessageBubbles = (mc: AiChat): string =>
  mc.messages
    .map((msg) => {
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
