/**
 * Built-in deploy flows (plan §7 + §12):
 *  - git-push:        push main to a remote; downstream infra deploys.
 *  - web-agency:      sealed artifact + PUBLISH_COMMAND (script + tarball).
 *  - github-ci:       push main, then poll the commit's check runs by sha.
 *  - cloudflare-pages: wrangler direct upload with commit metadata,
 *                      verify/reconcile by commit_hash via the REST API.
 */
import { spawn } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { env } from '@/lib/env';
import { sealArtifact } from './artifact';
import { registerDeployFlow, type DeployFlow } from './types';

function runScript(
  command: string,
  cwd: string,
  extraEnv: Record<string, string>,
  log: (l: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // PUBLISH_COMMAND is a user-provided script line — run through the shell
    // deliberately (documented); it receives context via env, not argv.
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...extraEnv, FORCE_COLOR: '0' },
    });
    child.stdout.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(log));
    child.stderr.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(log));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`publish command exited with code ${code}`)),
    );
  });
}

async function pushMain(repoPath: string, remote: string, log: (l: string) => void): Promise<void> {
  log(`Pushing main to ${remote}…`);
  await simpleGit(repoPath).push(remote, 'main');
  log('Push complete.');
}

const gitPushFlow: DeployFlow = {
  id: 'git-push',
  async publish({ repoPath, log }) {
    const remote = env().DEPLOY_GIT_REMOTE ?? 'origin';
    await pushMain(repoPath, remote, log);
    return { detail: { remote } };
  },
};

const webAgencyFlow: DeployFlow = {
  id: 'web-agency',
  async publish({ sha, log }) {
    const e = env();
    if (!e.PUBLISH_COMMAND) throw new Error('PUBLISH_COMMAND is not configured');
    const artifact = await sealArtifact(sha, log);
    log(`Running publish command: ${e.PUBLISH_COMMAND}`);
    await runScript(
      e.PUBLISH_COMMAND,
      e.REPO_PATH,
      { TARBALL_PATH: artifact.tarballPath, DIST_DIR: artifact.distDir, GIT_SHA: sha },
      log,
    );
    return { detail: { tarball: artifact.tarballPath, files: artifact.manifest.length } };
  },
};

const githubCiFlow: DeployFlow = {
  id: 'github-ci',
  async publish({ repoPath, log }) {
    const remote = env().DEPLOY_GIT_REMOTE ?? 'origin';
    await pushMain(repoPath, remote, log);
    return {};
  },
  async verify({ sha, log }) {
    const e = env();
    if (!e.GITHUB_TOKEN || !e.GITHUB_REPO) {
      throw new Error('GITHUB_TOKEN and GITHUB_REPO are required for the github-ci flow');
    }
    const { Octokit } = await import('octokit');
    const octokit = new Octokit({ auth: e.GITHUB_TOKEN });
    const [owner, repo] = e.GITHUB_REPO.split('/');

    const deadline = Date.now() + 20 * 60 * 1000;
    log(`Waiting for CI on ${sha.slice(0, 8)}…`);
    while (Date.now() < deadline) {
      const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref: sha });
      const runs = data.check_runs;
      if (runs.length > 0 && runs.every((r) => r.status === 'completed')) {
        const failed = runs.filter((r) => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion));
        for (const r of runs) log(`Check ${r.name}: ${r.conclusion} (${r.html_url})`);
        return failed.length === 0;
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    log('Timed out waiting for CI checks.');
    return false;
  },
};

const cloudflarePagesFlow: DeployFlow = {
  id: 'cloudflare-pages',
  async publish({ sha, log }) {
    const e = env();
    if (!e.CLOUDFLARE_API_TOKEN || !e.CLOUDFLARE_ACCOUNT_ID || !e.CLOUDFLARE_PAGES_PROJECT) {
      throw new Error('CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_PAGES_PROJECT are required');
    }
    const artifact = await sealArtifact(sha, log);

    // Reconcile first: a lost response from a previous attempt must not
    // cause a blind second upload (medved §22.4).
    const existing = await findDeploymentByCommit(sha);
    if (existing) {
      log(`Found existing deployment for ${sha.slice(0, 8)}: ${existing.url}`);
      return { externalUrl: existing.url, detail: { reconciled: true, id: existing.id } };
    }

    log('Uploading dist/ via wrangler pages deploy…');
    await new Promise<void>((resolve, reject) => {
      // wrangler is CLI-only for direct upload — documented adapter choice
      const child = spawn(
        'npx',
        [
          'wrangler', 'pages', 'deploy', artifact.distDir,
          '--project-name', e.CLOUDFLARE_PAGES_PROJECT!,
          '--branch', 'main',
          '--commit-hash', sha,
          '--commit-dirty=false',
        ],
        {
          cwd: e.REPO_PATH,
          env: {
            ...process.env,
            CLOUDFLARE_API_TOKEN: e.CLOUDFLARE_API_TOKEN,
            CLOUDFLARE_ACCOUNT_ID: e.CLOUDFLARE_ACCOUNT_ID,
            FORCE_COLOR: '0',
          },
        },
      );
      child.stdout.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(log));
      child.stderr.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(log));
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`wrangler exited with code ${code}`)),
      );
    });

    const deployment = await findDeploymentByCommit(sha);
    return { externalUrl: deployment?.url, detail: { id: deployment?.id } };
  },
  async verify({ sha, log }) {
    const deployment = await findDeploymentByCommit(sha);
    if (!deployment) {
      log('No deployment found for the published commit.');
      return false;
    }
    log(`Deployment ${deployment.id} status: ${deployment.status}`);
    return deployment.status === 'success';
  },
};

async function findDeploymentByCommit(
  sha: string,
): Promise<{ id: string; url: string; status: string } | null> {
  const e = env();
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${e.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${e.CLOUDFLARE_PAGES_PROJECT}/deployments`,
    { headers: { Authorization: `Bearer ${e.CLOUDFLARE_API_TOKEN}` } },
  );
  if (!res.ok) throw new Error(`Cloudflare API error: ${res.status}`);
  const data = (await res.json()) as {
    result?: Array<{
      id: string;
      url: string;
      deployment_trigger?: { metadata?: { commit_hash?: string } };
      latest_stage?: { status?: string };
    }>;
  };
  const match = data.result?.find((d) => d.deployment_trigger?.metadata?.commit_hash === sha);
  return match
    ? { id: match.id, url: match.url, status: match.latest_stage?.status ?? 'unknown' }
    : null;
}

export function registerBuiltinFlows(): void {
  registerDeployFlow(gitPushFlow);
  registerDeployFlow(webAgencyFlow);
  registerDeployFlow(githubCiFlow);
  registerDeployFlow(cloudflarePagesFlow);
}
