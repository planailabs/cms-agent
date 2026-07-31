/**
 * Display blocks in the transcript (see lib/messageBlocks).
 *
 * A message's `content` is what the model reads and stays plain text; blocks
 * are what the person scrolling back sees. Rendering is per kind and additive:
 * a kind this build does not know is skipped, so an older tab against a newer
 * server shows less rather than breaking.
 */
import { escapeHtml } from '../../utils/html';
import { resolveTranslated, t, uiLocale } from '@/lib/i18n';
import { uploadUrl, type BlockImage, type DisplayBlock, type NoticeFact } from '@/lib/messageBlocks';

/** One clickable shot. The full-size view is opened by the click handler in
 *  events/chatEvents (data-action="msg-shot"). */
const shot = (image: BlockImage): string => {
  const src = uploadUrl(image.uploadId);
  const label = image.label ? escapeHtml(image.label) : '';
  return `<button type="button" class="msg-shot" data-action="msg-shot"
      data-src="${escapeHtml(src)}" data-label="${label}"
      title="${escapeHtml(t(uiLocale(), 'chat.block.openShot'))}">
      <img class="msg-shot__img" src="${escapeHtml(src)}"
        alt="${escapeHtml(image.alt ?? image.label ?? '')}" loading="lazy" />
      ${label ? `<span class="msg-shot__label">${label}</span>` : ''}
    </button>`;
};

const noticeFacts = (rows: NoticeFact[]): string => {
  const locale = uiLocale();
  return factRows(
    rows.map((r) => ({
      label: resolveTranslated(locale, r.label),
      value: typeof r.value === 'string' ? r.value : resolveTranslated(locale, r.value),
    })),
  );
};

const factRows = (rows: Array<{ label: string; value: string }>): string =>
  rows
    .map(
      (r) =>
        `<div class="msg-fact"><span class="msg-fact__label">${escapeHtml(r.label)}</span>` +
        `<span class="msg-fact__value">${escapeHtml(r.value)}</span></div>`,
    )
    .join('');

/** "2 moves · 1 swap · 3 comments" — zero counts are noise, so they are left out. */
const countSummary = (counts: Record<string, number>): string => {
  const locale = uiLocale();
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${n} ${t(locale, `chat.block.count.${key}`)}`);
  return parts.join(' · ');
};

const renderBlock = (block: DisplayBlock): string => {
  const locale = uiLocale();
  switch (block.kind) {
    case 'tm':
      return `<p class="msg-block__note">${escapeHtml(resolveTranslated(locale, block.message))}</p>`;
    case 'note':
      return `<p class="msg-block__note">${escapeHtml(block.text)}</p>`;
    case 'facts':
      return `<div class="msg-block__facts">${factRows(block.rows)}</div>`;
    case 'images':
      return `<div class="msg-shots">${block.items.map(shot).join('')}</div>`;
    case 'notice': {
      // Reads top-down: what stopped → why → the numbers → what to do.
      const facts = block.facts?.length ? noticeFacts(block.facts) : '';
      const hints = (block.hints ?? [])
        .map((h) => `<li>${escapeHtml(resolveTranslated(locale, h))}</li>`)
        .join('');
      return `<div class="msg-card msg-card--notice msg-card--${escapeHtml(block.tone)}">
          <div class="msg-card__head">
            <span class="msg-card__icon" aria-hidden="true">${block.tone === 'error' ? '✕' : '⏱'}</span>
            <span class="msg-card__title">${escapeHtml(resolveTranslated(locale, block.title))}</span>
          </div>
          <p class="msg-card__note">${escapeHtml(resolveTranslated(locale, block.body))}</p>
          ${facts ? `<div class="msg-block__facts">${facts}</div>` : ''}
          ${hints ? `<ul class="msg-card__hints">${hints}</ul>` : ''}
        </div>`;
    }
    case 'handoff': {
      const summary = countSummary(block.counts);
      return `<div class="msg-card msg-card--handoff">
          <div class="msg-card__head">
            <span class="msg-card__title">${escapeHtml(t(locale, 'chat.block.handoffTitle'))}</span>
            <span class="msg-card__route ws-mono">${escapeHtml(block.route)}</span>
          </div>
          ${block.note ? `<p class="msg-card__note">${escapeHtml(block.note)}</p>` : ''}
          ${summary ? `<p class="msg-card__summary">${escapeHtml(summary)}</p>` : ''}
          <div class="msg-shots">${block.shots.map(shot).join('')}</div>
        </div>`;
    }
    default:
      return '';
  }
};

export const renderMessageBlocks = (blocks: DisplayBlock[] | undefined): string =>
  blocks?.length ? `<div class="msg-blocks">${blocks.map(renderBlock).join('')}</div>` : '';

/**
 * Full-size view of one shot. The annotated screenshot IS the page with the
 * user's marks rendered on it, so "open it big" is the whole feature — no
 * second rendering path that could disagree with what the agent was sent.
 *
 * Deliberately DOM-imperative and self-contained: the transcript re-renders
 * often, and a viewer that lived in the message markup would be torn down
 * mid-look.
 */
export const openShotViewer = (src: string, label = ''): void => {
  document.querySelector('.msg-shot-viewer')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'msg-shot-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <figure class="msg-shot-viewer__frame">
      <img class="msg-shot-viewer__img" src="${escapeHtml(src)}" alt="${escapeHtml(label)}" />
      ${label ? `<figcaption class="msg-shot-viewer__caption">${escapeHtml(label)}</figcaption>` : ''}
    </figure>
    <button type="button" class="msg-shot-viewer__close"
      aria-label="${escapeHtml(t(uiLocale(), 'chat.block.closeShot'))}">✕</button>`;

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
  }
  // Clicking the picture keeps it open; anywhere else closes — the usual
  // lightbox contract, so nobody has to hunt for the ✕.
  overlay.addEventListener('click', (event) => {
    if (!(event.target as HTMLElement).closest('.msg-shot-viewer__img')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
};
