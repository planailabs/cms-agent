import { store } from '../../app/store';
import { openWindow } from '@/components/workspace/window';
import type { DiffViewMode } from '@/components/workspace/state';

const MODES: DiffViewMode[] = ['side-by-side', 'scroll', 'highlight', 'onion'];

/**
 * open_compare — the agent puts the before/after view on screen. Like the
 * language hint this is a live SSE nudge for the user whose turn it is: it
 * touches only what the eye button touches, so nothing extra to persist.
 */
export const applyOpenCompare = (mode: unknown, userId: unknown, chatId: unknown): boolean => {
  // Only for the user whose turn it is, and only while they are looking at
  // that chat — the stage belongs to whatever chat is open.
  if (userId !== store.state.user?.id || chatId !== store.state.activeChatId) return false;
  if (MODES.includes(mode as DiffViewMode)) {
    store.state.workspace.diff.mode = mode as DiffViewMode;
  }
  openWindow('compare'); // notifies + lazy-loads the changed pages
  return true;
};
