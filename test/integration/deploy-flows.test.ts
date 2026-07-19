/**
 * Deploy-flow integration: git-push against a local bare repo, web-agency
 * with a stub PUBLISH_COMMAND — verifies sealed artifacts (tarball, per-file
 * manifest, dist validation) and the script contract (env vars).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';

const ROOT = path.resolve(__dirname, '..', '..');
let base: string;
let repo: string;
let bare: string;
let sha: string;

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-deploy-it-'));
  repo = path.join(base, 'site');
  bare = path.join(base, 'remote.git');
  fs.cpSync(path.join(ROOT, 'examples', 'basic-site'), repo, { recursive: true });

  await simpleGit(base).raw(['init', '--bare', '--initial-branch=main', bare]);
  const git = simpleGit(repo);
  await git.init(['--initial-branch=main'] as never);
  await git.addConfig('user.name', 'T');
  await git.addConfig('user.email', 't@t');
  await git.add(['-A']);
  await git.commit('init');
  await git.addRemote('origin', bare);
  sha = (await git.revparse(['HEAD'])).trim();

  process.env.REPO_PATH = repo;
  process.env.VAR_DIR = path.join(base, 'var');
  process.env.DEPLOY_GIT_REMOTE = 'origin';
  // Default REPO_BUILD_COMMAND (npx astro build): host paths are invisible in
  // the jail — sealArtifact installs the site's deps into the checkout.
  delete process.env.REPO_BUILD_COMMAND;
  resetEnvCache();
}, 60_000);

/** Run a flow's named steps in order (the automatism does this in prod). */
async function runFlowSteps(
  flow: import('@/lib/publish/types').DeployFlow,
  input: { sha: string; repoPath: string; log: (l: string) => void },
) {
  let result: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  for (const step of flow.steps ?? []) {
    const r = await step.run({ ...input, state });
    if (r) result = { ...result, ...r };
  }
  return result as import('@/lib/publish/types').DeployResult;
}

describe('deploy flows', () => {
  it('git-push pushes main to the configured remote', async () => {
    const { registerBuiltinFlows } = await import('@/lib/publish/flows');
    const { getDeployFlow } = await import('@/lib/publish/types');
    registerBuiltinFlows();

    const log: string[] = [];
    await runFlowSteps(getDeployFlow('git-push')!, { sha, repoPath: repo, log: (l) => log.push(l) });

    const remoteSha = (await simpleGit(bare).revparse(['main'])).trim();
    expect(remoteSha).toBe(sha);
    expect(log.join('\n')).toContain('Push complete');
  }, 60_000);

  it('web-agency seals an artifact and runs PUBLISH_COMMAND with the contract env', async () => {
    const recordFile = path.join(base, 'publish-record.txt');
    process.env.PUBLISH_COMMAND = `sh -c 'echo "$TARBALL_PATH|$DIST_DIR|$GIT_SHA" > ${recordFile}'`;
    resetEnvCache();

    const { registerBuiltinFlows } = await import('@/lib/publish/flows');
    const { getDeployFlow } = await import('@/lib/publish/types');
    registerBuiltinFlows();

    const log: string[] = [];
    const result = await runFlowSteps(getDeployFlow('web-agency')!, {
      sha,
      repoPath: repo,
      log: (l) => log.push(l),
    });

    // Script contract
    const [tarball, distDir, recordedSha] = fs.readFileSync(recordFile, 'utf8').trim().split('|');
    expect(recordedSha).toBe(sha);
    expect(fs.existsSync(tarball)).toBe(true);
    expect(fs.existsSync(path.join(distDir, 'index.html'))).toBe(true);

    // Sealed artifact metadata
    const meta = JSON.parse(
      fs.readFileSync(path.join(base, 'var', 'artifacts', `${sha}.json`), 'utf8'),
    );
    expect(meta.manifest.length).toBeGreaterThan(0);
    expect(meta.manifest[0]).toHaveProperty('sha256');
    expect(result.detail).toMatchObject({ files: meta.manifest.length });

    // Retry reuses the sealed artifact instead of rebuilding
    const log2: string[] = [];
    await runFlowSteps(getDeployFlow('web-agency')!, { sha, repoPath: repo, log: (l) => log2.push(l) });
    expect(log2.join('\n')).toContain('Reusing sealed artifact');
  }, 300_000);
});
