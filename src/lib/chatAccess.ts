/**
 * Chat visibility — when the admin turns `chats.sharedVisibility` off,
 * non-admins see and open only their own chats. Admins (and automatism
 * server-side flows, which don't pass through these routes) are unaffected.
 */
import { getChatsSharedVisibility } from '@/lib/settings';

interface Viewer {
  id: string;
  role: string;
}

/** True when `user` may see chats created by others. */
export const canSeeOthersChats = async (user: Viewer): Promise<boolean> =>
  user.role === 'admin' || (await getChatsSharedVisibility());

/** Prisma `where` fragment for chat lists ({} when unrestricted). Restricted
 *  viewers keep their own chats plus creator-less system chats (deployments),
 *  matching what `chatAccessDenied` lets them open. */
export const chatVisibilityWhere = async (
  user: Viewer,
): Promise<{ OR?: Array<{ createdById: string | null }> }> =>
  (await canSeeOthersChats(user))
    ? {}
    : { OR: [{ createdById: user.id }, { createdById: null }] };

/** 404 for a chat the viewer must not see (indistinguishable from absent),
 *  null when access is fine. Chats without a creator (system flows) stay
 *  visible. */
export const chatAccessDenied = async (
  user: Viewer,
  chat: { createdById: string | null },
): Promise<Response | null> => {
  if (!chat.createdById || chat.createdById === user.id || (await canSeeOthersChats(user))) {
    return null;
  }
  return new Response(JSON.stringify({ error: 'Chat not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
};
