/**
 * Live user context per chat — fed by the preview overlay via
 * POST /api/chat/context, read by the get_user_context tool and injected as
 * PageContext on messages. In-memory: it describes "right now".
 */

export interface LiveUserContext {
  userId: string;
  userName?: string;
  url?: string;
  route?: string;
  updatedAt: number;
}

const stores = new Map<string, Map<string, unknown>>();

export function getUserContextStore(chatId: string): Map<string, unknown> {
  let store = stores.get(chatId);
  if (!store) {
    store = new Map();
    stores.set(chatId, store);
  }
  return store;
}

export function updateUserContext(chatId: string, userId: string, ctx: Partial<LiveUserContext>): void {
  const store = getUserContextStore(chatId);
  const prev = (store.get(userId) as LiveUserContext | undefined) ?? { userId, updatedAt: 0 };
  store.set(userId, { ...prev, ...ctx, userId, updatedAt: Date.now() });
}
