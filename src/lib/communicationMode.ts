import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export const COMMUNICATION_MODES = ['default', 'technical', 'non-technical'] as const;
export type CommunicationModePreference = (typeof COMMUNICATION_MODES)[number];
export type CommunicationMode = Exclude<CommunicationModePreference, 'default'>;

export const isCommunicationModePreference = (
  value: unknown,
): value is CommunicationModePreference =>
  typeof value === 'string' &&
  COMMUNICATION_MODES.includes(value as CommunicationModePreference);

export const resolveCommunicationMode = (
  preference: unknown,
  serverDefault: CommunicationMode = env().DEFAULT_COMMUNICATION_MODE,
): CommunicationMode =>
  preference === 'technical' || preference === 'non-technical' ? preference : serverDefault;

export async function communicationModeForUser(userId: string): Promise<CommunicationMode> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { communicationMode: true },
  });
  return resolveCommunicationMode(user?.communicationMode);
}
