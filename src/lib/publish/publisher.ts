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
  defaultBranch,
  mergeInto,
  resetBranchOnto,
} from '@/lib/git/engine';
import { chatGitIdentity } from '@/lib/git/identity';
import {
  AutomatismFailure,
  postAutomatismMessage,
  registerAutomatism,
  startAutomatism,
  type AutomatismData,
} from '@/lib/automatism';
import { registerBuiltinFlows } from './flows';
import { getDeployFlow } from './types';

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
  /** Set by the merge step; the deploy step publishes exactly this sha. */
  mergedSha?: string;
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
  await startAutomatism('deploy', deployChat.id, data);

  return { publicationId: publication.id, deployChatId: deployChat.id };
}

// ─── The 'deploy' automatism ─────────────────────────────────────────────────

const isConflictError = (err: unknown): boolean => {
  const conflicts = (err as { git?: { conflicts?: unknown[] } })?.git?.conflicts;
  if (Array.isArray(conflicts) && conflicts.length > 0) return true;
  return /conflict/i.test(err instanceof Error ? err.message : String(err));
};

registerAutomatism({
  type: 'deploy',
  steps: [
    {
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
          broadcast(data.workflowChatId, 'publish_log', {
            type: 'publish_log',
            publicationId: data.publicationId,
            line: `Merged into ${data.targetName} (${targetSha.slice(0, 8)}).`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!isConflictError(err)) {
            throw new AutomatismFailure(`Merge into ${data.targetName} failed: ${message}`);
          }
          // Materialize the conflict in the chat's own work branch worktree
          // and hand it to the agent there — resolving + committing the
          // reverse merge makes the retried forward merge clean.
          await abortMerge(data.workBranch);
          const files = await withBranchLock(data.workBranch, () =>
            beginConflictMerge(data.workBranch, data.targetName, identity),
          );
          await prisma.chat.updateMany({
            where: { id: data.workflowChatId },
            data: { workflowPhase: 'execute', entityVersion: { increment: 1 } },
          });
          broadcast(data.workflowChatId, 'phase_changed', {
            type: 'phase_changed',
            workflowPhase: 'execute',
          });
          throw new AutomatismFailure(
            `Merging your work branch into ${data.targetName} hit conflicts` +
              (files.length ? ` in:\n${files.map((f) => `- ${f}`).join('\n')}` : '.') +
              `\nThe conflicted merge is materialized in your worktree (conflict markers ` +
              `in the listed files, merge in progress). Resolve the markers exactly — keep ` +
              `both sides' intent — then commit with git_commit. Only after the commit, ` +
              `call resume_automatism to retry the merge and continue the deployment.`,
            data.workflowChatId,
          );
        }
      },
    },
    {
      name: 'deploy',
      async run(raw, post) {
        const data = raw as DeployData;
        const e = env();
        const flow = data.flowId ? getDeployFlow(data.flowId) : null;
        if (data.flowId && !flow) throw new Error(`Unknown deploy flow: ${data.flowId}`);
        const sha = data.mergedSha!;
        await prisma.publication.update({
          where: { id: data.publicationId },
          data: { status: 'running' },
        });

        const logLines: string[] = [];
        const log = (line: string) => {
          logLines.push(line);
          broadcast(data.workflowChatId, 'publish_log', {
            type: 'publish_log',
            publicationId: data.publicationId,
            line,
          });
        };

        try {
          let result: { externalUrl?: string } = {};
          if (flow) {
            result = await flow.publish({ sha, repoPath: path.resolve(e.REPO_PATH), log });
            if (flow.verify) {
              const verified = await flow.verify(
                { sha, repoPath: path.resolve(e.REPO_PATH), log },
                result,
              );
              if (!verified) throw new Error('Post-publish verification failed');
            }
          } else {
            log(`Merged into ${data.targetName} (non-default target — no deployment).`);
          }

          // Record the sealed artifact when the flow produced one
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
            data: { status: 'succeeded', log: logLines.join('\n'), externalUrl: result.externalUrl },
          });
          await post(
            (flow ? `Deploy via "${flow.id}" succeeded for ${sha.slice(0, 8)}.` : `Merge-only publish done.`) +
              (result.externalUrl ? `\nLive at: ${result.externalUrl}` : '') +
              (logLines.length ? `\n\nLog:\n${logLines.slice(-20).join('\n')}` : ''),
          );
          broadcast(data.workflowChatId, 'publish_done', {
            type: 'publish_done',
            publicationId: data.publicationId,
            ok: true,
            sha,
            externalUrl: result.externalUrl,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`FAILED: ${message}`);
          await prisma.publication.update({
            where: { id: data.publicationId },
            data: { status: 'failed', log: logLines.join('\n') },
          });
          broadcast(data.workflowChatId, 'publish_done', {
            type: 'publish_done',
            publicationId: data.publicationId,
            ok: false,
            error: message,
          });
          throw new AutomatismFailure(
            `Deploy of ${sha.slice(0, 8)} to ${data.targetName} failed: ${message}\n\n` +
              `Publication id: ${data.publicationId}\nLog tail:\n${logLines.slice(-40).join('\n')}`,
          );
        }
      },
    },
    {
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
    },
  ],
});
