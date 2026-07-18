/**
 * Publish orchestration (plan §3 PUBLISH): SHA-bound approval → deployment
 * chat + 'deploy' automatism (merge → deploy → finalize). The automatism runs
 * agent-less and posts its progress into the deployment chat; on a failed
 * step it pauses and invokes the agent with the failure context — merge
 * conflicts in the WORKFLOW chat (which owns the worktree and edit tools),
 * deploy failures in the deployment chat (read-only deploy tools). After the
 * fix, resume_automatism re-runs the failed step. On success both chats are
 * archived (the workflow chat is done — the next change starts a new chat).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { dbNull, prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { broadcast, withBranchLock } from '@/lib/agent/bus';
import { WorkflowError } from '@/lib/agent/workflow';
import {
  abortMerge,
  beginConflictMerge,
  branchSha,
  continueRebase,
  defaultBranch,
  ensureWorktree,
  mergeInto,
  rebaseInProgress,
  rebaseOnto,
  resetBranchOnto,
} from '@/lib/git/engine';
import { chatGitIdentity } from '@/lib/git/identity';
import {
  AutomatismFailure,
  postAutomatismMessage,
  registerAutomatism,
  startAutomatism,
  type AutomatismData,
  type AutomatismStep,
} from '@/lib/automatism';
import { registerBuiltinFlows } from './flows';
import { getDeployFlow, listDeployFlows, type DeployFlow, type DeployFlowStep } from './types';

registerBuiltinFlows();

export interface PublishRequest {
  chatId: string;
  /** Exact branch head the user approved — refused when the branch moved. */
  sha: string;
  actor: { id: string; name: string; email: string };
  expectedVersion?: number;
  idempotencyKey?: string;
}

/** Payload of the 'deploy' automatism (persisted in Automatism.data). */
interface DeployData extends AutomatismData {
  workflowChatId: string;
  deployChatId: string;
  workBranch: string;
  targetName: string;
  targetBranchId: string;
  publicationId: string;
  flowId: string | null;
  /** Set by the merge step; the deploy steps publish exactly this sha. */
  mergedSha?: string;
  /** Deploy log accumulated across steps (publication log source). */
  logLines?: string[];
  /** Accumulated DeployResult (externalUrl etc.) across flow steps. */
  result?: { externalUrl?: string; detail?: Record<string, unknown> };
  /** Flow-step scratch, persisted across pauses/resumes. */
  flowState?: Record<string, unknown>;
}

export async function publish(
  req: PublishRequest,
): Promise<{ publicationId: string; deployChatId: string }> {
  const e = env();
  const chat = await prisma.chat.findUnique({
    where: { id: req.chatId },
    include: { branch: true },
  });
  if (!chat) throw new WorkflowError('Chat not found', 404);
  if (chat.workflowPhase !== 'preview') {
    throw new WorkflowError(`Cannot publish from the ${chat.workflowPhase} phase.`);
  }

  // The approval binds the chat's WORK branch head — the exact state reviewed
  const head = await branchSha(chat.workBranch);
  if (head !== req.sha) {
    throw new WorkflowError(
      `The chat's work branch moved since you reviewed it (${req.sha.slice(0, 8)} → ${head.slice(0, 8)}). Review the preview again.`,
    );
  }

  // Deploy flows run only when the target is the site's default branch;
  // merging into another target branch is a pure merge.
  const isDefaultTarget = chat.branch.name === (await defaultBranch());
  const flow = isDefaultTarget ? getDeployFlow(e.DEPLOY_FLOW) : null;
  if (isDefaultTarget && !flow) {
    throw new WorkflowError(`Unknown deploy flow: ${e.DEPLOY_FLOW}`, 500);
  }

  // Approval bound to the exact sha; unique idempotency key dedupes retries
  await prisma.approval.create({
    data: {
      chatId: chat.id,
      actorId: req.actor.id,
      action: 'publish',
      baseSha: head,
      targetSha: req.sha,
      idempotencyKey: req.idempotencyKey ?? randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const versionGate = await prisma.chat.updateMany({
    where: { id: chat.id, entityVersion: req.expectedVersion ?? chat.entityVersion },
    data: { workflowPhase: 'published', entityVersion: { increment: 1 } },
  });
  if (versionGate.count === 0) {
    throw new WorkflowError('The chat changed while you were deciding — reload and retry.');
  }
  broadcast(chat.id, 'phase_changed', { type: 'phase_changed', workflowPhase: 'published' });

  // The deployment chat hosts the automatism: its events, and the agent when
  // a deploy step fails. Archived together with the workflow chat when done.
  const shortSha = req.sha.slice(0, 8);
  const deployChat = await prisma.chat.create({
    data: {
      branchId: chat.branchId,
      workBranch: `c-${randomBytes(6).toString('hex')}`,
      kind: 'deployment',
      title: flow
        ? `Deploy ${chat.branch.name} @ ${shortSha}`
        : `Merge into ${chat.branch.name} @ ${shortSha}`,
      workflowPhase: 'published',
      createdById: req.actor.id,
    },
  });

  // Publication exists before the merge so the client can track it; the merge
  // step rebinds sha to the actual merge commit.
  const publication = await prisma.publication.create({
    data: {
      chatId: chat.id,
      branchId: chat.branchId,
      sha: req.sha,
      flow: flow?.id ?? 'merge-only',
      status: 'running',
    },
  });

  const data: DeployData = {
    actorId: req.actor.id,
    workflowChatId: chat.id,
    deployChatId: deployChat.id,
    workBranch: chat.workBranch,
    targetName: chat.branch.name,
    targetBranchId: chat.branchId,
    publicationId: publication.id,
    flowId: flow?.id ?? null,
  };

  await postAutomatismMessage(
    deployChat.id,
    `Deployment of "${chat.title}" started by ${req.actor.name}: ` +
      `merge ${chat.workBranch} (${shortSha}) into ${chat.branch.name}, then ` +
      (flow ? `deploy via "${flow.id}".` : 'no deploy (non-default target).'),
  );
  await startAutomatism(deployAutomatismType(flow ?? null), deployChat.id, data);

  return { publicationId: publication.id, deployChatId: deployChat.id };
}

// ─── The 'pull' automatism (Sync button) ─────────────────────────────────────
// Rebases a workflow chat's work branch onto the latest TARGET branch state.
// Registered here alongside 'deploy' so every `import '@/lib/publish/publisher'`
// (resume tool, history, boot recovery) sees all automatism types.

/** Payload of the 'pull' automatism. */
interface PullData extends AutomatismData {
  workflowChatId: string;
  workBranch: string;
  targetName: string;
  /** Workflow phase to restore after a conflict forced EXECUTE. */
  restorePhase?: string;
}

/** Start a target→work sync for a workflow chat. Throws on invalid state. */
export async function startPull(chatId: string, actor: { id: string; name: string }): Promise<string> {
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, include: { branch: true } });
  if (!chat) throw new WorkflowError('Chat not found', 404);
  if (chat.kind !== 'workflow') throw new WorkflowError('Only workflow chats can sync.');
  if (chat.archivedAt) throw new WorkflowError('This chat is archived.');
  const active = await prisma.automatism.findFirst({
    where: { chatId, status: { in: ['running', 'paused'] } },
  });
  if (active) throw new WorkflowError(`A ${active.type} automatism is already ${active.status}.`, 409);

  await postAutomatismMessage(
    chatId,
    `Sync started by ${actor.name}: rebasing this draft onto the latest ${chat.branch.name}.`,
  );
  return startAutomatism('pull', chatId, {
    actorId: actor.id,
    workflowChatId: chatId,
    workBranch: chat.workBranch,
    targetName: chat.branch.name,
  } satisfies PullData);
}

registerAutomatism({
  type: 'pull',
  steps: [
    {
      name: 'pull',
      async run(raw, post) {
        const data = raw as PullData;
        const identity = await chatGitIdentity(data.workflowChatId, data.actorId);

        // Force the chat into EXECUTE while conflicts need resolving; the
        // finalize step restores the previous phase.
        const pauseWithConflicts = async (files: string[]): Promise<never> => {
          const chat = await prisma.chat.findUnique({
            where: { id: data.workflowChatId },
            select: { workflowPhase: true },
          });
          if (chat && chat.workflowPhase !== 'execute') {
            data.restorePhase ??= chat.workflowPhase;
            await prisma.chat.updateMany({
              where: { id: data.workflowChatId },
              data: { workflowPhase: 'execute', entityVersion: { increment: 1 } },
            });
            broadcast(data.workflowChatId, 'phase_changed', {
              type: 'phase_changed',
              workflowPhase: 'execute',
            });
          }
          throw new AutomatismFailure(
            `Rebasing the draft onto ${data.targetName} hit conflicts` +
              (files.length ? ` in:\n${files.map((f) => `- ${f}`).join('\n')}` : '.') +
              `\nThe rebase is paused in this chat's worktree (markers in place). Use ` +
              `list_conflicts / show_conflict, target_file for the incoming side, resolve ` +
              `each file (edit_file or resolve_conflict_take) keeping both sides' intent, ` +
              `then git_rebase_continue — repeat per replayed commit until the rebase ` +
              `completes — and finally call resume_automatism to finish the sync.`,
          );
        };

        try {
          // Retry-safe: after a conflict pause the rebase may still be in
          // progress (agent resolved but didn't continue) or already be done.
          const dir = await ensureWorktree(data.workBranch);
          const result = (await rebaseInProgress(dir))
            ? await withBranchLock(data.workBranch, () => continueRebase(data.workBranch, identity))
            : await withBranchLock(data.workBranch, () =>
                rebaseOnto(data.workBranch, data.targetName, identity),
              );
          if (result.conflicts?.length) await pauseWithConflicts(result.conflicts);
          await post(
            `Rebased the draft onto the latest ${data.targetName} → ${result.sha!.slice(0, 8)}. ` +
              `Note: the draft history was rewritten — review the preview again before publishing.`,
          );
        } catch (err) {
          if (err instanceof AutomatismFailure) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new AutomatismFailure(`Rebasing onto ${data.targetName} failed: ${message}`);
        }
      },
    },
    {
      name: 'finalize',
      async run(raw, post) {
        const data = raw as PullData;
        if (data.restorePhase) {
          await prisma.chat.updateMany({
            where: { id: data.workflowChatId },
            data: { workflowPhase: data.restorePhase, entityVersion: { increment: 1 } },
          });
          broadcast(data.workflowChatId, 'phase_changed', {
            type: 'phase_changed',
            workflowPhase: data.restorePhase,
          });
          data.restorePhase = undefined;
        }
        await post(`Sync done — the draft is up to date with ${data.targetName}.`);
      },
    },
  ],
});

// ─── The 'deploy' automatism ─────────────────────────────────────────────────
// Registered once generically ('deploy': merge → deploy → finalize) and once
// per flow that declares custom steps ('deploy:<id>': merge → <flow steps> →
// verify → finalize), so each flow phase shows in the step bar and pauses /
// resumes individually.

const isConflictError = (err: unknown): boolean => {
  const conflicts = (err as { git?: { conflicts?: unknown[] } })?.git?.conflicts;
  if (Array.isArray(conflicts) && conflicts.length > 0) return true;
  return /conflict/i.test(err instanceof Error ? err.message : String(err));
};

// Log lines persist in the automatism data so the publication log spans steps
const deployLog = (data: DeployData) => (line: string) => {
  (data.logLines ??= []).push(line);
  broadcast(data.workflowChatId, 'publish_log', {
    type: 'publish_log',
    publicationId: data.publicationId,
    line,
  });
};

async function failDeploy(data: DeployData, err: unknown): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  deployLog(data)(`FAILED: ${message}`);
  await prisma.publication.update({
    where: { id: data.publicationId },
    data: { status: 'failed', log: (data.logLines ?? []).join('\n') },
  });
  broadcast(data.workflowChatId, 'publish_done', {
    type: 'publish_done',
    publicationId: data.publicationId,
    ok: false,
    error: message,
  });
  throw new AutomatismFailure(
    `Deploy of ${(data.mergedSha ?? '').slice(0, 8)} to ${data.targetName} failed: ${message}\n\n` +
      `Publication id: ${data.publicationId}\nLog tail:\n${(data.logLines ?? []).slice(-40).join('\n')}`,
  );
}

/** Deploy tail: artifact record, publication success, notifications. */
async function recordDeploySuccess(
  data: DeployData,
  post: (text: string) => Promise<void>,
  label: string,
): Promise<void> {
  const e = env();
  const sha = data.mergedSha!;
  const artifactMeta = path.join(path.resolve(e.VAR_DIR), 'artifacts', `${sha}.json`);
  if (fs.existsSync(artifactMeta)) {
    const info = JSON.parse(fs.readFileSync(artifactMeta, 'utf8'));
    await prisma.artifact.create({
      data: {
        publicationId: data.publicationId,
        sha,
        tarballPath: info.tarballPath,
        manifest: info.manifest,
        buildMeta: info.buildMeta,
      },
    });
  }
  await prisma.publication.update({
    where: { id: data.publicationId },
    data: {
      status: 'succeeded',
      log: (data.logLines ?? []).join('\n'),
      externalUrl: data.result?.externalUrl,
    },
  });
  await post(
    label +
      (data.result?.externalUrl ? `\nLive at: ${data.result.externalUrl}` : '') +
      ((data.logLines ?? []).length ? `\n\nLog:\n${(data.logLines ?? []).slice(-20).join('\n')}` : ''),
  );
  broadcast(data.workflowChatId, 'publish_done', {
    type: 'publish_done',
    publicationId: data.publicationId,
    ok: true,
    sha,
    externalUrl: data.result?.externalUrl,
  });
}

const mergeStep: AutomatismStep = {
  name: 'merge',
  async run(raw, post) {
    const data = raw as DeployData;
    const identity = await chatGitIdentity(data.workflowChatId, data.actorId);
    await prisma.publication.update({
      where: { id: data.publicationId },
      data: { status: 'running' },
    });
    try {
      const targetSha = await withBranchLock(data.targetBranchId, () =>
        mergeInto(data.workBranch, data.targetName, identity),
      );
      data.mergedSha = targetSha;
      await prisma.publication.update({
        where: { id: data.publicationId },
        data: { sha: targetSha },
      });
      await post(`Merged ${data.workBranch} into ${data.targetName} → ${targetSha.slice(0, 8)}.`);
      deployLog(data)(`Merged into ${data.targetName} (${targetSha.slice(0, 8)}).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isConflictError(err)) {
        throw new AutomatismFailure(`Merge into ${data.targetName} failed: ${message}`);
      }
      // Materialize the conflict in the source chat's work branch worktree —
      // this deployment chat's tools operate on exactly that worktree, so the
      // agent resolves it here. Committing the reverse merge makes the
      // retried forward merge clean.
      await abortMerge(data.workBranch);
      const files = await withBranchLock(data.workBranch, () =>
        beginConflictMerge(data.workBranch, data.targetName, identity),
      );
      throw new AutomatismFailure(
        `Merging ${data.workBranch} into ${data.targetName} hit conflicts` +
          (files.length ? ` in:\n${files.map((f) => `- ${f}`).join('\n')}` : '.') +
          `\nThe conflicted merge is materialized in this chat's worktree (markers in ` +
          `place, merge in progress). Use list_conflicts / show_conflict to inspect, ` +
          `target_file for the incoming side, then resolve each file — edit_file for ` +
          `mixed resolutions, resolve_conflict_take for whole-side ones — keeping both ` +
          `sides' intent. Commit the merge with git_commit, and only then call ` +
          `resume_automatism to retry the merge and continue the deployment.`,
      );
    }
  },
};

/** Generic one-step deploy: flows without custom steps, and merge-only. */
const genericDeployStep: AutomatismStep = {
  name: 'deploy',
  async run(raw, post) {
    const data = raw as DeployData;
    const e = env();
    const flow = data.flowId ? getDeployFlow(data.flowId) : null;
    if (data.flowId && !flow) throw new Error(`Unknown deploy flow: ${data.flowId}`);
    await prisma.publication.update({
      where: { id: data.publicationId },
      data: { status: 'running' },
    });
    const log = deployLog(data);
    try {
      if (flow) {
        if (!flow.publish) throw new Error(`Flow "${flow.id}" has no publish() and no steps`);
        const sha = data.mergedSha!;
        const result = await flow.publish({ sha, repoPath: path.resolve(e.REPO_PATH), log });
        data.result = { ...(data.result ?? {}), ...result };
        if (flow.verify) {
          const verified = await flow.verify(
            { sha, repoPath: path.resolve(e.REPO_PATH), log },
            data.result,
          );
          if (!verified) throw new Error('Post-publish verification failed');
        }
        await recordDeploySuccess(data, post, `Deploy via "${flow.id}" succeeded for ${sha.slice(0, 8)}.`);
      } else {
        log(`Merged into ${data.targetName} (non-default target — no deployment).`);
        await recordDeploySuccess(data, post, 'Merge-only publish done.');
      }
    } catch (err) {
      if (err instanceof AutomatismFailure) throw err;
      await failDeploy(data, err);
    }
  },
};

/** One automatism step per flow-declared deploy phase (push/build/deploy…). */
function flowStep(flow: DeployFlow, step: DeployFlowStep): AutomatismStep {
  return {
    name: step.name,
    async run(raw, post) {
      const data = raw as DeployData;
      await prisma.publication.update({
        where: { id: data.publicationId },
        data: { status: 'running' },
      });
      try {
        const result = await step.run({
          sha: data.mergedSha!,
          repoPath: path.resolve(env().REPO_PATH),
          log: deployLog(data),
          state: (data.flowState ??= {}),
        });
        if (result) data.result = { ...(data.result ?? {}), ...result };
        await post(`${flow.id}: ${step.name} done.`);
      } catch (err) {
        if (err instanceof AutomatismFailure) throw err;
        await failDeploy(data, err);
      }
    },
  };
}

/** Trailing step of flow-step deployments: optional verify + success record. */
function verifyStep(flow: DeployFlow): AutomatismStep {
  return {
    name: 'verify',
    async run(raw, post) {
      const data = raw as DeployData;
      try {
        if (flow.verify) {
          const ok = await flow.verify(
            {
              sha: data.mergedSha!,
              repoPath: path.resolve(env().REPO_PATH),
              log: deployLog(data),
            },
            data.result ?? {},
          );
          if (!ok) throw new Error('Post-publish verification failed');
        }
        await recordDeploySuccess(
          data,
          post,
          `Deploy via "${flow.id}" succeeded for ${data.mergedSha!.slice(0, 8)}.`,
        );
      } catch (err) {
        if (err instanceof AutomatismFailure) throw err;
        await failDeploy(data, err);
      }
    },
  };
}

const finalizeStep: AutomatismStep = {
  name: 'finalize',
  async run(raw, post) {
    const data = raw as DeployData;
    // Cycle the work branch onto the updated target so its preview keeps
    // working from the archive; the chat itself is done and archives.
    await withBranchLock(data.workBranch, () =>
      resetBranchOnto(data.workBranch, data.targetName),
    );
    const now = new Date();
    await prisma.chat.updateMany({
      where: { id: data.workflowChatId },
      data: {
        workflowPhase: 'published',
        planJson: dbNull,
        archivedAt: now,
        entityVersion: { increment: 1 },
      },
    });
    await prisma.chat.updateMany({
      where: { id: data.deployChatId },
      data: { archivedAt: now },
    });
    await post('Deployment finished — this chat and the source chat are archived.');
    broadcast(data.workflowChatId, 'phase_changed', {
      type: 'phase_changed',
      workflowPhase: 'published',
    });
    broadcast(data.workflowChatId, 'chat_archived', {
      type: 'chat_archived',
      chatId: data.workflowChatId,
    });
    broadcast(data.deployChatId, 'chat_archived', {
      type: 'chat_archived',
      chatId: data.deployChatId,
    });
  },
};

registerAutomatism({ type: 'deploy', steps: [mergeStep, genericDeployStep, finalizeStep] });
for (const flow of listDeployFlows()) {
  if (flow.steps?.length) {
    registerAutomatism({
      type: `deploy:${flow.id}`,
      steps: [mergeStep, ...flow.steps.map((s) => flowStep(flow, s)), verifyStep(flow), finalizeStep],
    });
  }
}

/** Automatism type for a publish: per-flow when the flow declares steps. */
export function deployAutomatismType(flow: DeployFlow | null): string {
  return flow?.steps?.length ? `deploy:${flow.id}` : 'deploy';
}
