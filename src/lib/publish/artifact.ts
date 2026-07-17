/**
 * Sealed build artifacts (plan §12): clean checkout of the exact sha in a
 * temp worktree → REPO_BUILD_COMMAND → manifest (path/size/sha256 per file)
 * + tarball under VAR_DIR/artifacts. A retry for the same sha reuses the
 * sealed artifact instead of rebuilding.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { simpleGit } from 'simple-git';
import { env } from '@/lib/env';
import { ensureSandbox, spawnSandboxed, type SandboxState } from '@/lib/sandbox';
import { hasErrors, validateDist } from '@/lib/validate';

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
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full, root);
    else if (entry.isFile()) yield path.relative(root, full);
  }
}

/** Build (or reuse) the sealed artifact for a sha. */
export async function sealArtifact(sha: string, log: (l: string) => void): Promise<ArtifactInfo> {
  const e = env();
  const dir = artifactsDir();
  fs.mkdirSync(dir, { recursive: true });

  const tarballPath = path.join(dir, `${sha}.tar.gz`);
  const metaPath = path.join(dir, `${sha}.json`);
  const distDir = path.join(dir, `${sha}-dist`);

  if (fs.existsSync(metaPath) && fs.existsSync(tarballPath) && fs.existsSync(distDir)) {
    log(`Reusing sealed artifact for ${sha.slice(0, 8)}`);
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ArtifactInfo;
  }

  // Clean checkout of the exact sha in a temp worktree
  const buildDir = path.join(dir, `${sha}-build`);
  const git = simpleGit(path.resolve(e.REPO_PATH));
  await git.raw(['worktree', 'prune']);
  if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
  await git.raw(['worktree', 'add', '--detach', buildDir, sha]);

  try {
    const sb = await ensureSandbox();
    log(`Building ${sha.slice(0, 8)} with: ${e.REPO_BUILD_COMMAND}`);
    // Site deps: install if the checkout has none (worktrees don't share node_modules)
    if (fs.existsSync(path.join(buildDir, 'package.json')) && !fs.existsSync(path.join(buildDir, 'node_modules'))) {
      log('Installing site dependencies…');
      // --include=dev: NODE_ENV=production would omit devDependencies,
      // where site build tooling (astro, integrations) usually lives
      await run(sb, 'npm install --no-audit --no-fund --include=dev', buildDir, sha, log, 'development');
    }
    await run(sb, e.REPO_BUILD_COMMAND, buildDir, sha, log, 'production');

    const builtDist = path.join(buildDir, 'dist');
    if (!fs.existsSync(builtDist)) throw new Error('Build produced no dist/ directory');

    // Pre-publish validation: no CMS/overlay code in production output,
    // local links resolve (medved §21.2)
    const distIssues = validateDist(builtDist);
    for (const issue of distIssues) log(`[validate:${issue.severity}] ${issue.message}`);
    if (hasErrors(distIssues)) {
      throw new Error('Pre-publish validation failed — see log for details');
    }

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
    fs.cpSync(builtDist, distDir, { recursive: true });

    await tar.create({ gzip: true, file: tarballPath, cwd: builtDist }, ['.']);

    const info: ArtifactInfo = {
      sha,
      tarballPath,
      distDir,
      manifest,
      buildMeta: {
        gitSha: sha,
        node: process.version,
        buildCommand: e.REPO_BUILD_COMMAND,
        builtAt: new Date().toISOString(),
      },
    };
    fs.writeFileSync(metaPath, JSON.stringify(info, null, 2));
    log(`Artifact sealed: ${manifest.length} files, tarball ${path.basename(tarballPath)}`);
    return info;
  } finally {
    await git.raw(['worktree', 'remove', '--force', buildDir]).catch(() => undefined);
  }
}
