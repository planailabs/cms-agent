/**
 * Application State Types and Initialization
 *
 * Defines the shape of global application state and provides
 * factory functions for creating initial state.
 *
 * State is divided into:
 * - UI state (menus, overlays)
 * - User state (profile from GET /api/me)
 * - Branch/chat state (workspace from GET /api/branches)
 * - Chat state (conversation, streaming)
 * - Preference state (theme, locale)
 */

import {
  defaultLocale,
  supportedLocales,
  type LocaleKey,
  type StreamConfig,
} from '../content';
import { STORAGE_KEYS } from '../constants';
import {
  createInitialWorkspaceState,
  type WorkspaceState,
} from '../../workspace/state';

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

/** Theme mode preference */
export type ThemeMode = 'system' | 'light' | 'dark';

/** Workflow phase of a chat (plan → execute → preview → published) */
export type WorkflowPhase = 'plan' | 'execute' | 'preview' | 'published';

/** Signed-in user profile (from GET /api/me) */
export interface AppUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

/** Chat summary within a branch (from GET /api/branches) */
export interface ChatSummary {
  id: string;
  title: string;
  workflowPhase: WorkflowPhase;
  createdBy: { id: string; name: string } | null;
}

/** Branch with its chats (from GET /api/branches) */
export interface Branch {
  id: string;
  name: string;
  chats: ChatSummary[];
}

/**
 * Chat conversation state.
 * Tracks the current conversation and streaming state.
 */
export interface ChatState {
  /** The user's submitted prompt (scripted-stream view) */
  userPrompt: string;
  /** Currently visible portion of assistant's response (for streaming) */
  assistantVisibleText: string;
  /** Full assistant response text */
  assistantFullText: string;
  /** Streaming configuration for this response */
  stream: StreamConfig;
  /** Whether the assistant response is currently streaming */
  isStreaming: boolean;
  /** Animation flag: user bubble just appeared */
  userBubbleJustAppeared?: boolean;
  /** Animation flag: assistant bubble just appeared */
  assistantBubbleJustAppeared?: boolean;
  /** Current position in a scripted conversation (if any) */
  conversation?: {
    scenarioId: string;
    stepId: string;
  };
  /** AI chat state (SSE-driven conversation) */
  aiChat?: {
    messages: Array<import('../actions/chat/cache').StoredMessage>;
    /**
     * State machine phase:
     *   idle      → composer visible
     *   waiting   → thinking indicator, waiting for server
     *   streaming → word-by-word reveal of assistant text
     *   tool      → executing a server-side tool (spinner indicator)
     *   question  → showing ask_question UI (buttons or text input)
     *   error     → error message + composer
     */
    phase: 'idle' | 'waiting' | 'streaming' | 'tool' | 'question' | 'error';
    /** Word-by-word streaming reveal of the last assistant message */
    streamingText?: { full: string; visible: string };
    error?: string;
    /** Active client-side tool prompt (waiting for user input) */
    clientPrompt?: {
      toolName: string;
      input: Record<string, unknown>;
      /** Card dismissed locally ("Not yet — keep chatting"); composer shows */
      dismissed?: boolean;
    };
    /** Name of currently executing tool (set during 'tool' phase) */
    toolName?: string;
  };
}

/**
 * Root application state interface.
 * Contains all UI, user, and preference state.
 */
export interface AppState {
  // ─── Preferences ───────────────────────────────────────────────────────────
  /** Selected locale key */
  localeKey: LocaleKey;
  /** Theme mode preference */
  themeMode: ThemeMode;

  // ─── UI State ──────────────────────────────────────────────────────────────
  /** Whether the language dropdown is open */
  isLanguageMenuOpen: boolean;
  /** Whether the user dropdown is open */
  isAuthMenuOpen: boolean;
  /** Whether the settings overlay is visible */
  isSettingsOverlayOpen: boolean;

  // ─── User State ────────────────────────────────────────────────────────────
  /** Signed-in user (always present behind server-side auth; null until /api/me resolves) */
  user: AppUser | null;

  // ─── Branch/Chat Workspace ─────────────────────────────────────────────────
  /** Branches with their chats (from GET /api/branches) */
  branches: Branch[];
  /** Currently selected branch */
  activeBranchId: string | null;
  /** Currently open chat */
  activeChatId: string | null;
  /** Workflow phase of the active chat (updated by phase_changed SSE event) */
  workflowPhase: WorkflowPhase;

  // ─── Chat State ────────────────────────────────────────────────────────────
  /** Current chat conversation state (null until a chat is opened) */
  chat: ChatState | null;

  // ─── Workspace State ───────────────────────────────────────────────────────
  /** CMS workspace state (preview pane, diff viewer, phase actions) */
  workspace: WorkspaceState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Locale Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads stored locale preference from sessionStorage.
 * Returns null if not found or invalid.
 */
const readStoredLocale = (): LocaleKey | null => {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEYS.LANGUAGE);
    if (stored && supportedLocales.includes(stored as LocaleKey)) {
      return stored as LocaleKey;
    }
  } catch {
    // Ignore storage access issues (private browsing, etc.)
  }
  return null;
};

/**
 * Detects browser locale from navigator.language.
 * Falls back to default locale if detection fails.
 */
const detectBrowserLocale = (): LocaleKey => {
  if (typeof navigator === 'undefined') {
    return defaultLocale;
  }

  const lang = navigator.language || navigator.languages?.[0];
  if (lang && lang.toLowerCase().startsWith('de')) {
    return 'de';
  }
  return defaultLocale;
};

// ─────────────────────────────────────────────────────────────────────────────
// User State Cache (prevents header layout shift on reload)
// ─────────────────────────────────────────────────────────────────────────────

/** Cached user state for instant header render */
interface CachedUserState {
  user: AppUser;
  timestamp: number;
}

/** Max age for cached user state (5 minutes) */
const USER_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Reads cached user state from sessionStorage.
 * Returns null if not found, invalid, or expired.
 */
const readCachedUserState = (): AppUser | null => {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEYS.USER_CACHE);
    if (!stored) return null;

    const parsed = JSON.parse(stored) as CachedUserState;

    // Validate structure
    if (typeof parsed.user?.id !== 'string') return null;

    // Check expiration
    if (parsed.timestamp) {
      const age = Date.now() - parsed.timestamp;
      if (age > USER_CACHE_MAX_AGE_MS) return null;
    }

    return parsed.user;
  } catch {
    return null;
  }
};

/**
 * Saves user state to sessionStorage for instant header render on reload.
 */
export const cacheUserState = (user: AppUser): void => {
  try {
    const cached: CachedUserState = {
      user,
      timestamp: Date.now(),
    };
    sessionStorage.setItem(STORAGE_KEYS.USER_CACHE, JSON.stringify(cached));
  } catch {
    // Ignore storage errors
  }
};

/**
 * Clears cached user state (call on sign out).
 */
export const clearCachedUserState = (): void => {
  try {
    sessionStorage.removeItem(STORAGE_KEYS.USER_CACHE);
  } catch {
    // Ignore storage errors
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// State Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the initial application state.
 * Uses cached user state from sessionStorage to prevent header layout shift.
 */
export const createInitialState = (): AppState => {
  // Read cached user state for instant header render
  const cachedUser = readCachedUserState();

  return {
    localeKey: readStoredLocale() ?? detectBrowserLocale(),
    themeMode: 'system', // Initial default, will be updated by initTheme
    isLanguageMenuOpen: false,
    isAuthMenuOpen: false,
    isSettingsOverlayOpen: false,
    // Use cached user state to prevent header flash
    user: cachedUser,
    branches: [],
    activeBranchId: null,
    activeChatId: null,
    workflowPhase: 'plan',
    chat: null,
    workspace: createInitialWorkspaceState(),
  };
};

/**
 * Persists locale selection to sessionStorage and updates document lang.
 * Fails silently if storage is unavailable.
 */
export const persistLocaleSelection = (locale: LocaleKey): void => {
  // Update document lang attribute for accessibility and SEO
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }

  try {
    sessionStorage.setItem(STORAGE_KEYS.LANGUAGE, locale);
  } catch {
    // Ignore storage errors (private browsing, quota exceeded, etc.)
  }
};
