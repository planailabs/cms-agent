/**
 * Chat Bubbles — renders user, assistant, and cancel message bubbles
 * for the AI chat conversation.
 */

import { escapeHtml } from '../../utils/html';
import { renderMessageBlocks } from './blocks';
import { renderMarkdown } from '../../utils/markdown';
import { renderExecutionCard } from './cards';
import { commandChipHtml } from './commands';
import { resolveTranslated, t, uiLocale } from '@/lib/i18n';

import type { ChatState } from '../../app/state';
import type { ExecutionCard } from '../../../workspace/state';

type AiChat = NonNullable<ChatState['aiChat']>;

/** Short right-aligned result preview for a tool row (mockup's meta slot). */
const toolMeta = (result: string | undefined): string => {
  const firstLine = (result ?? '').trim().split('\n', 1)[0] ?? '';
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
};

/** One tool row inside a group — mockup row (dot · name · meta), expandable
 *  to the existing input/result detail. */
const renderToolRow = (msg: AiChat['messages'][number]): string => {
  const tool = msg.tool!;
  const input =
    tool.input !== undefined ? JSON.stringify(tool.input, null, 2) : '';
  const meta = tool.running
    ? `<span class="chat-tools__meta animate-pulse">${escapeHtml(t(uiLocale(), 'chat.toolRunning'))}</span>`
    : `<span class="chat-tools__meta" title="${escapeHtml(toolMeta(tool.result))}">${escapeHtml(toolMeta(tool.result))}</span>`;
  return `<details class="chat-tools__item">
      <summary class="chat-tools__row">
        <span class="chat-tools__dot ${tool.running ? 'is-running' : ''}" aria-hidden="true"></span>
        <code class="chat-tools__name ws-mono">${escapeHtml(tool.name)}</code>
        ${meta}
      </summary>
      <div class="chat-tools__detail">
        ${input ? `<pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">${escapeHtml(input.slice(0, 2000))}</pre>` : ''}
        ${tool.result ? `<pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] opacity-80">→ ${escapeHtml(tool.result)}</pre>` : ''}
      </div>
    </details>`;
};

/** Consecutive tool calls collapse into ONE group (mockup layout): a summary
 *  row with caret + "N tool calls · done/running", expanding to the rows. A
 *  group with a running call renders open so progress stays visible. */
const renderToolGroup = (msgs: Array<AiChat['messages'][number]>): string => {
  const locale = uiLocale();
  const running = msgs.some((m) => m.tool!.running);
  const status = running
    ? `<span class="animate-pulse">${escapeHtml(t(locale, 'chat.tools.running'))}</span>`
    : escapeHtml(t(locale, 'chat.tools.done'));
  return `<details class="chat-tools" ${running ? 'open' : ''}>
      <summary class="chat-tools__summary">
        <span class="chat-tools__caret" aria-hidden="true">›</span>
        <span class="chat-tools__label ws-mono">${escapeHtml(
          msgs.length === 1
            ? t(locale, 'chat.tools.groupOne')
            : t(locale, 'chat.tools.group', { count: String(msgs.length) }),
        )} · ${status}</span>
      </summary>
      <div class="chat-tools__list">${msgs.map(renderToolRow).join('')}</div>
    </details>`;
};

export const renderMessageBubbles = (
  mc: AiChat,
  executions: ExecutionCard[] = [],
  showToolCalls = false,
): string => {
  // Consecutive tool messages render as one collapsed group.
  const parts: string[] = [];
  let toolRun: Array<AiChat['messages'][number]> = [];
  const flushTools = (): void => {
    if (toolRun.length > 0) parts.push(renderToolGroup(toolRun));
    toolRun = [];
  };
  for (const msg of mc.messages) {
    if (msg.role === 'tool' && msg.tool) {
      if (showToolCalls) toolRun.push(msg);
      continue;
    }
    flushTools();
    parts.push(renderMessage(msg, executions));
  }
  flushTools();
  return parts.join('');
};

const renderMessage = (
  msg: AiChat['messages'][number],
  executions: ExecutionCard[],
): string => {
  if (msg.role === 'execution') {
    // Inline committed-execution card; live state (busy/reverted) comes
    // from the workspace slice, keyed by sha
    const exec = executions.find((e) => e.sha === msg.sha);
    return exec ? renderExecutionCard(exec) : '';
  }
  if (msg.role === 'compaction') {
    return `<div class="ws-card ws-card--muted" data-card="compaction">
            <div class="ws-card__header">
              <span class="ws-card__title">${escapeHtml(t(uiLocale(), 'chat.compaction.title'))}</span>
            </div>
            <div class="chat-markdown ws-card__summary">${renderMarkdown(msg.content)}</div>
          </div>`;
  }
  if (msg.role === 'automatism') {
    // Agent-less flow event — rendered as a system event card, localized
    // via its TranslatedMessage container (English content as fallback)
    const locale = uiLocale();
    const text = msg.tm ? resolveTranslated(locale, msg.tm) : msg.content;
    return `
            <div class="chat-automatism">
              <div class="chat-automatism__head">⚙ ${escapeHtml(t(locale, 'chat.automatismHead'))}</div>
              <pre class="chat-automatism__body">${escapeHtml(text)}</pre>
            </div>
          `;
  }
  if (msg.role === 'cancel') {
    // Server-written notes (a stopped turn) travel as a TranslatedMessage;
    // rows the browser wrote are already in the viewer's language.
    const text = msg.tm ? resolveTranslated(uiLocale(), msg.tm) : msg.content;
    return `
            <div class="flex justify-end">
              <p class="max-w-[85%] rounded-2xl px-3.5 py-2 text-xs italic text-(--text-muted)">
                ${escapeHtml(text)}
              </p>
            </div>
          `;
  }
  if (msg.role === 'user') {
    // Uploads the blocks already display: showing them again as chips says the
    // same thing a second time (the handoff card IS its three screenshots).
    const shown = new Set(
      (msg.blocks ?? []).flatMap((b) =>
        b.kind === 'handoff' ? b.shots.map((s) => s.uploadId)
        : b.kind === 'images' ? b.items.map((i) => i.uploadId)
        : [],
      ),
    );
    const chips = (msg.attachments ?? [])
      .filter((a) => !a.id || !shown.has(a.id))
      .map((a) => {
        const thumb =
          a.url && a.mime.startsWith('image/')
            ? `<img class="msg-attachment__thumb" src="${escapeHtml(a.url)}" alt="${escapeHtml(a.filename)}" />`
            : `<span class="msg-attachment__glyph" aria-hidden="true">${a.mime.startsWith('image/') ? '🖼' : '📄'}</span>`;
        return `<span class="msg-attachment" title="${escapeHtml(a.filename)}">${thumb}<span class="msg-attachment__name">${escapeHtml(a.filename)}</span></span>`;
      })
      .join('');
    const attachmentsRow = chips
      ? `<div class="msg-attachments">${chips}</div>`
      : '';
    // A message that carries blocks has a human-facing rendering already. Its
    // `content` is the copy written for the AGENT — upload ids, annotation
    // JSON, instructions about which tool to call — and showing that to the
    // person as well is just the same message in a worse language.
    const textRow =
      msg.content && !msg.blocks?.length
        ? `<p class="max-w-[85%] rounded-2xl bg-(--surface-elevated) px-3.5 py-2 text-sm text-(--text-primary)">
                ${escapeHtml(msg.content)}
              </p>`
        : '';
    // The /command the message was sent with, beside it — so the transcript
    // still explains why the chat behaved differently from here on.
    const commandRow = msg.command ? `<div class="msg-command">${commandChipHtml(msg.command)}</div>` : '';
    // Blocks first: the card is what this message is about (a handoff shows
    // its shots), the sentence underneath is the part the agent reads.
    const blocksRow = renderMessageBlocks(msg.blocks);
    return `
            <div class="flex flex-col items-end gap-1">
              ${blocksRow}
              ${attachmentsRow}
              ${commandRow}
              ${textRow}
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
};
