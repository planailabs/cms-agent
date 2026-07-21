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
- `src/lib/diff/screenshot.ts` — `INJECT_SPACERS` + `alignedShots()`: inject and
  re-screenshot; falls back to the raw shots on failure.
- Client: `diffViewer.ts` / `browserCompare.ts` request the `-aligned` kinds in
  content mode.

## The self-improving loop

`verifyAlignment(a, ah, b, bh)` applies the plan and reports:
- `maxPairDelta` — worst matched-pair `y` misalignment (**the** signal; should be ~0),
- `heightGap` — plan under-fill (informational; the very bottom is covered by shot padding),
- `misaligned[]` — the offending `{ia, ib, dy}` pairs.

When a compare looks wrong:

1. **Reproduce it as a scaffold.** Add a marker set to
   `test/compare-align-verify.test.ts` (or pull the real markers — see below) that
   captures the exact shape (insertion, removal, reword, grid column, table cell,
   nested section, near-empty side). Assert `maxPairDelta <= 2`.
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

## This skill is SELF-IMPROVING

Treat it as living. Whenever you fix a new alignment failure mode: (a) add the
reproduction scaffold, (b) record the new invariant under "Known-good", and
(c) update the pipeline map if the code moved. The scaffolds + `verifyAlignment`
are the objective measure; this doc is the memory of *why*.
