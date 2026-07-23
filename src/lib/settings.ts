/**
 * Global app settings (admin toggles) stored one-row-per-key in AppSetting.
 * Thin typed accessors so callers don't sprinkle raw key strings around.
 */
import { prisma } from '@/lib/db';

export const SETTING_KEYS = {
  attachmentsOnePerMessage: 'attachments.onePerMessage',
} as const;

async function getBool(key: string, fallback = false): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return typeof row?.value === 'boolean' ? row.value : fallback;
}

export async function setBool(key: string, value: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/** When true, a message may carry at most one attachment. */
export const getAttachmentsOnePerMessage = () =>
  getBool(SETTING_KEYS.attachmentsOnePerMessage);
