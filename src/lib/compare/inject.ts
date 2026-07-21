/**
 * Browser-side spacer injection — the reflow step of the DOM-filler aligner.
 * Runs via playwright page.evaluate (screenshot.ts) AND the real-browser
 * alignment tests. Pushes each tagged element (data-cmsm) down by inserting a
 * filler <div>, or margin-top for flex/grid items (which don't margin-collapse
 * and mustn't gain an extra grid cell). mode 'grid' pushes the whole flex/grid.
 */
export const INJECT_SPACERS = (
  spacers: Array<{ i: number; px: number; mode: string }>,
) => {
  // An exact, inert gap of `px`. Every sizing + box-model property is locked with
  // !important so no page rule (resets, inherited line-height, flex stretch,
  // `* { min-height }`, etc.) can distort a filler; `flex:0 0 auto` keeps a flex
  // parent from growing/shrinking it. When px is null the height is left to the
  // layout (a stretched grid cell), but the box model is still neutralised.
  const mkFiller = (px: number | null): HTMLElement => {
    const sp = document.createElement("div");
    const lock = (k: string, v: string): void =>
      sp.style.setProperty(k, v, "important");
    lock("box-sizing", "border-box");
    lock("margin", "0");
    lock("padding", "0");
    lock("border", "0");
    lock("line-height", "0");
    lock("font-size", "0");
    lock("flex", "0 0 auto");
    lock("width", "100%");
    if (px !== null) {
      const h = px + "px";
      lock("height", h);
      lock("min-height", h);
      lock("max-height", h);
    }
    return sp;
  };

  // The column box that contains `el` in a row layout: the ancestor that is a
  // grid child, a flex-ROW child, or an inline-block/inline element. Stops there
  // (not at a flex-COLUMN parent, which is a card's own internal stacking).
  const columnOf = (el: Element): { item: Element; par: Element | null } => {
    let item = el;
    let par = el.parentElement;
    for (let d = 0; par && d < 8; d++) {
      const pd = getComputedStyle(par);
      const parentIsRow =
        pd.display.indexOf("grid") >= 0 ||
        (pd.display.indexOf("flex") >= 0 &&
          pd.flexDirection.indexOf("row") >= 0);
      if (parentIsRow) break;
      if (getComputedStyle(item).display.indexOf("inline") >= 0) break;
      item = par;
      par = par.parentElement;
    }
    return { item, par };
  };

  // Grow the column box that contains `el` by appending a filler as its last
  // child: this lifts the whole row to the taller side (via stretch, or simply
  // because a row's height is its tallest column) and reflows the rows below.
  const growItem = (el: Element, px: number): void => {
    columnOf(el).item.appendChild(mkFiller(px));
  };

  // Insert an empty cell before el's column box, shifting the cells after it back
  // by one — undoing the row-major reflow a card add/remove causes so the
  // surviving cards keep their positions.
  const insertCell = (el: Element, px: number): void => {
    const { item, par } = columnOf(el);
    if (!par) return;
    // No fixed height: align-items: stretch sizes the cell to its row; forcing a
    // height would over-inflate the row and shift everything below.
    void px;
    par.insertBefore(mkFiller(null), item);
  };
  const pushBefore = (el: Element, px: number): void => {
    const parent = el.parentElement;
    if (!parent) return;
    const disp = getComputedStyle(parent).display;
    if (disp.indexOf("flex") >= 0 || disp.indexOf("grid") >= 0) {
      const cur = parseFloat(getComputedStyle(el).marginTop) || 0;
      (el as HTMLElement).style.setProperty(
        "margin-top",
        cur + px + "px",
        "important",
      );
    } else {
      parent.insertBefore(mkFiller(px), el);
    }
  };
  for (const s of spacers) {
    const el = document.querySelector('[data-cmsm="' + s.i + '"]');
    if (!el) continue;
    if (s.mode === "tail") {
      growItem(el, s.px);
    } else if (s.mode === "push") {
      // Push the whole grid ITEM (card) that holds el down — margin-top on the
      // column box so a grid row moves as a unit (used by the recursive aligner).
      const item = columnOf(el).item as HTMLElement;
      const cur = parseFloat(getComputedStyle(item).marginTop) || 0;
      item.style.setProperty("margin-top", cur + s.px + "px", "important");
    } else if (s.mode === "cell") {
      insertCell(el, s.px);
    } else if (s.mode === "grid") {
      let g: Element = el;
      for (
        let p = el.parentElement, d = 0;
        p && d < 8;
        p = p.parentElement, d++
      ) {
        const dp = getComputedStyle(p).display;
        if (dp.indexOf("flex") >= 0 || dp.indexOf("grid") >= 0) {
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
