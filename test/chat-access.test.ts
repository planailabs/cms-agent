/**
 * Chat visibility setting (chats.sharedVisibility): default on = everyone
 * sees everything; off = non-admins see and open only their own chats,
 * admins and creator-less (system) chats are unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { canSeeOthersChats, chatAccessDenied, chatVisibilityWhere } from '@/lib/chatAccess';
import { setBool, SETTING_KEYS } from '@/lib/settings';

const OWNER = { id: 'u-chatvis-owner', role: 'editor' };
const OTHER = { id: 'u-chatvis-other', role: 'editor' };
const ADMIN = { id: 'u-chatvis-admin', role: 'admin' };

const resetSetting = () => setBool(SETTING_KEYS.chatsSharedVisibility, true);

beforeAll(async () => {
  await resetSetting();
});

afterAll(async () => {
  await resetSetting();
  await prisma.appSetting.deleteMany({ where: { key: SETTING_KEYS.chatsSharedVisibility } });
});

describe('chat visibility setting', () => {
  it('defaults to shared: everyone sees everything', async () => {
    expect(await canSeeOthersChats(OTHER)).toBe(true);
    expect(await chatVisibilityWhere(OTHER)).toEqual({});
    expect(await chatAccessDenied(OTHER, { createdById: OWNER.id })).toBeNull();
  });

  it('restricted: non-admins are narrowed to their own chats', async () => {
    await setBool(SETTING_KEYS.chatsSharedVisibility, false);
    expect(await canSeeOthersChats(OTHER)).toBe(false);
    // own chats + creator-less system chats stay listed
    expect(await chatVisibilityWhere(OTHER)).toEqual({
      OR: [{ createdById: OTHER.id }, { createdById: null }],
    });

    // own chat fine, foreign chat reads as 404
    expect(await chatAccessDenied(OTHER, { createdById: OTHER.id })).toBeNull();
    const denied = await chatAccessDenied(OTHER, { createdById: OWNER.id });
    expect(denied?.status).toBe(404);
  });

  it('restricted: admins and creator-less system chats stay visible', async () => {
    await setBool(SETTING_KEYS.chatsSharedVisibility, false);
    expect(await canSeeOthersChats(ADMIN)).toBe(true);
    expect(await chatVisibilityWhere(ADMIN)).toEqual({});
    expect(await chatAccessDenied(ADMIN, { createdById: OWNER.id })).toBeNull();
    expect(await chatAccessDenied(OTHER, { createdById: null })).toBeNull();
  });
});
