/**
 * Workspace State — types + factory for the CMS workspace slice of AppState
 * (preview pane, diff viewer, phase actions, context chips).
 *
 * Kept in its own module so the extracted chat core only needs a one-line
 * import in app/state.ts.
 */

import type { PublishCardState } from './publishCard';

// ─────────────────────────────────────────────────────────────────────────────
// Page context (mirror of src/lib/agent/types.ts PageContext — client copy)
// ─────────────────────────────────────────────────────────────────────────────

export interface PageContextSelection {
  exact: string;
  prefix?: string;
  suffix?: string;
  cssPath?: string;
}

export interface PageContextElement {
  tag: string;
  id?: string;
  classes?: string[];
  headingPath?: string[];
  outerHtmlExcerpt?: string;
}

/** Anchor payload sent as `pageContext` with the next chat message. */
export interface PageContext {
  url: string;
  route?: string;
  branch?: string;
  selection?: PageContextSelection;
  element?: PageContextElement;
}

/** A pending context chip shown above the composer. */
export interface ContextChip {
  kind: 'selection' | 'element';
  context: PageContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution / diff types
// ─────────────────────────────────────────────────────────────────────────────

/** An execution commit card in the chat (execution_committed SSE event). */
export interface ExecutionCard {
  sha: string;
  summary: string;
  /** Set once execution_reverted arrives for this sha. */
  reverted?: { revertSha: string; by: string };
  /** Revert POST in flight. */
  busy?: boolean;
}

export interface DiffPage {
  route: string;
  file: string;
}

export type DiffViewMode = 'side-by-side' | 'highlight' | 'onion';

export interface DiffState {
  /** Chat the pages were loaded for (guards stale loads). */
  forChatId: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  pages: DiffPage[];
  unresolved: string[];
  selectedRoute: string | null;
  mode: DiffViewMode;
  /** Highlight mode: whether the diff overlay image is visible. */
  overlayVisible: boolean;
  /** Onion mode: slider position 0..100 (percentage of "after" shown). */
  onionPercent: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace state
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkspaceState {
  /** Right sidebar width in px (resizable via the drag handle). */
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** Branch switcher / chat list panel expanded. */
  branchListOpen: boolean;

  /** Current route inside the preview iframe (cms:navigation). */
  previewRoute: string;
  /** Element picker armed (waiting for a click inside the preview). */
  pickerActive: boolean;

  /** Sha to publish — from phase_changed.executionSha / execution_committed. */
  executionSha: string | null;
  /** Committed-execution cards shown in the chat. */
  executions: ExecutionCard[];
  /** Publish progress card (null = no publish attempted). */
  publish: PublishCardState | null;

  /** Pending context chip (selection/element from the preview overlay). */
  contextChip: ContextChip | null;
  /** "current chat / new chat" popover open for the chip. */
  chipChoiceOpen: boolean;

  /** Diff viewer state (PREVIEW phase main area). */
  diff: DiffState;
}

export const createInitialDiffState = (): DiffState => ({
  forChatId: null,
  loading: false,
  loaded: false,
  error: null,
  pages: [],
  unresolved: [],
  selectedRoute: null,
  mode: 'side-by-side',
  overlayVisible: true,
  onionPercent: 50,
});

export const createInitialWorkspaceState = (): WorkspaceState => ({
  sidebarWidth: 420,
  sidebarCollapsed: false,
  branchListOpen: false,
  previewRoute: '/',
  pickerActive: false,
  executionSha: null,
  executions: [],
  publish: null,
  contextChip: null,
  chipChoiceOpen: false,
  diff: createInitialDiffState(),
});

/** Clears the chat-scoped parts of the workspace (call on chat switch). */
export const resetWorkspaceChatState = (ws: WorkspaceState): void => {
  ws.executionSha = null;
  ws.executions = [];
  ws.publish = null;
  ws.contextChip = null;
  ws.chipChoiceOpen = false;
  ws.diff = createInitialDiffState();
};
