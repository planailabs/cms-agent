/**
 * Screenshot diff — Playwright renders a route on the main instance and the
 * branch instance, pixelmatch highlights changed regions. Results cached by
 * (route, mainSha, branchSha) under TMPDIR/cms-agent-diffs (plan §6).
 *
 * Deliberately ephemeral (TMPDIR, not the persistent VAR_DIR): shots + markers
 * are derived artifacts, regenerable from branch content. Persisting them bloated
 * the data volume (deploy ENOSPC) and stranded stale shots across deploys; a
 * tmpdir clears on restart so every run regenerates fresh.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { env } from "@/lib/env";
import { GIT_COMMIT } from "@/lib/buildInfo";
import {
  COLLECT_MARKERS_JS,
  matchConfidence,
  type MarkerDoc,
} from "@/lib/compare/markers";
import { spacingPlan, type Spacer } from "@/lib/compare/layout";
import {
  ALIGN_CONFIDENCE_MIN,
  ALIGN_CORRECTIVE_ROUNDS,
  ALIGN_CORRECTIVE_THRESHOLD,
  runCorrectiveAlignment,
} from "@/lib/compare/converge";
import { reportAlignment } from "@/lib/compare/telemetry";
import {
  INJECT_SPACERS,
  PROBE_SPACER_OWNERS,
} from "@/lib/compare/inject";
import { branchSha, defaultBranch } from "@/lib/git/engine";
import { ensureInstance, previewOrigin } from "@/lib/preview/manager";
import type { PreviewDevice } from "@/lib/preview/devices";

// Content-aligned shots: the same page re-rendered with filler <div>s injected
// (a real reflow — no canvas slicing) so before/after content sits at the same
// y. The onion "content" mode overlays these directly.
export type ShotKind =
  "before" | "after" | "diff" | "before-aligned" | "after-aligned";
export type BrowserName = "chromium" | "firefox" | "webkit";
export const BROWSERS: readonly BrowserName[] = [
  "chromium",
  "firefox",
  "webkit",
];
const isBrowser = (v: string): v is BrowserName =>
  (BROWSERS as readonly string[]).includes(v);
export const asBrowser = (
  v: string | null | undefined,
  fallback: BrowserName,
): BrowserName => (v && isBrowser(v) ? v : fallback);

export interface DiffResult {
  route: string;
  changedPixels: number;
  totalPixels: number;
  files: Record<ShotKind, string>;
}

const VIEWPORT = { width: 1280, height: 900 };

function cacheDir(branch: string): string {
  // TMPDIR, not VAR_DIR — ephemeral by design (see file header).
  return path.join(os.tmpdir(), "cms-agent-diffs", branch);
}

function cacheKey(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Compare shots are keyed by the two shas — which is enough right up until the
 * agent starts working: an EXECUTE turn writes to the worktree for minutes
 * before it commits anything, and every one of those writes changes what the
 * preview serves while both shas stay exactly where they were. The compare
 * view would keep answering from the cache and show the user a page that no
 * longer exists.
 *
 * So the branch also carries a generation counter, bumped by whoever touched
 * the site (see markComparePreviewsOutdated). It is in-memory on purpose: a
 * restart loses the shots anyway (TMPDIR), and a bump that survived one would
 * only ever cost a recapture.
 */
const g = globalThis as unknown as { __compareGeneration?: Map<string, number> };
const generations = (): Map<string, number> => (g.__compareGeneration ??= new Map());

export const compareGeneration = (branch: string): number => generations().get(branch) ?? 0;

/**
 * Declare a branch's compare shots outdated: the next request recaptures.
 * The previous generation's files can never be served again, so they go now
 * rather than sitting in TMPDIR until a restart.
 */
export function markComparePreviewsOutdated(branch: string): number {
  const next = compareGeneration(branch) + 1;
  generations().set(branch, next);
  // Best-effort: a capture racing this bump writes under the NEW key, so the
  // worst case here is an orphan file, never a stale answer.
  fs.rmSync(cacheDir(branch), { recursive: true, force: true });
  return next;
}

/**
 * The before/after/diff/meta paths for a cache key, prefixed with the app
 * commit: if a TMPDIR happens to survive a redeploy, a new build looks up
 * `<commit>-<key>-*` and misses the previous build's shots/markers (which may
 * use an older collector) instead of serving them stale.
 */
function shotFiles(
  dir: string,
  key: string,
): Record<ShotKind, string> & { meta: string } {
  const base = path.join(dir, GIT_COMMIT ? `${GIT_COMMIT}-${key}` : key);
  return {
    before: `${base}-before.png`,
    after: `${base}-after.png`,
    diff: `${base}-diff.png`,
    "before-aligned": `${base}-before-aligned.png`,
    "after-aligned": `${base}-after-aligned.png`,
    meta: `${base}-meta.json`,
  };
}

/** Launch a browser and open one preview route; caller closes `launched`.
 *  With a device preset the page runs in a device-emulated context
 *  (viewport + UA + scale factor + touch; isMobile is chromium/webkit-only —
 *  playwright rejects it on firefox). */
async function openPage(
  port: number,
  route: string,
  browser: BrowserName,
  viewport = VIEWPORT,
  device?: PreviewDevice | null,
): Promise<{
  launched: import("playwright").Browser;
  page: import("playwright").Page;
  status: number | null;
}> {
  const playwright = await import("playwright");
  // chromiumSandbox: false — chromium's own SUID/namespace sandbox is
  // unreliable inside the container; the content is our own site preview.
  const launched = await playwright[browser].launch(
    browser === "chromium" ? { chromiumSandbox: false } : {},
  );
  try {
    const page = device
      ? await (
          await launched.newContext({
            viewport: { width: device.width, height: device.height },
            userAgent: device.userAgent,
            deviceScaleFactor: device.deviceScaleFactor,
            hasTouch: device.hasTouch,
            ...(browser === "firefox" ? {} : { isMobile: device.isMobile }),
          })
        ).newPage()
      : await launched.newPage({ viewport });
    // Connect on the host the dev server actually binds (previewOrigin).
    const response = await page.goto(`${previewOrigin(port)}${route}`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    return { launched, page, status: response?.status() ?? null };
  } catch (err) {
    await launched.close();
    throw err;
  }
}

const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** Capture one route of a branch's live preview (boots the preview if needed). */
export async function captureRoute(
  branch: string,
  route: string,
  outFile: string,
  opts: { browser?: BrowserName; mobile?: boolean } = {},
): Promise<{ status: number | null }> {
  const instance = await ensureInstance(branch);
  const { launched, page, status } = await openPage(
    instance.port,
    route,
    opts.browser ?? "chromium",
    opts.mobile ? MOBILE_VIEWPORT : VIEWPORT,
  );
  try {
    await page.screenshot({ path: outFile, fullPage: true });
  } finally {
    await launched.close();
  }
  return { status };
}

/**
 * Handoff capture: render the route on the branch preview, replay the user's
 * element-edit annotations with the shared renderer (bundled annotate entry,
 * same code the live edit mode uses), and screenshot the annotated page.
 * The annotation viewport is matched so document coordinates line up.
 */
export interface HandoffShots {
  /** The page as it is now, before anything was drawn on it. */
  before: Buffer;
  /** Moves and swaps carried out, nothing drawn — what the edit asks for.
   *  Absent when the annotation set changes no layout (drawings/comments only). */
  edited: Buffer | null;
  /** The same page with the user's marks on it: ghosts, arrows, pins. */
  annotated: Buffer;
  status: number | null;
}

export async function captureAnnotatedRoute(
  branch: string,
  route: string,
  annotations: import("@/injected/annotate").EditAnnotations,
): Promise<HandoffShots> {
  const { ANNOTATE_GLOBAL, annotateRuntimeSource } = await import("@/lib/injected/bundle");
  const source = await annotateRuntimeSource();
  const viewport = {
    width: Math.min(3840, Math.max(320, annotations.viewport.width || VIEWPORT.width)),
    height: Math.min(2400, Math.max(320, annotations.viewport.height || VIEWPORT.height)),
  };
  const instance = await ensureInstance(branch);
  const { launched, page, status } = await openPage(
    instance.port,
    route,
    "chromium",
    viewport,
  );
  try {
    // Three shots off ONE page load: the same layout, the same fonts, the same
    // lazy images. Reloading between them would let the page differ for
    // reasons that have nothing to do with the edit, which is exactly the
    // comparison the agent is being asked to make.
    const shot = () => page.screenshot({ fullPage: true });
    const before = await shot();
    if (status === null || status >= 400) {
      return { before, edited: null, annotated: before, status };
    }
    await page.addScriptTag({ content: source });

    const payload = JSON.stringify(annotations);
    const changesLayout =
      annotations.moves.length > 0 || (annotations.swaps?.length ?? 0) > 0;
    let edited: Buffer | null = null;
    if (changesLayout) {
      await page.evaluate(`${ANNOTATE_GLOBAL}.applyLayout(${payload})`);
      edited = await shot();
    }
    // apply() clears the layout-only pass first, so the marked-up shot is not
    // a double application of the same moves.
    await page.evaluate(`${ANNOTATE_GLOBAL}.apply(${payload})`);
    const annotated = await shot();
    return { before, edited, annotated, status };
  } finally {
    await launched.close();
  }
}

/** Raw shot: render the route, capture content markers next to it, screenshot. */
async function screenshot(
  port: number,
  route: string,
  outFile: string,
  browser: BrowserName = "chromium",
  device?: PreviewDevice | null,
): Promise<MarkerDoc | null> {
  const { launched, page } = await openPage(port, route, browser, VIEWPORT, device);
  let markers: MarkerDoc | null = null;
  try {
    // Content markers next to the shot — also tags each element (data-cmsm) so
    // the aligned pass can re-select it. Captured BEFORE the shot: same layout.
    try {
      markers = (await page.evaluate(COLLECT_MARKERS_JS)) as MarkerDoc;
      fs.writeFileSync(`${outFile}.markers.json`, JSON.stringify(markers));
    } catch (err) {
      console.warn(`[diff] marker collection failed for ${route}:`, err);
    }
    await page.screenshot({ path: outFile, fullPage: true });
  } finally {
    await launched.close();
  }
  return markers;
}

/** Pad two PNGs to identical dimensions in place (the onion overlays them). */
function padPair(fileA: string, fileB: string): void {
  try {
    const a = PNG.sync.read(fs.readFileSync(fileA));
    const b = PNG.sync.read(fs.readFileSync(fileB));
    const width = Math.max(a.width, b.width);
    const height = Math.max(a.height, b.height);
    const ap = padTo(a, width, height);
    const bp = padTo(b, width, height);
    if (ap !== a) fs.writeFileSync(fileA, PNG.sync.write(ap));
    if (bp !== b) fs.writeFileSync(fileB, PNG.sync.write(bp));
  } catch (err) {
    console.warn("[diff] aligned pad failed:", err);
  }
}

// A route+browser page held open after the structural reflow so a second
// (corrective) injection can be applied before the shot.
interface AlignedPage {
  launched: import("playwright").Browser;
  page: import("playwright").Page;
  markers: MarkerDoc;
}

/** Open a page, reflow it with the structural spacers, and re-collect markers —
 *  leaving it OPEN so a corrective pass can inject into the same DOM. */
async function openAligned(
  port: number,
  route: string,
  browser: BrowserName,
  spacers: Spacer[],
  device?: PreviewDevice | null,
): Promise<AlignedPage> {
  const { launched, page } = await openPage(port, route, browser, VIEWPORT, device);
  await page.evaluate(COLLECT_MARKERS_JS); // assign data-cmsm the plan indexes by
  if (spacers.length) {
    await page.evaluate(
      INJECT_SPACERS,
      spacers as Array<{ i: number; px: number; mode: string }>,
    );
  }
  const markers = (await page.evaluate(COLLECT_MARKERS_JS)) as MarkerDoc;
  return { launched, page, markers };
}

/** Render both aligned shots (best-effort) from a computed spacing plan. If the
 *  structural reflow leaves residual drift, a last-resort corrective pass patches
 *  it geometrically before the shot. */
async function alignedShots(
  aPort: number,
  bPort: number,
  route: string,
  files: Record<ShotKind, string>,
  markersA: MarkerDoc,
  markersB: MarkerDoc,
  browserA: BrowserName = "chromium",
  browserB: BrowserName = "chromium",
  device?: PreviewDevice | null,
): Promise<void> {
  const plan = spacingPlan(markersA.m, markersA.h, markersB.m, markersB.h);
  let A: AlignedPage | undefined;
  let B: AlignedPage | undefined;
  try {
    let [openedA, openedB] = await Promise.all([
      openAligned(aPort, route, browserA, plan.a, device),
      openAligned(bPort, route, browserB, plan.b, device),
    ]);
    A = openedA;
    B = openedB;
    // Last resort: whatever drift the structural pass left, iterate the corrective
    // (inject on the higher side → re-collect) so both sides converge until they
    // fit or there's nothing left to move.
    const inject = (p: AlignedPage, s: Spacer[]) =>
      s.length
        ? p.page.evaluate(
            INJECT_SPACERS,
            s as Array<{ i: number; px: number; mode: string }>,
          )
        : Promise.resolve();
    // Trust the shared match before polishing it. On a low-confidence page
    // (a big rewrite, heavy boilerplate, or a truncated capture) the corrective
    // would spend browser round-trips chasing a wrong correspondence, so stop at
    // the structural seed and let the diff read as coarse rather than confidently
    // misaligned. Graceful degradation, per the matcher-confidence council.
    const conf = matchConfidence(markersA, markersB);
    const alignStarted = Date.now();
    const aligned = await runCorrectiveAlignment(
      openedA.markers,
      openedB.markers,
      async (corr) => {
        await Promise.all([inject(openedA, corr.a), inject(openedB, corr.b)]);
        return (await Promise.all([
          openedA.page.evaluate(COLLECT_MARKERS_JS),
          openedB.page.evaluate(COLLECT_MARKERS_JS),
        ])) as [MarkerDoc, MarkerDoc];
      },
      {
        enabled: conf.score >= ALIGN_CONFIDENCE_MIN || conf.trustedRate > 0,
        trustedOnly: conf.score < ALIGN_CONFIDENCE_MIN,
        refinePlan: async (candidate) => {
          const [a, b] = await Promise.all([
            openedA.page.evaluate(PROBE_SPACER_OWNERS, candidate.a),
            openedB.page.evaluate(PROBE_SPACER_OWNERS, candidate.b),
          ]);
          return { a: a as Spacer[], b: b as Spacer[] };
        },
      },
    );
    reportAlignment({
      source: 'server',
      route,
      markersA: markersA.m.length,
      markersB: markersB.m.length,
      confidence: conf.score,
      matchRate: conf.matchRate,
      trustedRate: conf.trustedRate,
      truncated: conf.truncated,
      spacers: plan.a.length + plan.b.length,
      rounds: aligned.rounds,
      maxRounds: ALIGN_CORRECTIVE_ROUNDS,
      driftBefore: aligned.start,
      driftAfter: aligned.end.max,
      aborted: aligned.aborted,
      regressed: aligned.regressed,
      ms: Date.now() - alignStarted,
    });
    if (conf.score < ALIGN_CONFIDENCE_MIN || conf.truncated) {
      console.warn(
        `[align] ${route}: low match confidence ${conf.score.toFixed(2)}` +
          ` (rate ${conf.matchRate.toFixed(2)}, trusted ${conf.trustedRate.toFixed(2)},` +
          ` structural ${conf.structuralRate.toFixed(2)}/${conf.scopeCount},` +
          ` dup ${conf.dupPressure.toFixed(2)}` +
          `${conf.truncated ? ", TRUNCATED" : ""}) — correcting trusted anchors only`,
      );
    }
    if (aligned.regressed) {
      console.warn(
        `[align] ${route}: corrective regressed ${aligned.start}px → ${aligned.end.max}px;` +
          ` discarding mutations and capturing structural seed only`,
      );
      await Promise.all([openedA.launched.close(), openedB.launched.close()]);
      A = undefined;
      B = undefined;
      [openedA, openedB] = await Promise.all([
        openAligned(aPort, route, browserA, plan.a, device),
        openAligned(bPort, route, browserB, plan.b, device),
      ]);
      A = openedA;
      B = openedB;
    }
    // Round-count is the guillotine seed's value signal: the structural pass
    // converges most pages in 0 corrective rounds; a page that needs many rounds
    // (or hits the cap without converging) is where the aligner should improve.
    if (
      conf.score >= ALIGN_CONFIDENCE_MIN &&
      Math.abs(aligned.start) > ALIGN_CORRECTIVE_THRESHOLD
    ) {
      console.warn(
        `[align] ${route}: corrective ${aligned.start}px → ${aligned.end.max}px in ${aligned.rounds} round(s)`,
        Math.abs(aligned.end.max) > ALIGN_CORRECTIVE_THRESHOLD
          ? JSON.stringify(aligned.end.worst)
          : "",
      );
    }
    await Promise.all([
      openedA.page.screenshot({
        path: files["before-aligned"],
        fullPage: true,
      }),
      openedB.page.screenshot({ path: files["after-aligned"], fullPage: true }),
    ]);
    padPair(files["before-aligned"], files["after-aligned"]);
  } catch (err) {
    console.warn("[diff] aligned shots failed:", err);
    // Fall back to the raw shots so the content mode still has something.
    try {
      fs.copyFileSync(files.before, files["before-aligned"]);
      fs.copyFileSync(files.after, files["after-aligned"]);
    } catch {
      /* raw shots also missing — the mode just 404s */
    }
  } finally {
    await Promise.all([A?.launched.close(), B?.launched.close()]);
  }
}

/**
 * pixelmatch two PNG files into a diff PNG; returns changed pixel count.
 * fullPage screenshots differ in height (content / font metrics), so all
 * three PNGs are normalized to the same (max) dimensions — the before/after
 * files are rewritten padded, so the onion/highlight overlays line up.
 */
function pixelDiff(
  fileA: string,
  fileB: string,
  diffOut: string,
): { changed: number; total: number } {
  const a = PNG.sync.read(fs.readFileSync(fileA));
  const b = PNG.sync.read(fs.readFileSync(fileB));
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const ap = padTo(a, width, height);
  const bp = padTo(b, width, height);
  if (ap !== a) fs.writeFileSync(fileA, PNG.sync.write(ap));
  if (bp !== b) fs.writeFileSync(fileB, PNG.sync.write(bp));
  const diff = new PNG({ width, height });
  const changed = pixelmatch(ap.data, bp.data, diff.data, width, height, {
    threshold: 0.1,
    diffColor: [255, 64, 64],
    diffColorAlt: [64, 128, 255],
    alpha: 0.4,
  });
  fs.writeFileSync(diffOut, PNG.sync.write(diff));
  return { changed, total: width * height };
}

/** Pad both PNGs to identical dimensions (white background). */
function padTo(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height, fill: true });
  out.data.fill(255);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  return out;
}

/**
 * Single-flight per cache key: the compare UI fetches before/after/diff (and
 * markers) CONCURRENTLY — on a cache miss every request used to start its
 * own screenshot run into the SAME files, interleaving writes with reads
 * (pngjs: "unrecognised content at end of stream"). globalThis-backed so a
 * dev HMR reload cannot split the map (see AGENTS.md singleton rule).
 */
const gsf = globalThis as unknown as {
  __cmsShotFlight?: Map<string, Promise<DiffResult>>;
};
const inFlight = (gsf.__cmsShotFlight ??= new Map());

function singleFlight(
  key: string,
  run: () => Promise<DiffResult>,
): Promise<DiffResult> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Produce before/after/diff PNGs for a route. Boots both preview instances
 * if needed. Cached per commit pair.
 */
export async function diffRoute(
  branch: string,
  route: string,
  base?: string,
): Promise<DiffResult> {
  const main = base ?? (await defaultBranch());
  const [mainRef, branchRef] = await Promise.all([
    branchSha(main),
    branchSha(branch),
  ]);
  const key = cacheKey(route, mainRef, branchRef, String(compareGeneration(branch)));
  const dir = cacheDir(branch);
  fs.mkdirSync(dir, { recursive: true });

  const { meta: metaFile, ...files } = shotFiles(dir, key);

  return singleFlight(key, async () => {
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as DiffResult;
      if (Object.values(files).every((f) => fs.existsSync(f))) return meta;
    }

    const [mainInstance, branchInstance] = await Promise.all([
      ensureInstance(main),
      ensureInstance(branch),
    ]);

    const [ma, mb] = await Promise.all([
      screenshot(mainInstance.port, route, files.before),
      screenshot(branchInstance.port, route, files.after),
    ]);

    const { changed, total } = pixelDiff(files.before, files.after, files.diff);
    // Aligned shots for the onion "content" mode — real reflow, not canvas.
    if (ma && mb) {
      await alignedShots(
        mainInstance.port,
        branchInstance.port,
        route,
        files,
        ma,
        mb,
      );
    }
    const result: DiffResult = {
      route,
      changedPixels: changed,
      totalPixels: total,
      files,
    };
    fs.writeFileSync(metaFile, JSON.stringify(result));
    return result;
  });
}

/**
 * Cross-browser diff: render the SAME branch/route in two browser engines and
 * pixelmatch them. before = browserA, after = browserB. Cached per
 * (route, sha, browserA, browserB).
 */
export async function diffBrowsers(
  branch: string,
  route: string,
  browserA: BrowserName,
  browserB: BrowserName,
  device?: PreviewDevice | null,
): Promise<DiffResult> {
  const ref = await branchSha(branch);
  const key = cacheKey(
    "browsers",
    route,
    ref,
    browserA,
    browserB,
    device?.key ?? "",
    String(compareGeneration(branch)),
  );
  const dir = cacheDir(branch);
  fs.mkdirSync(dir, { recursive: true });

  const { meta: metaFile, ...files } = shotFiles(dir, key);

  return singleFlight(key, async () => {
    if (
      fs.existsSync(metaFile) &&
      Object.values(files).every((f) => fs.existsSync(f))
    ) {
      return JSON.parse(fs.readFileSync(metaFile, "utf8")) as DiffResult;
    }

    const instance = await ensureInstance(branch);
    const [ma, mb] = await Promise.all([
      screenshot(instance.port, route, files.before, browserA, device),
      screenshot(instance.port, route, files.after, browserB, device),
    ]);

    const { changed, total } = pixelDiff(files.before, files.after, files.diff);
    if (ma && mb) {
      await alignedShots(
        instance.port,
        instance.port,
        route,
        files,
        ma,
        mb,
        browserA,
        browserB,
        device,
      );
    }
    const result: DiffResult = {
      route,
      changedPixels: changed,
      totalPixels: total,
      files,
    };
    fs.writeFileSync(metaFile, JSON.stringify(result));
    return result;
  });
}
