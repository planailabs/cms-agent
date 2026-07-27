/**
 * Hint banner (element picker / edit mode instructions) with its own ×.
 * Dismissal is remembered per kind for the lifetime of the page (module
 * reload on navigation brings the hint back); the banner stays
 * pointer-events:none so page clicks pass through — only the × is clickable.
 */

const dismissed = new Set<string>();

export interface HelpBanner {
  el: HTMLDivElement | null;
  setText(text: string): void;
  remove(): void;
}

const NOOP: HelpBanner = { el: null, setText: () => {}, remove: () => {} };

export const createHelpBanner = (kind: 'pick' | 'edit', text: string): HelpBanner => {
  if (dismissed.has(kind)) return NOOP;
  const el = document.createElement('div');
  el.className = 'cms-ov-pick-help';
  el.setAttribute('data-cms-overlay', '');
  const label = document.createElement('span');
  label.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'cms-ov-pick-help__close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  });
  close.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    dismissed.add(kind);
    el.remove();
  });
  el.append(label, close);
  document.body.appendChild(el);
  return {
    el,
    setText: (t) => {
      label.textContent = t;
    },
    remove: () => el.remove(),
  };
};
