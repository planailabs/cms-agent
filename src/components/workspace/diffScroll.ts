/**
 * Scroll-sync for the side-by-side diff iframes. They are cross-origin
 * (<branch>.<BASE_DOMAIN>), so the parent can't touch their scroll directly —
 * we go through the injected bootstrap's cms:eval channel (same trust model
 * the preview agent already uses): on each iframe's cms:agent-ready we eval a
 * tiny reporter/receiver into it, then relay cms:scroll from one iframe to the
 * other as cms:scroll-to. In content mode, the same bridge also injects the
 * live spacer plan into both iframes so the editable before/after documents
 * line up structurally, not just by scroll fraction.
 */

const IFRAME_IDS = ["ws-diff-before", "ws-diff-after"] as const;

import {
  bracketAnchors,
  COLLECT_MARKERS_JS,
  computeAnchors,
  mapPosition,
  matchConfidence,
  type Anchor,
  type MarkerDoc,
} from "@/lib/compare/markers";
import { spacingPlan, type Spacer } from "@/lib/compare/layout";
import {
  ALIGN_CONFIDENCE_MIN,
  ALIGN_CORRECTIVE_ROUNDS,
  runCorrectiveAlignment,
} from "@/lib/compare/converge";
import { reportAlignment } from "@/lib/compare/telemetry";
import {
  INJECT_SPACERS,
  PROBE_SPACER_OWNERS,
} from "@/lib/compare/inject";
import { store } from "../chat/app/store";
import type { AppState } from "../chat/app/state";
import { onDiffFrameNavigated } from "./diffViewer";
import { createFrameRpc } from "./frameRpc";

/** Marker docs per iframe id (repopulated on every document load). */
const markerDocs = new Map<string, MarkerDoc>();
/** Bracketed anchors keyed by direction ("srcId>dstId"), invalidated on
 *  marker updates. */
let anchorCache = new Map<string, Anchor[]>();
const REQUEST_TIMEOUT_MS = 15_000;
let appliedSig: string | null = null;
let aligningSig: string | null = null;
let lastMode: "height" | "content" = "height";
let correctiveSkipSig: string | null = null;
const readySrc = new Map<string, string>();

const anchorsFor = (srcId: string, dstId: string): Anchor[] | null => {
  const key = `${srcId}>${dstId}`;
  const cached = anchorCache.get(key);
  if (cached) return cached;
  const a = markerDocs.get(srcId);
  const b = markerDocs.get(dstId);
  if (!a || !b) return null;
  const bracketed = bracketAnchors(computeAnchors(a.m, b.m), a.h, b.h);
  anchorCache.set(key, bracketed);
  return bracketed;
};

// Runs inside each preview iframe (has `agent` in scope, per bootstrap eval).
// Echo suppression is by position, not timing: the scroll event caused by a
// a programmatic scroll event can arrive after the next rAF, so a timed "applying"
// flag leaks echoes back to the other pane and the two fight (jitter). Instead
// we remember the target we set and swallow the one event that lands on it.
export const DIFF_SCROLL_SYNC_CODE = `
if (!window.__cmsScrollSync) {
  window.__cmsScrollSync = true;
  var el = document.scrollingElement || document.documentElement;
  function forceInstantScroll() {
    document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
    if (document.body) document.body.style.setProperty('scroll-behavior', 'auto', 'important');
    el.style.setProperty('scroll-behavior', 'auto', 'important');
  }
  forceInstantScroll();
  var expected = -1;
  window.addEventListener('scroll', function () {
    if (expected >= 0) {
      var wasEcho = Math.abs(el.scrollTop - expected) < 2;
      expected = -1;
      if (wasEcho) return;
    }
    var max = el.scrollHeight - el.clientHeight;
    agent.post({
      type: 'cms:scroll',
      frac: max > 0 ? el.scrollTop / max : 0,
      top: el.scrollTop,
    });
  }, { passive: true });
  agent.on('cms:scroll-to', function (d) {
    var max = el.scrollHeight - el.clientHeight;
    var top = d && typeof d.top === 'number'
      ? Math.min(Math.max(0, d.top), max)
      : (d && typeof d.frac === 'number' ? d.frac : 0) * max;
    if (Math.abs(el.scrollTop - top) < 1) return;
    expected = top;
    // Reassert in case site code changed the inline style after setup.
    forceInstantScroll();
    el.scrollTop = top;
  });
  agent.post({ type: 'cms:markers', doc: ${COLLECT_MARKERS_JS} });
}
`;

const iframeById = (id: string) =>
  document.getElementById(id) as HTMLIFrameElement | null;
// Transport only (ids, timeouts, origin pinning) — see frameRpc.ts.
const rpc = createFrameRpc({
  prefix: "diff-scroll",
  timeoutMs: REQUEST_TIMEOUT_MS,
  unavailable: "Diff iframe is not available",
  timedOut: (_msg, iframe) => `Diff iframe request timed out: ${iframe.id}`,
});
const postTo = (f: HTMLIFrameElement, msg: Record<string, unknown>): void => {
  rpc.post(f, msg);
};
const currentSig = (): string | null => {
  const a = iframeById(IFRAME_IDS[0]);
  const b = iframeById(IFRAME_IDS[1]);
  if (!a?.src || !b?.src) return null;
  return `${a.src}|${b.src}`;
};
const requestEval = (
  iframe: HTMLIFrameElement,
  code: string,
): Promise<unknown> => rpc.request(iframe, { type: "cms:eval", code });
const settle = rpc.settle;
const collectDoc = (iframe: HTMLIFrameElement): Promise<MarkerDoc> =>
  requestEval(iframe, `return ${COLLECT_MARKERS_JS};`) as Promise<MarkerDoc>;
const applyAndCollect = (
  iframe: HTMLIFrameElement,
  spacers: Spacer[],
): Promise<MarkerDoc> =>
  requestEval(
    iframe,
    `(${INJECT_SPACERS.toString()})(${JSON.stringify(
      spacers,
    )}); return ${COLLECT_MARKERS_JS};`,
  ) as Promise<MarkerDoc>;
const probeOwners = (
  iframe: HTMLIFrameElement,
  spacers: Spacer[],
): Promise<Spacer[]> =>
  requestEval(
    iframe,
    `return (${PROBE_SPACER_OWNERS.toString()})(${JSON.stringify(spacers)});`,
  ) as Promise<Spacer[]>;
const reloadFrames = (): void => {
  for (const id of IFRAME_IDS) {
    const iframe = iframeById(id);
    if (iframe?.src) iframe.src = iframe.src;
  }
  markerDocs.clear();
  anchorCache = new Map();
  readySrc.clear();
  appliedSig = null;
  aligningSig = null;
};
const setDocs = (a: MarkerDoc, b: MarkerDoc): void => {
  markerDocs.set(IFRAME_IDS[0], a);
  markerDocs.set(IFRAME_IDS[1], b);
  anchorCache = new Map();
};
const alignLiveFrames = async (sig: string): Promise<void> => {
  if (aligningSig === sig || appliedSig === sig) return;
  const before = iframeById(IFRAME_IDS[0]);
  const after = iframeById(IFRAME_IDS[1]);
  if (!before || !after) return;
  aligningSig = sig;
  try {
    let [a, b] = (await Promise.all([
      collectDoc(before),
      collectDoc(after),
    ])) as [MarkerDoc, MarkerDoc];
    if (currentSig() !== sig || store.state.workspace.compareMode !== "content")
      return;
    const confidence = matchConfidence(a, b);
    const markerCounts = [a.m.length, b.m.length] as const;
    const alignStarted = performance.now();
    const plan = spacingPlan(a.m, a.h, b.m, b.h);
    [a, b] = (await Promise.all([
      applyAndCollect(before, plan.a),
      applyAndCollect(after, plan.b),
    ])) as [MarkerDoc, MarkerDoc];
    const aligned = await runCorrectiveAlignment(
      a,
      b,
      async (corr) =>
        (await Promise.all([
          applyAndCollect(before, corr.a),
          applyAndCollect(after, corr.b),
        ])) as [MarkerDoc, MarkerDoc],
      {
        enabled:
          (confidence.score >= ALIGN_CONFIDENCE_MIN ||
            confidence.trustedRate > 0) &&
          correctiveSkipSig !== sig,
        trustedOnly: confidence.score < ALIGN_CONFIDENCE_MIN,
        isCurrent: () =>
          currentSig() === sig &&
          store.state.workspace.compareMode === "content",
        refinePlan: async (candidate) => {
          const [a, b] = await Promise.all([
            probeOwners(before, candidate.a),
            probeOwners(after, candidate.b),
          ]);
          return { a, b };
        },
      },
    );
    reportAlignment({
      source: "live",
      route: sig,
      markersA: markerCounts[0],
      markersB: markerCounts[1],
      confidence: confidence.score,
      matchRate: confidence.matchRate,
      trustedRate: confidence.trustedRate,
      truncated: confidence.truncated,
      spacers: plan.a.length + plan.b.length,
      rounds: aligned.rounds,
      maxRounds: ALIGN_CORRECTIVE_ROUNDS,
      driftBefore: aligned.start,
      driftAfter: aligned.end.max,
      aborted: aligned.aborted,
      regressed: aligned.regressed,
      ms: performance.now() - alignStarted,
    });
    if (aligned.aborted) return;
    if (aligned.regressed) {
      correctiveSkipSig = sig;
      reloadFrames();
      return;
    }
    setDocs(aligned.a, aligned.b);
    appliedSig = sig;
  } catch (err) {
    console.warn("[diff-scroll] live side-by-side alignment failed:", err);
  } finally {
    if (aligningSig === sig) aligningSig = null;
  }
};

let seq = 0;
let registered = false;

/** Leader latch: whichever pane scrolled most recently drives; cms:scroll from
 *  the other pane is dropped while the latch is fresh, so a late echo can't
 *  steer the pane the user is actually scrolling. */
let leaderId: string | null = null;
let leaderUntil = 0;
const LEADER_MS = 150;

/** Register once at app init; acts only while the diff iframes exist. */
export const registerDiffScrollSync = (): void => {
  if (registered) return;
  registered = true;

  window.addEventListener("message", (ev: MessageEvent) => {
    const frames = IFRAME_IDS.map(iframeById);
    // One of the two diff iframes, at its own origin — anything else is
    // ignored (frameRpc.senderOf).
    const src = rpc.senderOf(ev, frames);
    if (!src) return;

    const data = ev.data as {
      type?: string;
      id?: string;
      ok?: boolean;
      value?: unknown;
      error?: string;
      frac?: number;
      top?: number;
      route?: string;
      doc?: MarkerDoc;
    } | null;
    if (!data || typeof data.type !== "string") return;

    if (data.type === "cms:agent-ready") {
      markerDocs.delete(src.id); // new document — old markers are stale
      anchorCache = new Map();
      readySrc.set(src.id, src.src);
      // The user browsed inside this pane → tabs + the other pane follow.
      if (typeof data.route === "string") onDiffFrameNavigated(data.route);
      if (appliedSig && currentSig() !== appliedSig) appliedSig = null;
      if (correctiveSkipSig && currentSig() !== correctiveSkipSig)
        correctiveSkipSig = null;
      postTo(src, {
        type: "cms:eval",
        id: `scroll-sync-${++seq}`,
        code: DIFF_SCROLL_SYNC_CODE,
      });
      void syncDiffContentAlignment(store.state);
    } else if (data.type === "cms:eval-result" && typeof data.id === "string") {
      settle(data.id, data.ok === true, data.value, data.error);
    } else if (
      data.type === "cms:markers" &&
      data.doc &&
      Array.isArray(data.doc.m)
    ) {
      markerDocs.set(src.id, data.doc);
      anchorCache = new Map();
    } else if (data.type === "cms:scroll" && typeof data.frac === "number") {
      const now = performance.now();
      if (leaderId && leaderId !== src.id && now < leaderUntil) return;
      leaderId = src.id;
      leaderUntil = now + LEADER_MS;
      const other = frames.find((f) => f && f !== src);
      if (!other) return;
      // 'content' mode: map the absolute position through the matched
      // content anchors; fall back to fraction sync without markers.
      const anchors =
        store.state.workspace.compareMode === "content" &&
        typeof data.top === "number"
          ? anchorsFor(src.id, other.id)
          : null;
      if (anchors) {
        postTo(other, {
          type: "cms:scroll-to",
          top: mapPosition(data.top!, anchors),
        });
      } else {
        postTo(other, { type: "cms:scroll-to", frac: data.frac });
      }
    }
  });
};

/** Keep the live side-by-side iframes aligned with the current compare mode.
 *  In content mode we inject the same spacer plan the screenshot pipeline uses;
 *  switching back to height mode reloads the iframes once to drop those
 *  injected spacers and restore the untouched documents. */
export const syncDiffContentAlignment = async (
  state: AppState,
): Promise<void> => {
  const mode = state.workspace.compareMode;
  const before = iframeById(IFRAME_IDS[0]);
  const after = iframeById(IFRAME_IDS[1]);
  if (!before || !after) {
    readySrc.clear();
    appliedSig = null;
    aligningSig = null;
    lastMode = mode;
    return;
  }
  if (mode === "height") {
    if (lastMode === "content" && appliedSig) reloadFrames();
    lastMode = mode;
    return;
  }
  lastMode = mode;
  const sig = currentSig();
  if (
    readySrc.get(before.id) !== before.src ||
    readySrc.get(after.id) !== after.src
  )
    return;
  if (!sig || appliedSig === sig || aligningSig === sig) return;
  await alignLiveFrames(sig);
};
