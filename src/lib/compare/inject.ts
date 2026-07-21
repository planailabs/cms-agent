/**
 * Browser-side spacer injection — the reflow step of the DOM-filler aligner.
 * Runs via playwright page.evaluate (screenshot.ts) AND the real-browser
 * alignment tests. Pushes each tagged element (data-cmsm) down by inserting a
 * filler <div>, or margin-top for flex/grid items (which don't margin-collapse
 * and mustn't gain an extra grid cell). mode 'grid' pushes the whole flex/grid.
 */
export const INJECT_SPACERS = (
  spacers: Array<{
    i: number;
    px: number;
    mode: string;
    sid?: string;
    owner?: string;
    action?: "before" | "inside" | "row";
  }>,
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
      const gridCols =
        pd.display.indexOf("grid") >= 0
          ? pd.gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length
          : 0;
      const parentIsRow =
        gridCols > 1 ||
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
  const padItemTop = (el: Element, px: number): void => {
    const cur = parseFloat(getComputedStyle(el).paddingTop) || 0;
    (el as HTMLElement).style.setProperty(
      "padding-top",
      cur + px + "px",
      "important",
    );
  };
  const padRow = (el: Element, px: number): void => {
    const parent = el.parentElement;
    if (!parent) return;
    const top = Math.round(el.getBoundingClientRect().top);
    for (const sibling of Array.from(parent.children)) {
      if (Math.abs(Math.round(sibling.getBoundingClientRect().top) - top) <= 2)
        padItemTop(sibling, px);
    }
  };
  for (const s of spacers) {
    const el = document.querySelector('[data-cmsm="' + s.i + '"]');
    if (!el) continue;
    if (s.mode === "tail") {
      growItem(el, s.px);
    } else if (s.mode === "cell") {
      insertCell(el, s.px);
    } else if (s.mode === "row" || s.mode === "scope") {
      continue; // Probe intents are never applied without a measured owner.
    } else if (s.mode === "owner") {
      const owner = s.owner
        ? document.querySelector('[data-cmso="' + s.owner + '"]')
        : null;
      if (owner) {
        if (s.action === "inside") padItemTop(owner, s.px);
        else if (s.action === "row") padRow(owner, s.px);
        else pushBefore(owner, s.px);
      }
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

/** Find the nearest real flow owner for every ordinary corrective spacer.
 * Each candidate is probed reversibly; no inferred grid/table model is used. */
export const PROBE_SPACER_OWNERS = (
  spacers: Array<{
    i: number;
    px: number;
    mode: string;
    sid?: string;
    owner?: string;
    action?: "before" | "inside" | "row";
  }>,
) => {
  const PROBE = 7;
  let nextOwner = document.querySelectorAll("[data-cmso]").length;
  const markers = Array.from(
    document.querySelectorAll<HTMLElement>("[data-cmsm]"),
  );
  const targets = new Map<number, Element>();
  for (const spacer of spacers) {
    const target = document.querySelector('[data-cmsm="' + spacer.i + '"]');
    if (target) targets.set(spacer.i, target);
  }
  const probe = (
    target: Element,
    candidate: Element,
    action: "before" | "inside" | "row",
  ): { valid: boolean; effects: Map<number, number> } => {
    const before = new Map(
      markers.map((marker) => {
        const rect = marker.getBoundingClientRect();
        return [marker, { top: rect.top, height: rect.height }];
      }),
    );
    const targetBefore = before.get(target as HTMLElement)?.top;
    if (targetBefore === undefined) return { valid: false, effects: new Map() };
    const parent = candidate.parentElement;
    if (!parent) return { valid: false, effects: new Map() };
    let filler: HTMLElement | undefined;
    const changed: Array<{
      element: HTMLElement;
      property: string;
      value: string;
      priority: string;
    }> = [];
    const add = (element: Element, property: string, computed: string): void => {
      const html = element as HTMLElement;
      changed.push({
        element: html,
        property,
        value: html.style.getPropertyValue(property),
        priority: html.style.getPropertyPriority(property),
      });
      const current = parseFloat(computed) || 0;
      html.style.setProperty(
        property,
        current + PROBE + "px",
        "important",
      );
    };
    if (action === "inside") {
      add(candidate, "padding-top", getComputedStyle(candidate).paddingTop);
    } else if (action === "row") {
      const top = Math.round(candidate.getBoundingClientRect().top);
      const row = Array.from(parent.children).filter(
        (sibling) =>
          Math.abs(Math.round(sibling.getBoundingClientRect().top) - top) <= 2,
      );
      if (row.length < 2) return { valid: false, effects: new Map() };
      for (const sibling of row)
        add(sibling, "padding-top", getComputedStyle(sibling).paddingTop);
    } else {
      const display = getComputedStyle(parent).display;
      if (display.indexOf("grid") >= 0 || display.indexOf("flex") >= 0) {
        add(candidate, "margin-top", getComputedStyle(candidate).marginTop);
      } else {
        filler = document.createElement("div");
        filler.setAttribute("aria-hidden", "true");
        filler.style.cssText =
          "display:block!important;height:" +
          PROBE +
          "px!important;min-height:" +
          PROBE +
          "px!important;max-height:" +
          PROBE +
          "px!important;margin:0!important;padding:0!important;border:0!important;";
        parent.insertBefore(filler, candidate);
      }
    }
    const moved = target.getBoundingClientRect().top - targetBefore;
    const effects = new Map<number, number>();
    for (const [id, element] of targets) {
      const old = before.get(element as HTMLElement);
      if (!old) continue;
      const delta = element.getBoundingClientRect().top - old.top;
      if (Math.abs(delta) > 0.5) {
        const ratio = delta / PROBE;
        effects.set(id, Math.abs(ratio - 1) <= 0.2 ? 1 : ratio);
      }
    }
    const affected = markers.filter((marker) => {
      const old = before.get(marker)!;
      const rect = marker.getBoundingClientRect();
      return (
        Math.abs(rect.top - old.top) > 0.5 ||
        Math.abs(rect.height - old.height) > 0.5
      );
    });
    filler?.remove();
    for (const change of changed) {
      if (change.value)
        change.element.style.setProperty(
          change.property,
          change.value,
          change.priority,
        );
      else change.element.style.removeProperty(change.property);
    }
    const restored = affected.every((marker) => {
      const old = before.get(marker)!;
      const rect = marker.getBoundingClientRect();
      return (
        Math.abs(rect.top - old.top) <= 0.5 &&
        Math.abs(rect.height - old.height) <= 0.5
      );
    });
    return {
      valid: Math.abs(moved - PROBE) <= 1 && restored,
      effects,
    };
  };

  const refined = spacers.map((spacer) => {
    const action: "before" | "inside" | "row" | undefined =
      spacer.mode === "scope"
        ? "inside"
        : spacer.mode === "row"
          ? "row"
          : spacer.mode === "el"
            ? "before"
            : undefined;
    if (!action) return { spacer, effects: new Map<number, number>() };
    const target = document.querySelector('[data-cmsm="' + spacer.i + '"]');
    if (!target) return { spacer, effects: new Map<number, number>() };
    let measuredOwner: Element | null = null;
    let measuredEffects = new Map<number, number>();
    for (
      let candidate: Element | null = target;
      candidate && candidate !== document.documentElement;
      candidate = candidate.parentElement
    ) {
      const result = probe(target, candidate, action);
      if (result.valid && !measuredOwner) {
        measuredOwner = candidate;
        measuredEffects = result.effects;
      }
    }
    if (measuredOwner) {
      let owner = measuredOwner.getAttribute("data-cmso");
      if (!owner) {
        owner = "o" + nextOwner++;
        measuredOwner.setAttribute("data-cmso", owner);
      }
      return {
        spacer: { ...spacer, mode: "owner", owner, action },
        effects: measuredEffects,
      };
    }
    return action === "before"
      ? { spacer, effects: new Map<number, number>() }
      : undefined;
  });
  const concrete = refined.filter(
    (spacer): spacer is NonNullable<typeof spacer> => spacer !== undefined,
  );
  const groups = new Map<
    string,
    {
      spacer: (typeof concrete)[number]["spacer"];
      effects: Map<number, number>;
      requirements: Array<{ target: number; px: number }>;
    }
  >();
  const direct: Array<(typeof concrete)[number]["spacer"]> = [];
  for (const entry of concrete) {
    const spacer = entry.spacer;
    if (spacer.mode !== "owner" || !spacer.owner) {
      direct.push(spacer);
      continue;
    }
    const key = `${spacer.action}:${spacer.owner}`;
    const group = groups.get(key) ?? {
      spacer,
      effects: entry.effects,
      requirements: [],
    };
    group.requirements.push({ target: spacer.i, px: spacer.px });
    groups.set(key, group);
  }

  // Solve the measured forward dependency graph. Earlier owner mutations may
  // already move later targets; only commit the remaining required distance.
  const predicted = new Map<number, number>();
  const solved = [...groups.values()].flatMap((group) => {
    const needed = group.requirements
      .map(({ target, px }) => {
        const effect = group.effects.get(target) ?? 0;
        return effect > 0.05 ? (px - (predicted.get(target) ?? 0)) / effect : 0;
      })
      .filter((px) => px > 0.5)
      .sort((a, b) => a - b);
    const amount = needed[Math.floor(needed.length / 2)] ?? 0;
    if (amount < 0.5) return [];
    for (const [target, effect] of group.effects)
      predicted.set(target, (predicted.get(target) ?? 0) + amount * effect);
    return [{ ...group.spacer, px: Math.round(amount) }];
  });
  return [...solved, ...direct];
};
