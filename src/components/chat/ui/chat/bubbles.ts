/**
 * Chat Bubbles — renders user, assistant, and cancel message bubbles
 * for the AI chat conversation.
 */

import { escapeHtml } from '../../utils/html';
import { renderMarkdown } from '../../utils/markdown';
import { renderExecutionCard } from './cards';

import type { ChatState } from '../../app/state';
import type { ExecutionCard } from '../../../workspace/state';

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

export const renderMessageBubbles = (mc: AiChat, executions: ExecutionCard[] = []): string =>
  mc.messages
    .map((msg) => {
      if (msg.role === 'tool' && msg.tool) {
        return renderToolCall(msg);
      }
      if (msg.role === 'execution') {
        // Inline committed-execution card; live state (busy/reverted) comes
        // from the workspace slice, keyed by sha
        const exec = executions.find((e) => e.sha === msg.sha);
        return exec ? renderExecutionCard(exec) : '';
      }
      if (msg.role === 'automatism') {
        // Agent-less flow event — rendered as a system event card
        return `
            <div class="chat-automatism">
              <div class="chat-automatism__head">⚙ Automatism</div>
              <pre class="chat-automatism__body">${escapeHtml(msg.content)}</pre>
            </div>
          `;
      }
      if (msg.role === 'cancel') {
        return `
            <div class="flex justify-end">
              <p class="max-w-[85%] rounded-2xl px-3.5 py-2 text-xs italic text-(--text-muted)">
                ${escapeHtml(msg.content)}
              </p>
            </div>
          `;
      }
      if (msg.role === 'user') {
        return `
            <div class="flex justify-end">
              <p class="max-w-[85%] rounded-2xl bg-(--surface-elevated) px-3.5 py-2 text-sm text-(--text-primary)">
                ${escapeHtml(msg.content)}
              </p>
            </div>
          `;
      }
      return `
          <div class="flex justify-start">
            <div class="chat-markdown max-w-full text-sm leading-relaxed text-(--text-primary)">
              ${renderMarkdown(msg.content)}
            </div>
          </div>
        `;
    })
    .join('');
