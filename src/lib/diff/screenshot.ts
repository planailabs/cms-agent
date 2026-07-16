/**
 * Screenshot diff — Playwright renders a route on the main instance and the
 * branch instance, pixelmatch highlights changed regions. Results cached by
 * (route, mainSha, branchSha) under VAR_DIR/diffs (plan §6).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { env } from '@/lib/env';
import { branchSha, defaultBranch } from '@/lib/git/engine';
import { ensureInstance } from '@/lib/preview/manager';

export type ShotKind = 'before' | 'after' | 'diff';

export interface DiffResult {
  route: string;
  changedPixels: number;
  totalPixels: number;
  files: Record<ShotKind, string>;
}

const VIEWPORT = { width: 1280, height: 900 };

function cacheDir(branch: string): string {
  return path.join(path.resolve(env().VAR_DIR), 'diffs', branch);
}

function cacheKey(route: string, mainRef: string, branchRef: string): string {
  return createHash('sha256').update(`${route}|${mainRef}|${branchRef}`).digest('hex').slice(0, 16);
}

async function screenshot(port: number, route: string, outFile: string): Promise<void> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.screenshot({ path: outFile, fullPage: true });
  } finally {
    await browser.close();
  }
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
 * Produce before/after/diff PNGs for a route. Boots both preview instances
 * if needed. Cached per commit pair.
 */
export async function diffRoute(branch: string, route: string, base?: string): Promise<DiffResult> {
  const main = base ?? (await defaultBranch());
  const [mainRef, branchRef] = await Promise.all([branchSha(main), branchSha(branch)]);
  const key = cacheKey(route, mainRef, branchRef);
  const dir = cacheDir(branch);
  fs.mkdirSync(dir, { recursive: true });

  const files: Record<ShotKind, string> = {
    before: path.join(dir, `${key}-before.png`),
    after: path.join(dir, `${key}-after.png`),
    diff: path.join(dir, `${key}-diff.png`),
  };
  const metaFile = path.join(dir, `${key}-meta.json`);

  if (fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as DiffResult;
    if (Object.values(files).every((f) => fs.existsSync(f))) return meta;
  }

  const [mainInstance, branchInstance] = await Promise.all([
    ensureInstance(main),
    ensureInstance(branch),
  ]);

  await Promise.all([
    screenshot(mainInstance.port, route, files.before),
    screenshot(branchInstance.port, route, files.after),
  ]);

  const before = PNG.sync.read(fs.readFileSync(files.before));
  const after = PNG.sync.read(fs.readFileSync(files.after));
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const beforePadded = padTo(before, width, height);
  const afterPadded = padTo(after, width, height);

  const diff = new PNG({ width, height });
  const changedPixels = pixelmatch(
    beforePadded.data,
    afterPadded.data,
    diff.data,
    width,
    height,
    { threshold: 0.1, diffColor: [255, 64, 64], diffColorAlt: [64, 128, 255], alpha: 0.4 },
  );
  fs.writeFileSync(files.diff, PNG.sync.write(diff));

  const result: DiffResult = {
    route,
    changedPixels,
    totalPixels: width * height,
    files,
  };
  fs.writeFileSync(metaFile, JSON.stringify(result));
  return result;
}
