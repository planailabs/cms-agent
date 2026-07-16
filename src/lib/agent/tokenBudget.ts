/**
 * Token rate limiting — per-user hourly budgets on Prisma.
 * Budgets come from env (0 = unlimited). Ported from chat/'s tokenBudget.ts.
 */
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export async function checkTokenBudget(
  userId: string,
): Promise<{ allowed: boolean; inputUsed: number; outputUsed: number }> {
  const { INPUT_TOKEN_BUDGET_PER_HOUR, OUTPUT_TOKEN_BUDGET_PER_HOUR } = env();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const rows = await prisma.tokenUsage.findMany({
    where: { userId, createdAt: { gte: oneHourAgo } },
    select: { inputTokens: true, outputTokens: true },
  });

  const inputUsed = rows.reduce((s, r) => s + r.inputTokens, 0);
  const outputUsed = rows.reduce((s, r) => s + r.outputTokens, 0);

  const allowed =
    (INPUT_TOKEN_BUDGET_PER_HOUR === 0 || inputUsed < INPUT_TOKEN_BUDGET_PER_HOUR) &&
    (OUTPUT_TOKEN_BUDGET_PER_HOUR === 0 || outputUsed < OUTPUT_TOKEN_BUDGET_PER_HOUR);

  return { allowed, inputUsed, outputUsed };
}

export async function recordTokenUsage(
  userId: string,
  chatId: string | null,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  await prisma.tokenUsage.create({
    data: { userId, chatId, inputTokens, outputTokens },
  });
}
