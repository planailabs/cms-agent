/**
 * Application-wide constants
 *
 * Centralizes magic numbers, storage keys, and configuration values
 * to improve maintainability and prevent inconsistencies.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Application Metadata
// ─────────────────────────────────────────────────────────────────────────────

export const APP_NAME = 'CMS Agent';
export const APP_VERSION = 'v0.1.0';
/** Short git commit embedded at build time (empty when unknown). */
export const APP_COMMIT = import.meta.env.PUBLIC_GIT_COMMIT ?? '';

// ─────────────────────────────────────────────────────────────────────────────
// Storage Keys
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keys used for sessionStorage.
 * Note: This app uses sessionStorage only (no localStorage or cookies for
 * client state) per the original app's privacy requirements.
 */
export const STORAGE_KEYS = {
  /** Theme mode preference (system | light | dark) */
  THEME: 'cmsagent-theme-mode',
  /** Selected language locale */
  LANGUAGE: 'cmsagent-language',
  /** Cached user state for instant header render (prevents layout shift) */
  USER_CACHE: 'cmsagent-user-cache',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** Per-chat storage key for chat conversation cache */
export const chatStorageKey = (chatId: string): string =>
  `cmsagent-chat-${chatId}`;

// ─────────────────────────────────────────────────────────────────────────────
// Theme Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const THEME = {
  DARK: {
    BACKGROUND: '#1e1e1e',
    TEXT: '#dadada',
  },
  LIGHT: {
    BACKGROUND: '#fcfcfc',
    TEXT: '#222222',
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Composer Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const COMPOSER = {
  /** Default maximum character limit */
  MAX_CHARS: 1024,
  /** Maximum height in pixels before scrolling */
  MAX_HEIGHT: 200,
  /** Minimum height (single line) in pixels */
  MIN_HEIGHT: 24,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Animation Timings (in milliseconds)
// ─────────────────────────────────────────────────────────────────────────────

export const TIMING = {
  /** Default streaming configuration */
  STREAM: {
    INITIAL_DELAY: 480,
    CHUNK_SIZE: 3,
    INTERVAL: 28,
  },
  /** App fade-in animation duration */
  APP_FADE_IN: 1200,
} as const;
