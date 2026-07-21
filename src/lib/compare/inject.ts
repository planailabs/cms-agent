/**
 * Browser-side spacer injection — the reflow step of the DOM-filler aligner.
 * Runs via playwright page.evaluate (screenshot.ts) AND the real-browser
 * alignment tests. Pushes each tagged element (data-cmsm) down by inserting a
 * filler <div>, or margin-top for flex/grid items (which don't margin-collapse
 * and mustn't gain an extra grid cell). mode 'grid' pushes the whole flex/grid.
 */
export const INJECT_SPACERS = (spacers: Array<{ i: number; px: number; mode: string }>) => {
  const pushBefore = (el: Element, px: number): void => {
    const parent = el.parentElement;
    if (!parent) return;
    const disp = getComputedStyle(parent).display;
    if (disp.indexOf('flex') >= 0 || disp.indexOf('grid') >= 0) {
      const cur = parseFloat(getComputedStyle(el).marginTop) || 0;
      (el as HTMLElement).style.marginTop = cur + px + 'px';
    } else {
      const sp = document.createElement('div');
      sp.style.height = px + 'px';
      sp.style.width = '100%';
      sp.style.flex = '0 0 auto';
      parent.insertBefore(sp, el);
    }
  };
  for (const s of spacers) {
    const el = document.querySelector('[data-cmsm="' + s.i + '"]');
    if (!el) continue;
    if (s.mode === 'grid') {
      let g: Element = el;
      for (let p = el.parentElement, d = 0; p && d < 8; p = p.parentElement, d++) {
        const dp = getComputedStyle(p).display;
        if (dp.indexOf('flex') >= 0 || dp.indexOf('grid') >= 0) {
          g = p;
          break;
        }
      }
      pushBefore(g, s.px);
    } else {
      pushBefore(el, s.px);
    }
  }
};
