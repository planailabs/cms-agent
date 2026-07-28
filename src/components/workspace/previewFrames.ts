/**
 * Per-tab preview iframes — reconciled imperatively against the frame region
 * (NEVER via innerHTML): switching tabs only toggles a visibility class, so
 * inactive tabs stay loaded (moving or recreating an iframe node reloads its
 * document and kills the injected agent's state).
 *
 * Iframes are keyed by the client-only tab ids (ws.previewTabIds) and carry
 * the branch + device they were created for — a branch/chat/device switch
 * drops and recreates them (a device change must reload anyway so the proxy
 * UA override applies to the document request), everything else leaves
 * existing nodes untouched.
 *
 * Device preview: the iframe is fixed to the device viewport and scaled to
 * fit the pane (centered); a ResizeObserver keeps the scale in step with
 * pane resizes.
 */
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';
import { branchPreviewUrl } from './config';
import { previewBranchName } from './preview';
import { deviceByKey, withUaParam, type PreviewDevice } from './devices';

const FIT_MARGIN = 24;

let observed: HTMLElement | null = null;
let lastDevice: PreviewDevice | null = null;
let resizeObserver: ResizeObserver | null = null;

const layoutFrames = (region: HTMLElement, device: PreviewDevice | null): void => {
  region.classList.toggle('is-device', !!device);
  for (const frame of region.querySelectorAll<HTMLIFrameElement>('iframe[data-tab-id]')) {
    if (!device) {
      frame.style.width = '';
      frame.style.height = '';
      frame.style.left = '';
      frame.style.top = '';
      frame.style.transform = '';
      continue;
    }
    const scale = Math.min(
      1,
      (region.clientWidth - FIT_MARGIN) / device.width,
      (region.clientHeight - FIT_MARGIN) / device.height,
    );
    frame.style.width = `${device.width}px`;
    frame.style.height = `${device.height}px`;
    frame.style.left = `${Math.max(0, (region.clientWidth - device.width * scale) / 2)}px`;
    frame.style.top = `${Math.max(0, (region.clientHeight - device.height * scale) / 2)}px`;
    frame.style.transform = `scale(${scale})`;
  }
};

export const syncPreviewFrames = (region: HTMLElement, state: AppState): void => {
  const ws = state.workspace;
  const branch = previewBranchName(state);
  const device = deviceByKey(ws.previewDevice);
  const deviceKey = device?.key ?? '';

  const existing = new Map<string, HTMLIFrameElement>();
  for (const el of region.querySelectorAll<HTMLIFrameElement>('iframe[data-tab-id]')) {
    const stale =
      el.dataset.branch !== branch ||
      el.dataset.device !== deviceKey ||
      !ws.previewTabIds.includes(el.dataset.tabId!);
    if (stale) el.remove();
    else existing.set(el.dataset.tabId!, el);
  }

  ws.previewTabIds.forEach((id, i) => {
    let frame = existing.get(id);
    if (!frame) {
      frame = document.createElement('iframe');
      frame.dataset.tabId = id;
      frame.dataset.branch = branch;
      frame.dataset.device = deviceKey;
      frame.title = t(uiLocale(), 'workspace.preview.frameTitle', { branch });
      // __cms_ua sets (or, responsive, clears) the proxy's per-branch UA override.
      frame.src = withUaParam(branchPreviewUrl(branch, ws.previewTabs[i] ?? '/'), device);
      region.appendChild(frame);
    }
    frame.classList.toggle('is-active', i === ws.activeTabIndex);
  });

  lastDevice = device;
  layoutFrames(region, device);
  if (observed !== region) {
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      if (observed) layoutFrames(observed, lastDevice);
    });
    resizeObserver.observe(region);
    observed = region;
  }
};

/** Every managed per-tab iframe (message-source matching in previewAgent). */
export const getPreviewIframes = (): HTMLIFrameElement[] => [
  ...document.querySelectorAll<HTMLIFrameElement>('#preview-frame-region iframe[data-tab-id]'),
];

/** The visible (active-tab) iframe — the target for commands and eval. */
export const getPreviewIframe = (): HTMLIFrameElement | null =>
  document.querySelector<HTMLIFrameElement>('#preview-frame-region iframe.is-active');
