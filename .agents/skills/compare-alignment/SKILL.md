---
name: compare-alignment
description: Diagnose and improve the before/after content-alignment aligner (onion "content" mode). Use when a diff/onion/highlight looks misaligned, overlaid, doubled, or missing fillers. Self-improving — every new visual bug becomes a scaffold + regression here.
---

# Compare alignment

The onion/scroll "content" mode aligns a before and after screenshot so matched
content sits at the same `y`. It does this by **reflowing the real pages**: the
diff pipeline screenshots both raw, computes a spacing plan, injects filler
`<div>`s (or `margin-top` on flex/grid items), and re-screenshots →
`before-aligned` / `after-aligned`. No canvas slicing.

## The pipeline (where the code is)

- `src/lib/compare/markers.ts` — `COLLECT_MARKERS_JS` collects per-element
  markers in the browser: bounding box (`x/w/h`), content key `k` (tag+text),
  structural role `s`, stable identity (`id`, scope `sid`, class `c`), grid/table
  cell `fx`, and index `i` (tags `data-cmsm=i` for re-selection). `similarity()`
  = the match degree (id → text/scope/class → structure); `alignMarkers()` = the
  Needleman–Wunsch alignment (matches + added/removed gaps); `computeAnchors()`.
- `src/lib/compare/layout.ts` — `partition()` guillotine-cuts each shot into
  rectangles; `matchAlign()` matches the two trees (content-aware sibling
  alignment, grid/table cells never cross-match); `spacingPlan()` turns that into
  per-element `Spacer[]` for each side; `boxDiff()` = the highlight rectangles;
  **`verifyAlignment()`** = the quality harness.
- `src/lib/compare/inject.ts` — `INJECT_SPACERS`: applies the plan in the browser.
  Filler modes: `el` (flow div / margin-top on a flex-grid item), `grid` (push a
  whole flex/grid down), `tail` (grow the *column box* that holds an element so
  its whole ROW gets taller — equalises a grid/flex/inline-block row height),
  `cell` (insert an empty column so an add/remove doesn't reflow the cells after
  it). `columnOf()` finds the column box for any row layout: a grid child, a
  flex-ROW child, or an inline-block element (NOT a flex-column card's internals).
  All fillers lock height/min/max + box-model with `!important` so no page CSS can
  distort a spacer.
- `src/lib/diff/screenshot.ts` — `alignedShots()`: inject and re-screenshot;
  falls back to the raw shots on failure.
- Client: `diffViewer.ts` / `browserCompare.ts` request the `-aligned` kinds in
  content mode.

## The self-improving loop

`verifyAlignment(a, ah, b, bh)` applies the plan and reports:
- `maxPairDelta` — worst matched-pair `y` misalignment (**the** signal; should be ~0),
- `heightGap` — plan under-fill (informational; the very bottom is covered by shot padding),
- `misaligned[]` — the offending `{ia, ib, dy}` pairs.

When a compare looks wrong:

1. **Reproduce it as a scaffold.** Prefer a REAL-BROWSER case in
   `test/align-realbrowser.test.ts`: add a one-edit DOM mutation to
   `test/fixtures/align/base.html` (structure/classes/ids borrowed from plan.ai —
   incl. a 2-row grid `#departments`, an inline-block column row `#legacy`, and a
   table) — it runs the actual pipeline (collect → spacingPlan → inject →
   re-collect in Playwright) and asserts matched content lands at the same `y`.
   The same file has a **seeded chaos generator** (`buildOps`/`applyOps`): random
   combinations of edits, and on failure it logs the seed + ops for a one-line
   repro — widen the seed range to hunt for new failure modes. For a pure-logic
   case use a marker set in `test/compare-align-verify.test.ts` (assert
   `maxPairDelta <= 2`). Or pull real markers from a live diff (below).
2. **Watch it fail**, read `misaligned[]` to see which elements drift and by how much.
3. **Tighten the aligner** in `compare/layout.ts` / `markers.ts` (matching,
   sibling alignment, spacing walk) until the scaffold passes.
4. **Keep the scaffold** — it's now a regression guard. Never delete one to make
   a change pass.

### Pulling real markers from a live diff

Markers + shots live in `os.tmpdir()/cms-agent-diffs/<branch>/<commit>-<key>-*`
(locally) or in the container's tmp on the server (`docker exec … node -e` to
read). `*-before.png.markers.json` / `*-after.png.markers.json` are the inputs;
`*-before-aligned.png` / `*-after-aligned.png` are the outputs to eyeball. Slim
them into a fixture under `test/fixtures/` and add a scaffold.

## Known-good invariants (don't regress)

- Grid/table columns never cross-match (`fx`); a whole section corresponds by
  `sid`+structure even when every word changed; insertions are detected (text
  disambiguates) not shifted.
- Matching ≠ change-detection: identity can score a changed element ~1, so
  `boxDiff` decides "changed" by comparing the content key, not the match score.
- A full rewrite (structures don't correspond) overlays as one rectangle rather
  than stacking (which doubled the height).
- **Grids partition ROW-first.** A grid has full-span gaps both ways; `partition`
  breaks the h/v tie toward the horizontal (row) cut so the aligner sees rows
  (matching the row-major flow + `align-items: stretch`), not independent columns.
- **A row's height change moves the row below as one unit.** A card that grows
  taller lifts its whole row (stretch); the `v`-branch of `spacingPlan` equalises
  by growing ONE card on the shorter side (`tail`), and the reflow carries the
  rows below — it does NOT push each column independently (that desyncs the row —
  the original "Command card misaligned" bug).
- **This applies to any row layout, not just `display:grid`** — flex-row and
  inline-block column rows couple the same way; `columnOf()` handles all three.
- An added/removed card reflows the cells after it; a `cell` filler on the side
  missing the card keeps the survivors in place.

## Known limitation

Removing/adding a card in an *early* row of a multi-row grid is a true 2-D
row-major reflow: a later card pulls up into the previous row (e.g. remove a
row-1 card → the first row-2 card jumps to row 1). A height-based aligner can't
undo a cross-row move, so that one card stays a row off. Editing card *text* (the
common case) and add/remove in the *last* row are handled. The chaos test
deliberately restricts grid removal to row 2 for this reason. Fixing it properly
needs grid-flatten (align all cards as one row-major sequence, then re-group into
rows) — do that if cross-row grid edits become common.

## This skill is SELF-IMPROVING

Treat it as living. Whenever you fix a new alignment failure mode: (a) add the
reproduction scaffold, (b) record the new invariant under "Known-good", and
(c) update the pipeline map if the code moved. The scaffolds + `verifyAlignment`
are the objective measure; this doc is the memory of *why*.
