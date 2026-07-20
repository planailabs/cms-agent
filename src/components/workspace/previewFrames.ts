/**
 * Per-tab preview iframes — reconciled imperatively against the frame region
 * (NEVER via innerHTML): switching tabs only toggles a visibility class, so
 * inactive tabs stay loaded (moving or recreating an iframe node reloads its
 * document and kills the injected agent's state).
 *
 * Iframes are keyed by the client-only tab ids (ws.previewTabIds) and carry
 * the branch they were created for — a branch/chat switch drops and
 * recreates them, everything else leaves existing nodes untouched.
 */
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';
import { branchPreviewUrl } from './config';
import { previewBranchName } from './preview';

export const syncPreviewFrames = (region: HTMLElement, state: AppState): void => {
  const ws = state.workspace;
  const branch = previewBranchName(state);

  const existing = new Map<string, HTMLIFrameElement>();
  for (const el of region.querySelectorAll<HTMLIFrameElement>('iframe[data-tab-id]')) {
    const stale = el.dataset.branch !== branch || !ws.previewTabIds.includes(el.dataset.tabId!);
    if (stale) el.remove();
    else existing.set(el.dataset.tabId!, el);
  }

  ws.previewTabIds.forEach((id, i) => {
    let frame = existing.get(id);
    if (!frame) {
      frame = document.createElement('iframe');
      frame.dataset.tabId = id;
      frame.dataset.branch = branch;
      frame.title = t(uiLocale(), 'workspace.preview.frameTitle', { branch });
      frame.src = branchPreviewUrl(branch, ws.previewTabs[i] ?? '/');
      region.appendChild(frame);
    }
    frame.classList.toggle('is-active', i === ws.activeTabIndex);
  });
};

/** Every managed per-tab iframe (message-source matching in previewAgent). */
export const getPreviewIframes = (): HTMLIFrameElement[] => [
  ...document.querySelectorAll<HTMLIFrameElement>('#preview-frame-region iframe[data-tab-id]'),
];

/** The visible (active-tab) iframe — the target for commands and eval. */
export const getPreviewIframe = (): HTMLIFrameElement | null =>
  document.querySelector<HTMLIFrameElement>('#preview-frame-region iframe.is-active');
