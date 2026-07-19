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

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

/** Cross-browser comparison overlay (main area) — preview + regular mode. */
export interface BrowserCompareState {
  open: boolean;
  a: BrowserName;
  b: BrowserName;
  /** Reuses the diff widgets: highlight (overlay) or onion (slider). */
  mode: 'highlight' | 'onion';
  overlayVisible: boolean;
  onionPercent: number;
}

/** A done chat in the archive view (GET /api/chats/archived). */
export interface ArchivedChatRow {
  id: string;
  title: string;
  kind: string;
  branch: string;
  workBranch: string;
  createdBy: string | null;
  archivedAt: string;
  publication: { status: string; sha: string; externalUrl: string | null } | null;
}

/** A commit row in the git modal (GET /api/git/commits). */
export interface GitCommitRow {
  sha: string;
  message: string;
  authorName: string;
  date: string;
  /** Already on the target branch — rendered greyed out. */
  onTarget: boolean;
}

/** Full-screen git modal: commit list per branch + per-commit diff. */
export interface GitModalState {
  open: boolean;
  loading: boolean;
  error: string | null;
  /** Branch whose commits are listed (work branch or target branch). */
  branch: string | null;
  /** Target branch of a work branch (null when viewing a target branch). */
  target: string | null;
  commits: GitCommitRow[];
  /** Commit whose diff is shown (null = list view). */
  selectedSha: string | null;
  patch: string | null;
  patchLoading: boolean;
}

/** A skill row in the capabilities modal (GET /api/agent/capabilities). */
export interface CapabilitySkillRow {
  name: string;
  description: string;
  plugin: string;
  source: 'plugin' | 'branch';
  /** Installed skill hidden by a same-named branch-local one. */
  shadowed: boolean;
}

/** An MCP row in the capabilities modal. */
export interface CapabilityMcpRow {
  name: string;
  attached: boolean;
  reason?: string;
  tools: string[];
  indexStatus?: string;
}

/** Full-screen skills/MCP capabilities modal (per-chat status). */
export interface CapsModalState {
  open: boolean;
  loading: boolean;
  error: string | null;
  /** Chat whose capabilities are shown. */
  chatId: string | null;
  skills: CapabilitySkillRow[];
  rules: Array<{ plugin: string }>;
  mcps: CapabilityMcpRow[];
}

/** Full-screen archive modal (done chats; delete = chat + branch + data). */
export interface ArchiveState {
  open: boolean;
  loading: boolean;
  error: string | null;
  chats: ArchivedChatRow[];
  /** Chat id with a delete in flight. */
  busyId: string | null;
}

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
  /** Open preview tabs (routes); the active one mirrors previewRoute. */
  previewTabs: string[];
  activeTabIndex: number;
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

  /** Diff viewer state (PREVIEW phase main area). */
  diff: DiffState;

  /** Cross-browser comparison overlay (toggled from the preview toolbar). */
  browserCompare: BrowserCompareState;

  /** Archive modal (not chat-scoped — survives chat switches). */
  archive: ArchiveState;

  /** Git modal (commit list + diffs; not chat-scoped). */
  git: GitModalState;

  /** Skills/MCP capabilities modal (not chat-scoped; shows any chat). */
  caps: CapsModalState;

  /** Step progress of the active chat's automatism (deployment chats). */
  automatism: AutomatismProgress | null;

  /** Generic composer-style input modal (null = closed). */
  inputModal: { title: string; hint?: string; placeholder: string } | null;

  /** Target branch has commits the work branch lacks (Sync button shows). */
  targetAhead: boolean;
}

/** Mirror of the server's AutomatismState (history + automatism_state SSE). */
export interface AutomatismProgress {
  forChatId: string;
  automatismType: string;
  status: string;
  step: number;
  steps: string[];
  lastError: string | null;
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
  previewTabs: ['/'],
  activeTabIndex: 0,
  pickerActive: false,
  executionSha: null,
  executions: [],
  publish: null,
  contextChip: null,
  diff: createInitialDiffState(),
  browserCompare: createInitialBrowserCompareState(),
  archive: { open: false, loading: false, error: null, chats: [], busyId: null },
  git: createInitialGitModalState(),
  caps: createInitialCapsModalState(),
  automatism: null,
  inputModal: null,
  targetAhead: false,
});

export const createInitialCapsModalState = (): CapsModalState => ({
  open: false,
  loading: false,
  error: null,
  chatId: null,
  skills: [],
  rules: [],
  mcps: [],
});

export const createInitialGitModalState = (): GitModalState => ({
  open: false,
  loading: false,
  error: null,
  branch: null,
  target: null,
  commits: [],
  selectedSha: null,
  patch: null,
  patchLoading: false,
});

export const createInitialBrowserCompareState = (): BrowserCompareState => ({
  open: false,
  a: 'chromium',
  b: 'firefox',
  mode: 'highlight',
  overlayVisible: true,
  onionPercent: 50,
});

/** Clears the chat-scoped parts of the workspace (call on chat switch). */
export const resetWorkspaceChatState = (ws: WorkspaceState): void => {
  ws.previewRoute = '/';
  ws.previewTabs = ['/'];
  ws.activeTabIndex = 0;
  ws.executionSha = null;
  ws.executions = [];
  ws.publish = null;
  ws.contextChip = null;
  ws.diff = createInitialDiffState();
  ws.browserCompare = createInitialBrowserCompareState();
  ws.automatism = null;
  ws.targetAhead = false;
};
