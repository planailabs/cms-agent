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
  whole flex/grid down), `tail` (grow the _column box_ that holds an element so
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
- **Grow the row by its TALLEST column, not the first.** Equalise a grid row from
  the _aligned_ column heights (`matchAlign(ca,cb).h`, which accounts for headings
  that wrap to different line counts) + each column's trailing deficit — growing
  only the first card fails when it isn't the tallest, so the row never grows and
  everything below drifts (the "silicon shift" cascade, ~50px per card section).

## Iterative corrective pass (the convergence loop)

`correctiveFlat(a, b, gain)` (layout.ts) + the loop in `alignedShots`
(screenshot.ts): after the structural reflow, while residual > 8px, re-measure the
reflowed markers, pad each element still too high by its OWN residual, re-collect,
and repeat (≤6 rounds) so BOTH sides converge. It measures real geometry each
round, so it self-corrects rather than trusting a model.

- **Model-free.** No grid/row/consensus logic — it just moves measured content to
  where its match sits (a `margin-top` flow filler keyed by the re-collected id).
  Grids, flex, tables, nesting converge the same way, including cases the
  structural pass leaves off (a grid row whose cells drifted by different amounts,
  or the asymmetric-gap grid-list) — it aligns positions, not structure.
- **Undershoot to avoid overshoot.** Margin can be added but not removed, and a
  pad inside a grid does NOT cascade to the rows below like a flow pad does, so the
  cumulative can over-estimate. `gain` (0.7) makes every step approach the target
  from below — never overshoots; a couple more rounds instead.

This replaced a DOM-aware corrective (push whole grid rows via `fx`, gated by a
consensus check) that couldn't fix a row whose cells drifted unevenly — the flat
loop is simpler AND strictly better there. The structural `spacingPlan` still runs
first as a fast seed so the loop finishes in 1–2 rounds. Trust the real-browser
`matchedYDelta`, not `verifyAlignment`'s linear sim, for grid work.

## Fixture coverage (imported plan.ai patterns)

`test/fixtures/align/base.html` reproduces every distinct plan.ai layout:
hero, section-header (caption+H3+lead), 3-col cards (`#inflection`), 4-col cards
(`#environments`), 2-col split + checklist (`#architecture`), stat row + 2-col
grid-list (`#compounding`), 6-card dept grid (`#departments`), inline-block
columns (`#legacy`), FAQ, and a table. The chaos generator issues random text
changes across all of them and asserts the FULL pipeline (structural + iterative
corrective) converges — widen the seed range to hunt new failure modes.

## Known limitation

Removing/adding a card in an _early_ row of a multi-row grid is a true 2-D
row-major reflow: a later card pulls up into the previous row (e.g. remove a
row-1 card → the first row-2 card jumps to row 1). A height-based aligner can't
undo a cross-row move, so that one card stays a row off. Editing card _text_ (the
common case) and add/remove in the _last_ row are handled. The chaos test
deliberately restricts grid removal to row 2 for this reason. Fixing it properly
needs grid-flatten (align all cards as one row-major sequence, then re-group into
rows) — do that if cross-row grid edits become common.

## Refactor direction (council verdict — in progress)

The insight driving the refactor: **matching is the product; align and `boxDiff`
are two thin consumers of it.** Everything structural (the guillotine `spacingPlan`)
is scaffolding around the one real primitive — a robust before↔after element
matching (`alignMarkers`). A one-shot recursive DOM-tree aligner was prototyped and
**abandoned** (failed chaos combinations; the model-free `correctiveFlat` beat it) —
deleted rather than hoarded. Sequenced, in priority order:

0. **DONE — resolve the abandoned experiment.** `treeAlign` and its collector infra
   (`pi`/`d` marker fields, `push` inject mode) removed; the pivot to `correctiveFlat`
   is the "better solution." Re-add a parent-index to the collector only when step 3's
   tree-aware matcher actually needs it.
1. **Build a regression oracle FIRST.** There is no ground truth for overlay /
   highlight quality beyond the chaos test, so every "improvement" is currently
   unfalsifiable. Check in real before/after marker pairs as regression fixtures and
   instrument the live loop with round-count. Do this before touching either algorithm.
2. **Decouple `boxDiff` from the guillotine.** align and changed are entangled
   through the shared partition — ripping the guillotine out for align silently
   regresses highlights. Reframe "changed" as a CLASSIFIER over the shared match:
   matched + text-differs → changed; unmatched → added/removed. Preserve the
   "heavily-edited block = changed, not add+remove" property (it's matching
   quality, portable). Then the guillotine has exactly one consumer.
3. **Fix `correctiveFlat`'s large-residual stall + add a cheap warm-start.** It's
   a proportional controller (gain 0.7, add-only) that undershoots and can stall
   at big residuals (the cross-row 300px case) under the round cap. First round
   should place matched elements AT their partner's y (gain ~1.0), then fine-tune
   at 0.7; make the cap adaptive; cache the match by stable id across re-diffs.
4. **Then measure and decide the guillotine's fate.** If the warm-start matches
   its latency on real pages → delete `spacingPlan` + partition + tail/cell/grid.
   If not → keep it as an OPTIONAL, measured seed, not the default. Do not delete
   ~500 lines on 80 synthetic combos without the latency number.

## This skill is SELF-IMPROVING

Treat it as living. Whenever you fix a new alignment failure mode: (a) add the
reproduction scaffold, (b) record the new invariant under "Known-good", and
(c) update the pipeline map if the code moved. The scaffolds + `verifyAlignment`
are the objective measure; this doc is the memory of _why_.
