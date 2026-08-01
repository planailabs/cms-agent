/**
 * Publish orchestration (plan §3 PUBLISH): SHA-bound approval → deployment
 * chat + 'deploy' automatism (validate → merge → deploy → finalize). The
 * 'validate' step is the site-type build gate (`astro build` for Astro): it
 * builds the tree the merge would produce, for every flow, before anything
 * moves. The automatism runs
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
import { canSeeOthersChats } from '@/lib/chatAccess';
import { awaitTurnIdle, broadcast, hasActiveTurn, withBranchLock } from '@/lib/agent/bus';
import { emitChatState, emitChatStatesForBranch } from '@/lib/agent/chatState';
import { WorkflowError } from '@/lib/agent/workflow';
import {
  abortMerge,
  beginConflictMerge,
  branchCommits,
  branchSha,
  continueRebase,
  defaultBranch,
  ensureWorktree,
  mergeInto,
  mergePreviewCommit,
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
  type AutomatismMessage,
  type AutomatismStep,
} from '@/lib/automatism';
import { tmsg, type TranslatedMessage } from '@/lib/i18n';
import { chatPreviewRoutes, checkSiteHealth, describeIssues, hasErrors } from '@/lib/site/health';
import { prevalidateBuild } from './artifact';
import { registerBuiltinFlows } from './flows';
import { getDeployFlow, listDeployFlows, type DeployFlow, type DeployFlowStep } from './types';

registerBuiltinFlows();

/**
 * How long publish/sync let a running turn finish before refusing it. Long
 * enough for the wrap-up turn finalize resumes, short enough that a chat the
 * agent is really working in answers rather than hangs.
 */
const TURN_SETTLE_MS = 20_000;

/** Restricted visibility: a foreign chat is indistinguishable from absent. */
async function assertChatVisibleTo(
  viewer: { id: string; role?: string },
  chat: { createdById: string | null },
): Promise<void> {
  if (
    chat.createdById &&
    chat.createdById !== viewer.id &&
    !(await canSeeOthersChats({ id: viewer.id, role: viewer.role ?? '' }))
  ) {
    throw new WorkflowError('Chat not found', 404);
  }
}

export interface PublishRequest {
  chatId: string;
  /** Exact branch head the user approved — refused when the branch moved. */
  sha: string;
  actor: { id: string; name: string; email: string; role?: string };
  expectedVersion?: number;
  idempotencyKey?: string;
  /** How long to let a running turn finish first (tests shorten it). */
  settleMs?: number;
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
  /** Work-branch head the publish approval bound (re-checked at merge time). */
  approvedSha: string;
  /** Set once a conflict round began — the reverse-merge commit legitimately
   *  moves the work-branch head past approvedSha. */
  conflictStarted?: boolean;
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
  await assertChatVisibleTo(req.actor, chat);
  if (chat.workflowPhase !== 'execute') {
    throw new WorkflowError(`Cannot publish from the ${chat.workflowPhase} phase.`);
  }

  // Publishing merges the work branch; a turn still writing to it would put
  // uncommitted or half-finished work behind the reviewed sha. The usual
  // "turn" here is the wrap-up finalize just resumed, seconds from ending —
  // wait for it before refusing, or Publish fails for pressing it too soon.
  await awaitTurnIdle(req.chatId, req.settleMs ?? TURN_SETTLE_MS);
  if (hasActiveTurn(req.chatId)) {
    throw new WorkflowError('The agent is working in this chat — publish when the turn finishes.', 409);
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

  // Approval bound to the exact sha. The unique idempotency key makes a
  // retried request fail at the database instead of recording a second
  // approval — it does NOT replay the first attempt's outcome: the caller sees
  // an error, not the original publicationId, and nothing here reconstructs
  // it. Retry-safety is the automatism's, per step.
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
  emitChatState(chat.id);

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
    approvedSha: req.sha,
  };

  await postAutomatismMessage(
    deployChat.id,
    tmsg(flow ? 'deploy.startedFlow' : 'deploy.startedMergeOnly', {
      title: chat.title,
      actor: req.actor.name,
      workBranch: chat.workBranch,
      sha: shortSha,
      target: chat.branch.name,
      ...(flow ? { flow: flow.id } : {}),
    }),
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

/**
 * Move the chat's execution rows onto the commits a rebase rewrote them into.
 *
 * Sync rebases the work branch onto the target, which gives every commit a new
 * sha. The execution rows keep the old ones, so they point at commits the
 * branch no longer contains — including the row publish binds, which is why a
 * sync used to leave a chat stuck on "the work branch moved since you reviewed
 * it" with nothing able to advance it: only git_commit writes that table, and
 * a chat with no further changes to make never calls it again.
 *
 * Commits are matched by subject in rebase order — a rebase preserves the
 * message, and the exclusive commits of a work branch are the chat's own. Any
 * row that finds no match keeps its old sha rather than being pointed at the
 * wrong commit; the head check below is what still guarantees the branch can
 * be published after the human reviews it again.
 */
export async function reanchorExecutions(
  chatId: string,
  workBranch: string,
  targetName: string,
  head: string,
): Promise<void> {
  const rows = await prisma.execution.findMany({
    where: { chatId },
    orderBy: { createdAt: 'asc' },
  });
  // Oldest first — the order the rebase replayed them in.
  const rewritten = (await branchCommits(workBranch, targetName, 200))
    .filter((c) => !c.onTarget)
    .reverse();
  if (rows.length === 0 || rewritten.length === 0) return;

  // A commit already claimed by an unchanged row is not a candidate for another.
  const claimed = new Set(rows.map((r) => r.sha).filter((sha) => rewritten.some((c) => c.sha === sha)));
  for (const row of rows) {
    if (claimed.has(row.sha)) continue;
    const subject = row.summary.split('\n')[0];
    const match = rewritten.find((c) => c.message === subject && !claimed.has(c.sha));
    if (!match) continue;
    claimed.add(match.sha);
    await prisma.execution.update({ where: { id: row.id }, data: { sha: match.sha } });
  }

  // Whatever the matching achieved, the branch head must be publishable: it is
  // the state the human is being asked to review.
  const newest = await prisma.execution.findFirst({
    where: { chatId, revertedBySha: null },
    orderBy: { createdAt: 'desc' },
  });
  if (newest?.sha !== head) {
    await prisma.execution.create({
      data: { chatId, sha: head, summary: `Synced with ${targetName}` },
    });
  }
  emitChatState(chatId);
}

/** In-flight startPull chatIds — the DB guard below is check-then-create,
 *  so a double-click could otherwise start two pulls. */
// Survives a Vite module reload: a second copy of this module would bring a
// second empty set, and the double click this guards against is exactly what
// a dev-time reload makes easy (see lib/preview/manager for the same reason).
const g = globalThis as unknown as { __pullStarting?: Set<string> };
const pullStarting: Set<string> = (g.__pullStarting ??= new Set<string>());

/** Start a target→work sync for a workflow chat. Throws on invalid state. */
export async function startPull(
  chatId: string,
  actor: { id: string; name: string; role?: string },
  settleMs = TURN_SETTLE_MS,
): Promise<string> {
  if (pullStarting.has(chatId)) throw new WorkflowError('A sync is already starting.', 409);
  pullStarting.add(chatId);
  try {
    return await startPullInner(chatId, actor, settleMs);
  } finally {
    pullStarting.delete(chatId);
  }
}

async function startPullInner(
  chatId: string,
  actor: { id: string; name: string; role?: string },
  settleMs: number,
): Promise<string> {
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, include: { branch: true } });
  if (!chat) throw new WorkflowError('Chat not found', 404);
  await assertChatVisibleTo(actor, chat);
  if (chat.kind !== 'workflow') throw new WorkflowError('Only workflow chats can sync.');
  if (chat.archivedAt) throw new WorkflowError('This chat is archived.');
  const active = await prisma.automatism.findFirst({
    where: { chatId, status: { in: ['running', 'paused'] } },
  });
  if (active) throw new WorkflowError(`A ${active.type} automatism is already ${active.status}.`, 409);
  // The deploy automatism lives on the DEPLOYMENT chat, so the check above
  // misses it — a rebase during a pending merge would rewrite the reviewed
  // branch state. The publication row lives on THIS chat: gate on it.
  const activePub = await prisma.publication.findFirst({ where: { chatId, status: 'running' } });
  if (activePub) {
    throw new WorkflowError('A publication for this chat is in progress — sync after it finishes.', 409);
  }
  // A sync rebases the work branch: doing that while the agent is mid-turn
  // rewrites the worktree it is editing, and its next write lands on commits
  // that no longer exist. startAutomatism refuses this too; here it becomes a
  // 409 the UI can show instead of a stack trace.
  await awaitTurnIdle(chatId, settleMs);
  if (hasActiveTurn(chatId)) {
    throw new WorkflowError('The agent is working in this chat — sync when the turn finishes.', 409);
  }

  await postAutomatismMessage(
    chatId,
    tmsg('pull.started', { actor: actor.name, target: chat.branch.name }),
  );
  return startAutomatism('pull', chatId, {
    actorId: actor.id,
    workflowChatId: chatId,
    workBranch: chat.workBranch,
    targetName: chat.branch.name,
  } satisfies PullData);
}

/**
 * Checkpoint step: is the site still renderable after what just landed?
 *
 * A rebase onto the target can break the draft in ways git reports nothing
 * about — a component the incoming commits renamed, a config both sides
 * touched — and the person who hits Sync usually looks away afterwards. So
 * the flow looks for them, and a broken site pauses it exactly like a merge
 * conflict does: the agent is invoked with the error, fixes it, and
 * resume_automatism re-runs this check.
 */
const siteCheckStep: AutomatismStep = {
  name: 'check',
  // Getting a page rendering again: the site's own diagnostics, the file
  // tools to fix what they point at, and a commit to seal it.
  repairTools: [
    'site_status',
    'preview_logs',
    'restart_preview',
    'read_file',
    'write_file',
    'edit_file',
    'remove_file',
    'move_file',
    'run_command',
    'lint',
    'git_commit',
    'git_show',
  ],
  async run(raw, post) {
    const data = raw as PullData;
    const worktree = await ensureWorktree(data.workBranch);
    const routes = await chatPreviewRoutes(data.workflowChatId);
    await post(tmsg('site.checking', { routes: routes.join(', ') }));

    const issues = await checkSiteHealth({ branch: data.workBranch, worktree, routes });
    if (!hasErrors(issues)) {
      await post(tmsg('site.ok'));
      return;
    }
    // A check that could not reach the preview has found nothing about the
    // site. Pausing the sync on it would hand the agent a repair job for a
    // page that renders — say what happened and let the flow finish; the user
    // is looking at the preview either way.
    const real = issues.filter((i) => i.severity === 'error' && i.failureClass !== 'RETRYABLE_INFRA');
    if (real.length === 0) {
      await post(tmsg('site.uncheckable', { error: describeIssues(issues) }));
      return;
    }
    throw new AutomatismFailure(tmsg('site.broken', { error: describeIssues(real) }));
  },
};

registerAutomatism({
  type: 'pull',
  steps: [
    {
      name: 'pull',
      // Resolving a rebase conflict: the conflict tools, the files, and the
      // git commands that finish a rebase. Not the phase's tool set — this
      // chat may be mid-PLAN, and the repair still needs to write.
      repairTools: [
        'list_conflicts',
        'show_conflict',
        'resolve_conflict_take',
        'target_file',
        'read_file',
        'write_file',
        'edit_file',
        'git_rebase_continue',
        'git_rebase_abort',
        'git_commit',
        'git_show',
        'run_command',
      ],
      async run(raw, post) {
        const data = raw as PullData;
        const identity = await chatGitIdentity(data.workflowChatId, data.actorId);

        // The repair turn's tools come from this step's `repairTools`, so the
        // chat's own phase is left exactly where the user had it — a sync is
        // not a reason to move somebody's chat into EXECUTE.
        const pauseWithConflicts = async (files: string[]): Promise<never> => {
          throw new AutomatismFailure(
            tmsg('pull.conflicts', {
              target: data.targetName,
              files: files.length ? files.map((f) => `- ${f}`).join('\n') : '- (files unknown)',
            }),
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
          // The rebase gave every commit a new sha — carry the execution rows
          // (and with them the publishable head) onto the rewritten history.
          await reanchorExecutions(
            data.workflowChatId,
            data.workBranch,
            data.targetName,
            result.sha!,
          );
          await post(
            tmsg('pull.rebased', { target: data.targetName, sha: result.sha!.slice(0, 8) }),
          );
        } catch (err) {
          if (err instanceof AutomatismFailure) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new AutomatismFailure(
            tmsg('pull.rebaseFailed', { target: data.targetName, error: message }),
          );
        }
      },
    },
    siteCheckStep,
    {
      name: 'finalize',
      async run(raw, post) {
        const data = raw as PullData;
        if (data.restorePhase) {
          // Payload from before repair tools existed: that flow moved the chat
          // into EXECUTE and owed it a restore. Honour the debt, then stop
          // carrying it — nothing writes this field any more.
          const phase = data.restorePhase === 'preview' ? 'execute' : data.restorePhase;
          await prisma.chat.updateMany({
            where: { id: data.workflowChatId },
            data: { workflowPhase: phase, entityVersion: { increment: 1 } },
          });
          emitChatState(data.workflowChatId);
          data.restorePhase = undefined;
        }
        await post(tmsg('pull.done', { target: data.targetName }));
      },
    },
  ],
});

// The same checkpoint on its own, for callers that want it at another point
// (see startSiteCheck) — one step, same pause-and-fix behaviour.
registerAutomatism({ type: 'site-check', steps: [siteCheckStep] });

/**
 * Run the site health checkpoint against a chat's draft. Resolves with the
 * automatism id; a broken site pauses it and puts the agent on the repair.
 */
export async function startSiteCheck(chatId: string, actorId: string): Promise<string> {
  const chat = await prisma.chat.findUniqueOrThrow({
    where: { id: chatId },
    include: { branch: true },
  });
  return startAutomatism('site-check', chatId, {
    actorId,
    workflowChatId: chatId,
    workBranch: chat.workBranch,
    targetName: chat.branch.name,
  } satisfies PullData);
}

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

async function failDeploy(data: DeployData, err: unknown, sha?: string): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  deployLog(data)(`FAILED: ${message}`);
  await prisma.publication.update({
    where: { id: data.publicationId },
    data: { status: 'failed', log: (data.logLines ?? []).join('\n') },
  });
  emitChatState(data.workflowChatId);
  throw new AutomatismFailure(
    tmsg('deploy.failed', {
      sha: (sha ?? data.mergedSha ?? '').slice(0, 8),
      target: data.targetName,
      error: message,
      publicationId: data.publicationId,
      log: (data.logLines ?? []).slice(-40).join('\n'),
    }),
  );
}

/** Deploy tail: artifact record, publication success, notifications. */
async function recordDeploySuccess(
  data: DeployData,
  post: (msg: AutomatismMessage) => Promise<void>,
  label: TranslatedMessage,
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
    tmsg('deploy.succeeded', {
      label,
      live: data.result?.externalUrl ? tmsg('deploy.liveAt', { url: data.result.externalUrl }) : '',
      log: (data.logLines ?? []).length
        ? tmsg('deploy.logTail', { log: (data.logLines ?? []).slice(-20).join('\n') })
        : '',
    }),
  );
  emitChatState(data.workflowChatId);
}

/**
 * Type-specific deploy pre-flight: build the tree the merge WOULD produce
 * (`astro build` for an Astro site, the checkout itself for a static one) and
 * run the dist validators over the result.
 *
 * Against the merged tree, because that is what gets deployed — the work
 * branch alone can build fine and still break once the target's changes are
 * in. Before the merge, because nothing may move until it passes: a failure
 * leaves both branches untouched, so the fix lands in the work branch and the
 * retry re-derives the merged tree and converges. Returns the validated
 * commit, or null when the merge conflicts (nothing to build yet — the merge
 * step materializes those conflicts for the agent).
 */
async function prevalidate(data: DeployData): Promise<string | null> {
  const log = deployLog(data);
  const identity = await chatGitIdentity(data.workflowChatId, data.actorId);
  const preview = await mergePreviewCommit(data.workBranch, data.targetName, identity);
  if (!preview) {
    log(`${data.workBranch} conflicts with ${data.targetName} — validating after the conflict is resolved.`);
    return null;
  }
  try {
    await prevalidateBuild(preview, log);
  } catch (err) {
    if (err instanceof AutomatismFailure) throw err;
    await failDeploy(data, err, preview);
  }
  return preview;
}

/** Deploy-side repairs read state and re-run; they never edit the site. */
const DEPLOY_REPAIR_TOOLS = [
  'list_publications',
  'get_publication',
  'check_deployment_status',
  'target_file',
];

const prevalidateStep: AutomatismStep = {
  name: 'validate',
  // A failed pre-validation is a broken build of the MERGED tree: the agent
  // reads the log and fixes the source on the work branch.
  repairTools: [
    ...DEPLOY_REPAIR_TOOLS,
    'read_file',
    'write_file',
    'edit_file',
    'run_command',
    'lint',
    'git_commit',
  ],
  async run(raw, post) {
    const data = raw as DeployData;
    await prisma.publication.update({
      where: { id: data.publicationId },
      data: { status: 'running' },
    });
    const preview = await prevalidate(data);
    await post(
      preview
        ? tmsg('deploy.validated', {
            workBranch: data.workBranch,
            target: data.targetName,
            sha: preview.slice(0, 8),
          })
        : tmsg('deploy.validateDeferred', {
            workBranch: data.workBranch,
            target: data.targetName,
          }),
    );
  },
};

const mergeStep: AutomatismStep = {
  name: 'merge',
  // Merge conflicts are handed to the workflow chat, which owns the worktree.
  repairTools: [
    ...DEPLOY_REPAIR_TOOLS,
    'list_conflicts',
    'show_conflict',
    'resolve_conflict_take',
    'read_file',
    'write_file',
    'edit_file',
    'git_commit',
    'git_show',
    'run_command',
  ],
  async run(raw, post) {
    const data = raw as DeployData;
    // A conflict round committed a reverse merge onto the work branch after
    // the validate step ran (or made it skip) — that resolution is
    // unvalidated code, and this retry is the last point before the merge.
    if (data.conflictStarted) await prevalidate(data);
    const identity = await chatGitIdentity(data.workflowChatId, data.actorId);
    await prisma.publication.update({
      where: { id: data.publicationId },
      data: { status: 'running' },
    });
    // The publish approval bound the work-branch head; publish() checked it
    // synchronously, but the merge runs later — re-check so nothing that
    // moved the branch in between (e.g. a sync/rebase) gets deployed under
    // the old approval. A conflict round legitimately moves the head.
    if (data.approvedSha && !data.conflictStarted) {
      const head = await branchSha(data.workBranch);
      if (head !== data.approvedSha) {
        throw new AutomatismFailure(
          tmsg('deploy.mergeFailed', {
            target: data.targetName,
            error: `work branch ${data.workBranch} moved since the publish was approved (${data.approvedSha.slice(0, 8)} → ${head.slice(0, 8)}) — review and publish again`,
          }),
        );
      }
    }
    try {
      const targetSha = await withBranchLock(data.targetBranchId, () =>
        mergeInto(data.workBranch, data.targetName, identity),
      );
      data.mergedSha = targetSha;
      await prisma.publication.update({
        where: { id: data.publicationId },
        data: { sha: targetSha },
      });
      await post(
        tmsg('deploy.merged', {
          workBranch: data.workBranch,
          target: data.targetName,
          sha: targetSha.slice(0, 8),
        }),
      );
      deployLog(data)(`Merged into ${data.targetName} (${targetSha.slice(0, 8)}).`);
      // The target moved — every chat on this branch just went targetAhead
      // (their Sync button must appear without a reload).
      emitChatStatesForBranch(data.targetBranchId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isConflictError(err)) {
        throw new AutomatismFailure(
          tmsg('deploy.mergeFailed', { target: data.targetName, error: message }),
        );
      }
      // Materialize the conflict in the source chat's work branch worktree —
      // this deployment chat's tools operate on exactly that worktree, so the
      // agent resolves it here. Committing the reverse merge makes the
      // retried forward merge clean.
      await abortMerge(data.workBranch);
      data.conflictStarted = true;
      const files = await withBranchLock(data.workBranch, () =>
        beginConflictMerge(data.workBranch, data.targetName, identity),
      );
      // Keep the publish card truthful while the automatism is paused: the
      // publication stays 'running', so surface the conflict in its log.
      deployLog(data)(`Merge conflicts with ${data.targetName} — being resolved in the deployment chat.`);
      await prisma.publication.update({
        where: { id: data.publicationId },
        data: { log: (data.logLines ?? []).join('\n') },
      });
      throw new AutomatismFailure(
        tmsg('deploy.mergeConflicts', {
          workBranch: data.workBranch,
          target: data.targetName,
          files: files.length ? files.map((f) => `- ${f}`).join('\n') : '- (files unknown)',
        }),
      );
    }
  },
};

/**
 * Merge-only deploy: the target is not the default branch, so there is no
 * deployment to run. Every real flow brings its own steps (types.ts), so this
 * is the whole chain for "merged, nothing to publish".
 */
const mergeOnlyStep: AutomatismStep = {
  // Deploying is the flow's job; a failure here is read, understood, and
  // either re-run or escalated — the site is not edited from the deploy chat.
  repairTools: DEPLOY_REPAIR_TOOLS,
  name: 'deploy',
  async run(raw, post) {
    const data = raw as DeployData;
    await prisma.publication.update({
      where: { id: data.publicationId },
      data: { status: 'running' },
    });
    const log = deployLog(data);
    try {
      log(`Merged into ${data.targetName} (non-default target — no deployment).`);
      await recordDeploySuccess(data, post, tmsg('deploy.mergeOnlyDone'));
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
    // Every flow phase repairs the same way: read the publication state, fix
    // the outside world (or escalate), re-run the step.
    repairTools: DEPLOY_REPAIR_TOOLS,
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
          targetBranch: data.targetName,
          log: deployLog(data),
          state: (data.flowState ??= {}),
        });
        if (result) data.result = { ...(data.result ?? {}), ...result };
        await post(tmsg('deploy.stepDone', { flow: flow.id, step: step.name }));
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
    repairTools: DEPLOY_REPAIR_TOOLS,
    async run(raw, post) {
      const data = raw as DeployData;
      try {
        if (flow.verify) {
          const ok = await flow.verify(
            {
              sha: data.mergedSha!,
              repoPath: path.resolve(env().REPO_PATH),
              targetBranch: data.targetName,
              log: deployLog(data),
            },
            data.result ?? {},
          );
          if (!ok) throw new Error('Post-publish verification failed');
        }
        await recordDeploySuccess(
          data,
          post,
          tmsg('deploy.flowSucceeded', { flow: flow.id, sha: data.mergedSha!.slice(0, 8) }),
        );
      } catch (err) {
        if (err instanceof AutomatismFailure) throw err;
        await failDeploy(data, err);
      }
    },
  };
}

const finalizeStep: AutomatismStep = {
  repairTools: DEPLOY_REPAIR_TOOLS,
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
    await post(tmsg('deploy.finished'));
    emitChatState(data.workflowChatId);
    emitChatState(data.deployChatId);
  },
};

// 'validate' is injected ahead of every flow's own steps — the build gate is
// the publisher's, not a flow's, so a flow that only pushes still gets it.
registerAutomatism({
  type: 'deploy',
  steps: [prevalidateStep, mergeStep, mergeOnlyStep, finalizeStep],
});
for (const flow of listDeployFlows()) {
  registerAutomatism({
    type: `deploy:${flow.id}`,
    steps: [
      prevalidateStep,
      mergeStep,
      ...flow.steps.map((s) => flowStep(flow, s)),
      verifyStep(flow),
      finalizeStep,
    ],
  });
}

/** Automatism type for a publish: per-flow, or the merge-only chain when the
 *  target is not the default branch and no flow applies. */
export function deployAutomatismType(flow: DeployFlow | null): string {
  return flow ? `deploy:${flow.id}` : 'deploy';
}
