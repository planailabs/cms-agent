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
  cell `fx`, row geometry (`rg/rp/ry/rc`), scope top `sy`, semantic depth `d`,
  and index `i` (tags `data-cmsm=i` for re-selection). `similarity()`
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
  it), `row` (pad every item in one visual row), and `scope` (shift content
  inside the exact stable-id section). `owner` targets a flow owner measured by
  `PROBE_SPACER_OWNERS`, rather than inferred from tag names. `columnOf()` finds
  the column box for any row layout: a grid child, a flex-ROW child, or an
  inline-block element (NOT a flex-column card's internals). All fillers lock
  height/min/max + box-model with `!important` so page CSS cannot distort them.
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
- Repeated sibling cards are matched by the SUM of their marker match strengths,
  not the count above a threshold. Same-shaped cards are plausible weak matches,
  but they must not tie exact later cards and hide an insertion's filler (the
  "Squirrels before Challenges" regression).
- The additive corrective loop requires unchanged-content or stable-ID trust;
  scope/class/structural matches can seed coarse layout but cannot authorize
  irreversible correction of a full-page rewrite. Every round is monotonic: if
  absolute drift worsens, discard that browser pair and recapture from the
  structural seed (the production 13,099px → 44,701px regression).
- Low-confidence pages still require unchanged-content/stable-ID anchors for
  authorization, then converge in a strictly forward hierarchy: top-level
  landmarks → scoped section inset → visual rows → item-local flows → rowless
  section tails → final landmarks → terminal footer columns. A later local pass
  never jumps backward to landmarks; that oscillation caused the production
  full-rewrite drift.
- Residuals are measured in the coordinate system that owns them. Section inset
  is `leaf.y - scope.sy`; rows and items are relative to the section lead. Never
  subtract a grid top when measuring placement of that grid inside its section,
  and never feed absolute section drift into every child item: both multiply
  additive padding catastrophically.
- Row and item ownership is explicit: rows align coupled row placement, then
  item flow aligns content inside each card/column. Generic item groups require
  corroborating descendants; sparse footer columns use a separate terminal pass
  because they have no downstream page flow.
- Ordinary residual spacers probe the target and every ancestor with a temporary
  7px mutation, recording every marker whose position or size changes. Accept an
  owner only after the complete candidate graph is measured and every affected
  marker returns to its prior geometry. The solver retains each owner's influence
  vector over all requested targets, deduplicates equal owners, and subtracts
  upstream measured movement before committing downstream spacer heights. This
  handles tables and unknown nested layout dependencies without guessed cascade
  arithmetic in both screenshot and live-iframe paths.
- `row` and `scope` are probe intents only. They are never injected directly:
  the graph must resolve them to measured `owner` actions (`row` or `inside`),
  otherwise the correction is dropped rather than guessed.
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

High-confidence pages use `correctiveFlat(a, b, gain)`. Low-confidence pages
with at least one trusted anchor use the staged hierarchy in `converge.ts` and a
larger round budget. Both paths re-measure real browser geometry after every
additive mutation; a round that materially worsens its selected metric marks the
pair regressed so callers recapture the structural seed.

- **Model-free.** No grid/row/consensus logic — it just moves measured content to
  where its match sits, with a probed influence graph resolving flow dependencies.
  Grids, flex, tables, nesting converge the same way, including cases the
  structural pass leaves off (a grid row whose cells drifted by different amounts,
  or the asymmetric-gap grid-list) — it aligns positions, not structure.
- **Undershoot to avoid overshoot.** Margin can be added but not removed. The
  influence graph removes guessed cumulative carry; `gain` (0.7) still makes each
  measured round approach the target from below rather than overshooting.

The structural `spacingPlan` still runs first as the fast seed. Trust
real-browser matched-leaf deltas, not container bounds or `verifyAlignment`'s
linear simulation, for grid work: differently rewritten list containers can
have different outer heights while every visible child is aligned. The plan.ai
full-rewrite production regression excludes six hidden closed-details paragraphs
and converges all 130 painted matched leaves to integer-pixel parity through the
probed flat path. The 12-round ceiling is a guard, not a fixed cost; convergence
stops once the worst rounded marker delta is ≤1px.

## Fixture coverage (imported plan.ai patterns)

`test/fixtures/align/base.html` reproduces every distinct plan.ai layout:
hero, section-header (caption+H3+lead), 3-col cards (`#inflection`), 4-col cards
(`#environments`), 2-col split + checklist (`#architecture`), stat row + 2-col
grid-list (`#compounding`), 6-card dept grid (`#departments`), inline-block
columns (`#legacy`), FAQ, and a table. The chaos generator issues random text
changes across all of them and asserts the FULL pipeline (structural + iterative
corrective) converges — widen the seed range to hunt new failure modes.
The computed-style chaos additionally enumerates every property exposed by
`getComputedStyle`, assigns all of them to deterministic random visible elements
using observed valid values, and runs several seeds through the same pipeline.

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
3. **DONE — no fix needed (measured).** The corrective loop logs its round count
   (`[align] … in N round(s)`). Across the 80-seed chaos harness with the
   guillotine seed: **77/80 converge in 0 corrective rounds**, 3/80 in 5, none
   stall (< the 6 cap). So the warm-start is unnecessary (the guillotine IS the
   warm-start) and there is no large-residual stall to fix. Adding gain-1.0 /
   adaptive logic would solve a non-problem and risk overshoot (add-only margin).
4. **DONE — keep the guillotine (measured).** The same data settles its fate: the
   seed buys real latency (0 vs 5 rounds for 77/80), so it is the fast path, not
   dead weight. The council's delete-condition ("only if the warm-start matches
   its latency") fails — the guillotine IS that latency. Verdict: **keep the
   current architecture** — `spacingPlan` structural seed (fast path) + model-free
   `correctiveFlat` safety net for the residual few. Revisit only if real-page
   round-count logs show many pages needing the corrective.

### Open gaps (2nd council, GPT-5.2 external voices — not yet done)

A cross-model council (GPT-5.2, reading the source) surfaced gaps the Claude
councils under-weighted. In priority order:

- **DONE — the 800-marker cap.** Was a silent correctness cliff: `MAX=800` in
  `querySelectorAll` (document) order made the collector a PREFIX capture on large
  pages — the tail invisible, the matcher a prefix matcher, metrics falsely stable.
  Now the collector gathers up to `HARD=3000` candidates and keeps the `MAX`
  largest-by-AREA (a whole-page spread, not the prefix), and surfaces `trunc`
  (count dropped) on `MarkerDoc`. Test: a big element at the page BOTTOM survives
  the cap where document-order truncation would drop it.
- **DONE (align side) — confidence signal + graceful degradation.**
  `matchConfidence(a, b)` combines unique unchanged/stable-id trust with structural
  corroboration across at least three stable scopes, then penalizes duplicate
  pressure and truncation. A one-scope same-role rewrite stays conservative; a
  near-complete multi-section rewrite can use the probed flat path. `alignedShots`
  keeps the staged trusted-anchor fallback below `CONFIDENCE_MIN` (0.35). STILL
  OPEN: the CHANGED side (coarse region boxes) and the onion raw-overlay fallback
  are not wired yet; `matchConfidence` is the hook when they are.
- **Shared-matcher tension (unresolved).** 2 of 3 GPT voices argued ALIGN and
  CHANGED optimize different truths (ALIGN wants stable anchors ACROSS rewrites;
  CHANGED wants to EXPOSE rewrites) and shouldn't fully share one global matcher —
  a direct challenge to Phase 2's consolidation. Don't reverse it on intuition;
  resolve with a real corpus.
- **The synthetic chaos metric is weak evidence.** 77/80-zero-rounds proves the
  seed fits the GENERATOR, not real failure classes (boilerplate/nav/footer clones,
  repeated cards, sticky headers, lazy content, reordered grids, translations).
  Replace it: persist worst-pair artifacts from live diffs (the round-count log is
  the hook) into a real regression corpus. The collector's marker identity is where
  quality is actually won or lost — likely a bigger lever than the align loop.

## This skill is SELF-IMPROVING

Treat it as living. Whenever you fix a new alignment failure mode: (a) add the
reproduction scaffold, (b) record the new invariant under "Known-good", and
(c) update the pipeline map if the code moved. The scaffolds + `verifyAlignment`
are the objective measure; this doc is the memory of _why_.
