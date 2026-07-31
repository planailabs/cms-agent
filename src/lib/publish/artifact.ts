/**
 * Sealed build artifacts (plan §12): clean checkout of the exact sha in a
 * temp worktree → site backend's build command → manifest (path/size/sha256
 * per file) + tarball under VAR_DIR/artifacts. A retry for the same sha
 * reuses the sealed artifact instead of rebuilding.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { simpleGit } from 'simple-git';
import { env } from '@/lib/env';
import { ensureSandbox, spawnSandboxed, type SandboxState } from '@/lib/sandbox';
import { hasErrors, validateDist } from '@/lib/validate';
import { activeBackend } from '@/lib/site';

/**
 * Never part of a dist: node_modules trees and git metadata. Required for the
 * no-build (static) case where the dist IS the checkout — the temp worktree
 * carries a `.git` pointer file that must not leak into manifest or tarball.
 */
export const DIST_SKIP = new Set(['.git', 'node_modules']);

export interface ArtifactInfo {
  sha: string;
  tarballPath: string;
  distDir: string;
  manifest: Array<{ path: string; size: number; sha256: string }>;
  buildMeta: Record<string, string>;
}

const artifactsDir = () => path.join(path.resolve(env().VAR_DIR), 'artifacts');

function run(
  sb: SandboxState,
  command: string,
  cwd: string,
  sessionKey: string,
  log: (l: string) => void,
  nodeEnv: 'development' | 'production' = 'production',
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Streamed for live publish_log; runs in the jail like all site commands.
    const child = spawnSandboxed(sb, ['/bin/sh', '-lc', command], { cwd, sessionKey, nodeEnv });
    child.stdout?.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(log));
    child.stderr?.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(log));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`\`${command}\` exited with code ${code}`)),
    );
  });
}

function* walkFiles(dir: string, root: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (DIST_SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full, root);
    else if (entry.isFile()) yield path.relative(root, full);
  }
}

export const distFilter = (src: string): boolean => !DIST_SKIP.has(path.basename(src));

export interface BuiltCheckout {
  /** Built output inside the temp worktree (backend.resolveDist). */
  dist: string;
  backendId: string;
  /** null when the backend has no build step (the checkout IS the dist). */
  buildCommand: string | null;
}

/**
 * Clean checkout of `sha` → site-backend build → pre-publish dist validation,
 * handed to `use`. The temp worktree lives only for that call.
 *
 * This is the whole type-specific build knowledge in one place: `astro build`
 * for an Astro repo, nothing but the checkout for a static one. Both the
 * sealed artifact and the deploy pre-validation step go through it, so a flow
 * that never seals an artifact still gets the same build gate.
 */
export async function withBuiltCheckout<T>(
  sha: string,
  log: (l: string) => void,
  use: (built: BuiltCheckout) => Promise<T> | T,
): Promise<T> {
  const e = env();
  const dir = artifactsDir();
  fs.mkdirSync(dir, { recursive: true });

  const buildDir = path.join(dir, `${sha}-build`);
  const git = simpleGit(path.resolve(e.REPO_PATH));
  await git.raw(['worktree', 'prune']);
  if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
  await git.raw(['worktree', 'add', '--detach', buildDir, sha]);

  try {
    const backend = activeBackend();
    const buildCommand = backend.buildCommand();
    if (buildCommand) {
      const sb = await ensureSandbox();
      log(`Building ${sha.slice(0, 8)} with: ${buildCommand}`);
      // Site deps: install if the checkout has none (worktrees don't share node_modules)
      if (fs.existsSync(path.join(buildDir, 'package.json')) && !fs.existsSync(path.join(buildDir, 'node_modules'))) {
        log('Installing site dependencies…');
        // --include=dev: NODE_ENV=production would omit devDependencies,
        // where site build tooling (astro, integrations) usually lives
        await run(sb, 'npm install --no-audit --no-fund --include=dev', buildDir, sha, log, 'development');
      }
      await run(sb, buildCommand, buildDir, sha, log, 'production');
    } else {
      log('No build step for this site backend — using the checkout as-is');
    }

    const dist = backend.resolveDist(buildDir);

    // Pre-publish validation: no CMS/overlay code in production output,
    // local links resolve (medved §21.2)
    const distIssues = validateDist(dist);
    for (const issue of distIssues) log(`[validate:${issue.severity}] ${issue.message}`);
    if (hasErrors(distIssues)) {
      throw new Error('Pre-publish validation failed — see log for details');
    }

    return await use({ dist, backendId: backend.id, buildCommand });
  } finally {
    await git.raw(['worktree', 'remove', '--force', buildDir]).catch(() => undefined);
  }
}

/**
 * Deploy pre-flight for ANY flow: prove the sha builds and its output passes
 * the dist validators, without sealing anything. Flows that push instead of
 * uploading (git-push, github-ci) never build otherwise, so this is the only
 * thing standing between a broken `astro build` and the target branch.
 */
export async function prevalidateBuild(sha: string, log: (l: string) => void): Promise<void> {
  await withBuiltCheckout(sha, log, ({ backendId, buildCommand }) => {
    log(`Pre-validation passed for ${sha.slice(0, 8)} (${backendId}: ${buildCommand ?? 'no build step'}).`);
  });
}

/** Build (or reuse) the sealed artifact for a sha. */
export async function sealArtifact(sha: string, log: (l: string) => void): Promise<ArtifactInfo> {
  const dir = artifactsDir();
  fs.mkdirSync(dir, { recursive: true });

  const tarballPath = path.join(dir, `${sha}.tar.gz`);
  const metaPath = path.join(dir, `${sha}.json`);
  const distDir = path.join(dir, `${sha}-dist`);

  if (fs.existsSync(metaPath) && fs.existsSync(tarballPath) && fs.existsSync(distDir)) {
    log(`Reusing sealed artifact for ${sha.slice(0, 8)}`);
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ArtifactInfo;
  }

  return withBuiltCheckout(sha, log, async ({ dist: builtDist, backendId, buildCommand }) => {
    // Manifest with per-file hashes
    const manifest: ArtifactInfo['manifest'] = [];
    for (const rel of walkFiles(builtDist, builtDist)) {
      const buf = fs.readFileSync(path.join(builtDist, rel));
      manifest.push({
        path: rel,
        size: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
      });
    }

    if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
    fs.cpSync(builtDist, distDir, { recursive: true, filter: distFilter });

    await tar.create(
      { gzip: true, file: tarballPath, cwd: builtDist, filter: distFilter },
      ['.'],
    );

    const info: ArtifactInfo = {
      sha,
      tarballPath,
      distDir,
      manifest,
      buildMeta: {
        gitSha: sha,
        node: process.version,
        backend: backendId,
        buildCommand: buildCommand ?? '(none)',
        builtAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(metaPath, JSON.stringify(info, null, 2));
    log(`Artifact sealed: ${manifest.length} files, tarball ${path.basename(tarballPath)}`);
    return info;
  });
}
