/**
 * Publish orchestration (plan §3 PUBLISH): SHA-bound approval → merge branch
 * into main → run the configured DeployFlow with live log streaming →
 * Publication/Artifact records → reset the branch onto new main and cycle the
 * chat back to PLAN. Failure leaves main merged and the publication
 * retryable with the same sha/artifact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dbNull, prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { broadcast, withBranchLock } from '@/lib/agent/bus';
import { WorkflowError } from '@/lib/agent/workflow';
import { branchSha, mergeToMain, resetBranchOntoMain } from '@/lib/git/engine';
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

export async function publish(req: PublishRequest): Promise<{ publicationId: string }> {
  const e = env();
  const chat = await prisma.chat.findUnique({
    where: { id: req.chatId },
    include: { branch: true },
  });
  if (!chat) throw new WorkflowError('Chat not found', 404);
  if (chat.workflowPhase !== 'preview') {
    throw new WorkflowError(`Cannot publish from the ${chat.workflowPhase} phase.`);
  }

  const head = await branchSha(chat.branch.name);
  if (head !== req.sha) {
    throw new WorkflowError(
      `The branch moved since you reviewed it (${req.sha.slice(0, 8)} → ${head.slice(0, 8)}). Review the preview again.`,
    );
  }

  const flow = getDeployFlow(e.DEPLOY_FLOW);
  if (!flow) throw new WorkflowError(`Unknown deploy flow: ${e.DEPLOY_FLOW}`, 500);

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

  // Merge under the branch lock so no execution lands mid-publish
  const mainSha = await withBranchLock(chat.branchId, () => mergeToMain(chat.branch.name));

  const publication = await prisma.publication.create({
    data: {
      chatId: chat.id,
      branchId: chat.branchId,
      sha: mainSha,
      flow: flow.id,
      status: 'running',
    },
  });

  // Run the flow asynchronously; progress streams over SSE
  void runFlow(publication.id, chat.id, chat.branchId, chat.branch.name, mainSha, flow.id);

  return { publicationId: publication.id };
}

async function runFlow(
  publicationId: string,
  chatId: string,
  branchId: string,
  branchName: string,
  sha: string,
  flowId: string,
): Promise<void> {
  const e = env();
  const flow = getDeployFlow(flowId)!;
  const logLines: string[] = [];
  const log = (line: string) => {
    logLines.push(line);
    broadcast(chatId, 'publish_log', { type: 'publish_log', publicationId, line });
  };

  try {
    const result = await flow.publish({ sha, repoPath: path.resolve(e.REPO_PATH), log });

    let verified = true;
    if (flow.verify) {
      verified = await flow.verify({ sha, repoPath: path.resolve(e.REPO_PATH), log }, result);
    }
    if (!verified) throw new Error('Post-publish verification failed');

    // Record the sealed artifact when the flow produced one
    const artifactMeta = path.join(path.resolve(e.VAR_DIR), 'artifacts', `${sha}.json`);
    if (fs.existsSync(artifactMeta)) {
      const info = JSON.parse(fs.readFileSync(artifactMeta, 'utf8'));
      await prisma.artifact.create({
        data: {
          publicationId,
          sha,
          tarballPath: info.tarballPath,
          manifest: info.manifest,
          buildMeta: info.buildMeta,
        },
      });
    }

    await prisma.publication.update({
      where: { id: publicationId },
      data: { status: 'succeeded', log: logLines.join('\n'), externalUrl: result.externalUrl },
    });

    // Cycle: branch back onto new main, chat back to PLAN
    await withBranchLock(branchId, () => resetBranchOntoMain(branchName));
    await prisma.chat.updateMany({
      where: { id: chatId },
      data: { workflowPhase: 'plan', planJson: dbNull, entityVersion: { increment: 1 } },
    });
    broadcast(chatId, 'publish_done', { type: 'publish_done', publicationId, ok: true, sha });
    broadcast(chatId, 'phase_changed', { type: 'phase_changed', workflowPhase: 'plan' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`FAILED: ${message}`);
    await prisma.publication.update({
      where: { id: publicationId },
      data: { status: 'failed', log: logLines.join('\n') },
    });
    // main is merged; the chat stays in preview-equivalent published state
    // for a retry with the same sha
    await prisma.chat.updateMany({
      where: { id: chatId },
      data: { workflowPhase: 'preview', entityVersion: { increment: 1 } },
    });
    broadcast(chatId, 'publish_done', { type: 'publish_done', publicationId, ok: false, error: message });
    broadcast(chatId, 'phase_changed', { type: 'phase_changed', workflowPhase: 'preview' });
  }
}
