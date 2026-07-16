/**
 * Autonomy grants (plan §12, medved §11.4): admin-configured, never implicit.
 * When an active grant covers a pending propose_plan, the plan auto-approves
 * within the grant's scope and the approval is audited as autonomy.
 */
import { prisma } from '@/lib/db';
import { broadcast } from '@/lib/agent/bus';
import { globToRegExp } from '@/lib/diff/routes';

const RISK_ORDER = ['content', 'template', 'code', 'dependency'] as const;
type Risk = (typeof RISK_ORDER)[number];

interface PlanShape {
  risk?: string;
  files?: Array<{ path: string }>;
  summary?: string;
}

function riskCovered(planRisk: string | undefined, maxRisk: string): boolean {
  const p = RISK_ORDER.indexOf((planRisk ?? 'dependency') as Risk);
  const m = RISK_ORDER.indexOf(maxRisk as Risk);
  return p !== -1 && m !== -1 && p <= m;
}

function pathCovered(files: Array<{ path: string }> | undefined, scope: string[]): boolean {
  if (!files || files.length === 0) return false;
  if (scope.length === 0) return false;
  const regexes = scope.map(globToRegExp);
  return files.every((f) => regexes.some((re) => re.test(f.path)));
}

/**
 * Find an active grant covering this plan for this user. Decrements the
 * execution budget when matched.
 */
export async function findCoveringGrant(
  userId: string,
  plan: PlanShape,
): Promise<{ id: string; createdById: string } | null> {
  const now = new Date();
  const grants = await prisma.autonomyGrant.findMany({
    where: {
      revokedAt: null,
      validFrom: { lte: now },
      validUntil: { gte: now },
      OR: [{ userId }, { userId: null }],
    },
  });

  for (const grant of grants) {
    const actions = grant.actions as string[];
    if (!actions.includes('implement')) continue;
    if (grant.maxExecutions <= 0) continue;
    if (!riskCovered(plan.risk, grant.maxRisk)) continue;
    if (!pathCovered(plan.files, grant.pathScope as string[])) continue;

    const updated = await prisma.autonomyGrant.updateMany({
      where: { id: grant.id, maxExecutions: { gt: 0 } },
      data: { maxExecutions: { decrement: 1 } },
    });
    if (updated.count === 1) return { id: grant.id, createdById: grant.createdById };
  }
  return null;
}

/**
 * Called after a turn ends: when the chat paused on propose_plan and an
 * active grant covers the plan, auto-approve it (audited, visible in chat).
 */
export async function maybeAutoApprovePlan(chatId: string, userId: string): Promise<void> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { turnPhase: true, workflowPhase: true, pendingQuestion: true },
  });
  if (
    !chat ||
    chat.workflowPhase !== 'plan' ||
    chat.turnPhase !== 'waiting_for_answer' ||
    (chat.pendingQuestion as { toolName?: string } | null)?.toolName !== 'propose_plan'
  ) {
    return;
  }

  const plan = (chat.pendingQuestion as unknown as { input: PlanShape }).input;
  const grant = await findCoveringGrant(userId, plan);
  if (!grant) return;

  const creator = await prisma.user.findUnique({ where: { id: grant.createdById } });
  if (!creator) return;

  broadcast(chatId, 'autonomy_applied', {
    type: 'autonomy_applied',
    grantId: grant.id,
    summary: plan.summary,
  });

  // Deferred import to avoid a module cycle (workflow → handler → tools)
  const { approvePlan } = await import('@/lib/agent/workflow');
  await approvePlan({
    chatId,
    actor: { id: creator.id, name: `${creator.name} (autonomy grant)`, email: creator.email },
    idempotencyKey: `autonomy-${grant.id}-${chatId}-${Date.now()}`,
  });
}
