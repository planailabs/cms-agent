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
import { COLLECT_MARKERS_JS, type MarkerDoc } from "@/lib/compare/markers";
import {
  correctiveFlat,
  matchedYDelta,
  spacingPlan,
  type Spacer,
} from "@/lib/compare/layout";
import { INJECT_SPACERS } from "@/lib/compare/inject";
import { branchSha, defaultBranch } from "@/lib/git/engine";
import { ensureInstance } from "@/lib/preview/manager";

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

/** Raw shot: render the route, capture content markers next to it, screenshot. */
async function screenshot(
  port: number,
  route: string,
  outFile: string,
  browser: BrowserName = "chromium",
): Promise<MarkerDoc | null> {
  const playwright = await import("playwright");
  // chromiumSandbox: false — chromium's own SUID/namespace sandbox is
  // unreliable inside the container; the content is our own site preview.
  const launched = await playwright[browser].launch(
    browser === "chromium" ? { chromiumSandbox: false } : {},
  );
  let markers: MarkerDoc | null = null;
  try {
    const page = await launched.newPage({ viewport: VIEWPORT });
    // Connect on the host the dev server actually binds (HOST — ::1 in dev,
    // 127.0.0.1 in prod); v6 needs brackets.
    const host = env().HOST;
    const h = host.includes(":") ? `[${host}]` : host;
    await page.goto(`http://${h}:${port}${route}`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
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
): Promise<AlignedPage> {
  const playwright = await import("playwright");
  const launched = await playwright[browser].launch(
    browser === "chromium" ? { chromiumSandbox: false } : {},
  );
  const page = await launched.newPage({ viewport: VIEWPORT });
  const host = env().HOST;
  const h = host.includes(":") ? `[${host}]` : host;
  await page.goto(`http://${h}:${port}${route}`, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
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

const CORRECTIVE_THRESHOLD = 8; // px residual that trips the last-resort patch
const CORRECTIVE_ROUNDS = 6; // max iterations to converge both sides

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
): Promise<void> {
  const plan = spacingPlan(markersA.m, markersA.h, markersB.m, markersB.h);
  let A: AlignedPage | undefined;
  let B: AlignedPage | undefined;
  try {
    [A, B] = await Promise.all([
      openAligned(aPort, route, browserA, plan.a),
      openAligned(bPort, route, browserB, plan.b),
    ]);
    let ra = A.markers;
    let rb = B.markers;
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
    const start = matchedYDelta(ra.m, rb.m).max;
    let rounds = 0;
    for (let round = 0; round < CORRECTIVE_ROUNDS; round++) {
      if (Math.abs(matchedYDelta(ra.m, rb.m).max) <= CORRECTIVE_THRESHOLD)
        break;
      rounds = round + 1;
      const corr = correctiveFlat(ra.m, rb.m);
      if (!corr.a.length && !corr.b.length) break;
      await Promise.all([inject(A, corr.a), inject(B, corr.b)]);
      [ra, rb] = (await Promise.all([
        A.page.evaluate(COLLECT_MARKERS_JS),
        B.page.evaluate(COLLECT_MARKERS_JS),
      ])) as [MarkerDoc, MarkerDoc];
    }
    const end = matchedYDelta(ra.m, rb.m);
    // Round-count is the guillotine seed's value signal: the structural pass
    // converges most pages in 0 corrective rounds; a page that needs many rounds
    // (or hits the cap without converging) is where the aligner should improve.
    if (Math.abs(start) > CORRECTIVE_THRESHOLD) {
      console.warn(
        `[align] ${route}: corrective ${start}px → ${end.max}px in ${rounds} round(s)`,
        Math.abs(end.max) > CORRECTIVE_THRESHOLD
          ? JSON.stringify(end.worst)
          : "",
      );
    }
    await Promise.all([
      A.page.screenshot({ path: files["before-aligned"], fullPage: true }),
      B.page.screenshot({ path: files["after-aligned"], fullPage: true }),
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
  const key = cacheKey(route, mainRef, branchRef);
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
): Promise<DiffResult> {
  const ref = await branchSha(branch);
  const key = cacheKey("browsers", route, ref, browserA, browserB);
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
      screenshot(instance.port, route, files.before, browserA),
      screenshot(instance.port, route, files.after, browserB),
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
