/**
 * Deployment-state tools — read-only view over persisted publications and
 * artifacts, plus a live status check via the deploy flow's verify(). These
 * are the ONLY server tools available in 'deployments' system chats.
 */
import path from 'node:path';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { registerTool, type ToolDef } from './registry';
import { ALL_PHASES } from '../types';

const listPublicationsTool: ToolDef = {
  name: 'list_publications',
  description:
    'List recent publications/deployments: status, flow, commit sha, target branch, source chat, external URL, timestamps.',
  schema: z.object({
    limit: z.number().int().positive().max(100).default(20),
    status: z.enum(['running', 'succeeded', 'failed', 'external_unknown']).optional(),
  }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment', 'deployments'],
  async execute(input) {
    const rows = await prisma.publication.findMany({
      where: input.status ? { status: input.status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: input.limit,
      include: {
        branch: { select: { name: true } },
        chat: { select: { id: true, title: true } },
        artifacts: { select: { sha: true, tarballPath: true } },
      },
    });
    return JSON.stringify(
      rows.map((p) => ({
        id: p.id,
        status: p.status,
        flow: p.flow,
        sha: p.sha,
        targetBranch: p.branch.name,
        chat: p.chat.title,
        externalUrl: p.externalUrl,
        sealedArtifact: p.artifacts.length > 0,
        createdAt: p.createdAt,
      })),
      null,
      2,
    );
  },
};

const getPublicationTool: ToolDef = {
  name: 'get_publication',
  description:
    'Full detail of one publication: complete deploy log, artifact manifest summary, approval linkage. Pass the publication id or a commit sha.',
  schema: z.object({ idOrSha: z.string() }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment', 'deployments'],
  async execute(input) {
    const p = await prisma.publication.findFirst({
      where: { OR: [{ id: input.idOrSha }, { sha: input.idOrSha }] },
      orderBy: { createdAt: 'desc' },
      include: {
        branch: { select: { name: true } },
        chat: { select: { id: true, title: true } },
        artifacts: true,
      },
    });
    if (!p) return JSON.stringify({ error: 'Publication not found' });
    return JSON.stringify(
      {
        id: p.id,
        status: p.status,
        flow: p.flow,
        sha: p.sha,
        targetBranch: p.branch.name,
        chat: p.chat.title,
        externalUrl: p.externalUrl,
        createdAt: p.createdAt,
        artifacts: p.artifacts.map((a) => ({
          sha: a.sha,
          tarball: path.basename(a.tarballPath),
          files: Array.isArray(a.manifest) ? a.manifest.length : undefined,
          buildMeta: a.buildMeta,
        })),
        log: p.log.slice(-8000),
      },
      null,
      2,
    );
  },
};

const deploymentStatusTool: ToolDef = {
  name: 'check_deployment_status',
  description:
    "Re-check a publication's live status via the deploy flow's verification (e.g. GitHub CI conclusion, Cloudflare deployment state). Read-only.",
  schema: z.object({ publicationId: z.string() }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment', 'deployments'],
  async execute(input) {
    const p = await prisma.publication.findUnique({
      where: { id: input.publicationId },
      include: { branch: { select: { name: true } } },
    });
    if (!p) return JSON.stringify({ error: 'Publication not found' });
    const { getDeployFlow } = await import('@/lib/publish/types');
    await import('@/lib/publish/publisher'); // ensures flows are registered
    const flow = getDeployFlow(p.flow);
    if (!flow?.verify) {
      return JSON.stringify({
        status: p.status,
        note: `Flow "${p.flow}" has no live verification — persisted status is authoritative.`,
      });
    }
    const lines: string[] = [];
    const ok = await flow.verify(
      {
        sha: p.sha,
        repoPath: path.resolve(env().REPO_PATH),
        // The branch this publication actually targeted — verification of a
        // publish to a non-default target must not look at main.
        targetBranch: p.branch.name,
        log: (l) => lines.push(l),
      },
      { externalUrl: p.externalUrl ?? undefined },
    );
    return JSON.stringify({ persistedStatus: p.status, liveVerification: ok, detail: lines });
  },
};

export function registerDeployTools(): void {
  registerTool(listPublicationsTool);
  registerTool(getPublicationTool);
  registerTool(deploymentStatusTool);
}
