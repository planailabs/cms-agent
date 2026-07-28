/**
 * Workspace State — types + factory for the CMS workspace slice of AppState
 * (preview pane, diff viewer, phase actions, context chips).
 *
 * Kept in its own module so the extracted chat core only needs a one-line
 * import in app/state.ts.
 */

import type { EditAnnotations, EditTool } from '@/injected/annotate';
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
  text?: string;
  id?: string;
  classes?: string[];
  headingPath?: string[];
  outerHtmlExcerpt?: string;
}

export interface PageContextCode {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

/** Anchor payload sent as `pageContext` with the next chat message. */
export interface PageContext {
  url: string;
  route?: string;
  branch?: string;
  selection?: PageContextSelection;
  element?: PageContextElement;
  code?: PageContextCode;
}

/** A pending context chip shown above the composer. */
export interface ContextChip {
  kind: 'selection' | 'element' | 'code';
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

export type DiffViewMode = 'side-by-side' | 'highlight' | 'onion' | 'scroll';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

/** Exclusive main-area window (workspace/window.ts registry). */
export type WindowKind = 'browsers' | 'code' | 'git' | 'caps' | 'archive' | 'sessions';

/** Cross-browser comparison window (main area) — preview + regular mode. */
export interface BrowserCompareState {
  a: BrowserName;
  b: BrowserName;
  /** Reuses the diff widgets: highlight (overlay) or onion (slider). */
  mode: 'highlight' | 'onion' | 'scroll';
  overlayVisible: boolean;
  onionPercent: number;
  /** Device preset both engines emulate (null = default 1280×900 viewport). */
  device: string | null;
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

/** Commits window: commit list per branch + per-commit diff. */
export interface GitModalState {
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
  source: 'plugin' | 'branch' | 'admin';
  /** Installed skill hidden by a same-named branch-local one. */
  shadowed: boolean;
}

/** An MCP row in the capabilities modal. */
/** propose_plan input / chat.planJson shape (structured plan). */
export interface ProposedPlan {
  summary?: string;
  steps?: string[];
  files?: Array<{ path: string; action: string; reason: string }>;
  pages?: Array<{ url: string; expectedEffect: string }>;
  risk?: string;
  questions?: string[];
}

/** Code browser modal — worktree tree + file view + line-range selection. */
export interface CodeBrowserState {
  /** Loaded directory listings by relative path ('.' = root). */
  dirs: Record<string, Array<{ name: string; dir: boolean }>>;
  /** Expanded directory paths. */
  expanded: string[];
  /** Currently open file (relative path) and its content lines. */
  filePath: string | null;
  fileLines: string[];
  /** Server-highlighted HTML per line (shiki), aligned with fileLines. */
  fileHighlighted: string[] | null;
  fileTruncated: boolean;
  /** 1-based inclusive selection range (0 = none). */
  selStart: number;
  selEnd: number;
  loading: boolean;
  error: string | null;
}

export const createInitialCodeBrowserState = (): CodeBrowserState => ({
  dirs: {},
  expanded: [],
  filePath: null,
  fileLines: [],
  fileHighlighted: null,
  fileTruncated: false,
  selStart: 0,
  selEnd: 0,
  loading: false,
  error: null,
});

export interface CapabilityMcpRow {
  name: string;
  attached: boolean;
  reason?: string;
  tools: string[];
  indexStatus?: string;
  /** Custom servers: 'config' (VAR_DIR/mcp.json) or 'worktree' (.mcp.json). */
  source?: 'config' | 'worktree';
}

/** Skills/MCP capabilities window (per-chat status). */
export interface CapsModalState {
  loading: boolean;
  error: string | null;
  /** Chat whose capabilities are shown. */
  chatId: string | null;
  skills: CapabilitySkillRow[];
  rules: Array<{ plugin: string }>;
  mcps: CapabilityMcpRow[];
}

/** Archive window (done chats; delete = chat + branch + data). */
export interface ArchiveState {
  loading: boolean;
  error: string | null;
  chats: ArchivedChatRow[];
  /** Chat id with a delete in flight. */
  busyId: string | null;
}

/** Element-edit mode — drag/draw/comment on the preview, hand off to agent. */
export interface ElementEditState {
  active: boolean;
  tool: EditTool;
  /** Latest full annotation set (cms:edit-changed) — the handoff payload.
   *  Kept in the parent so an iframe reload mid-edit restores it. */
  annotations: EditAnnotations | null;
  /** Handoff POST in flight. */
  busy: boolean;
}

export const createInitialElementEditState = (): ElementEditState => ({
  active: false,
  tool: 'cursor',
  annotations: null,
  busy: false,
});

export interface DiffState {
  /** Chat the pages were loaded for (guards stale loads). */
  forChatId: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  pages: DiffPage[];
  unresolved: string[];
  selectedRoute: string | null;
  /** Route-chip dropdown (changed pages) expanded. */
  routesOpen: boolean;
  /** Amber warn banner (files without a page route) expanded. */
  warnOpen: boolean;
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

  /** Active main-area window; null = the preview/diff stage. */
  window: WindowKind | null;

  /** Current route inside the preview iframe (cms:navigation). */
  previewRoute: string;
  /** Open preview tabs (routes); the active one mirrors previewRoute. */
  previewTabs: string[];
  /** Client-only stable ids parallel to previewTabs — they key the per-tab
   *  iframes, so reorders/closes never remount (= reload) other tabs. */
  previewTabIds: string[];
  activeTabIndex: number;
  /** Device preset the preview emulates (playwright registry key from
   *  workspace/devices.ts); null = responsive (fill the pane, real UA).
   *  A viewer preference — survives chat switches, like compareMode. */
  previewDevice: string | null;
  /** Element picker armed (waiting for a click inside the preview). */
  pickerActive: boolean;
  /** Element-edit mode (annotate the preview, then hand off to the agent). */
  elementEdit: ElementEditState;

  /** Approved plan (chat.planJson from history / captured on approval) —
   *  viewable in every phase, archived chats included. */
  plan: ProposedPlan | null;
  planModalOpen: boolean;

  /** Compare alignment for onion views + diff scroll sync: 'height'
   *  (natural heights / fraction scrolling) or 'content' (marker-aligned).
   *  A viewer preference — survives chat switches. */
  compareMode: 'height' | 'content';

  /** Code browser modal (read-only worktree view + line-range context). */
  codeBrowser: CodeBrowserState;

  /** Saved window sessions offered to a FRESH window on load (null = no
   *  offer pending). Not chat-scoped — survives switches. */
  windowPicker: Array<{ id: string; label: string; updatedAt: string }> | null;

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
  inputModal: { title: string; hint?: string; placeholder: string; allowEmpty?: boolean } | null;

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
  routesOpen: false,
  warnOpen: false,
  mode: 'side-by-side',
  overlayVisible: true,
  onionPercent: 50,
});

export const createInitialWorkspaceState = (): WorkspaceState => ({
  sidebarWidth: 420,
  sidebarCollapsed: false,
  branchListOpen: false,
  window: null,
  previewRoute: '/',
  previewTabs: ['/'],
  previewTabIds: [crypto.randomUUID()],
  activeTabIndex: 0,
  previewDevice: null,
  pickerActive: false,
  elementEdit: createInitialElementEditState(),
  plan: null,
  planModalOpen: false,
  // Height is the predictable default; content alignment remains opt-in and
  // is restored when an existing window session selected it explicitly.
  compareMode: 'height',
  codeBrowser: createInitialCodeBrowserState(),
  windowPicker: null,
  executionSha: null,
  executions: [],
  publish: null,
  contextChip: null,
  diff: createInitialDiffState(),
  browserCompare: createInitialBrowserCompareState(),
  archive: { loading: false, error: null, chats: [], busyId: null },
  git: createInitialGitModalState(),
  caps: createInitialCapsModalState(),
  automatism: null,
  inputModal: null,
  targetAhead: false,
});

export const createInitialCapsModalState = (): CapsModalState => ({
  loading: false,
  error: null,
  chatId: null,
  skills: [],
  rules: [],
  mcps: [],
});

export const createInitialGitModalState = (): GitModalState => ({
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
  a: 'chromium',
  b: 'firefox',
  mode: 'highlight',
  overlayVisible: true,
  onionPercent: 50,
  device: null,
});

/** Clears the chat-scoped parts of the workspace (call on chat switch). */
export const resetWorkspaceChatState = (ws: WorkspaceState): void => {
  ws.previewRoute = '/';
  ws.previewTabs = ['/'];
  ws.previewTabIds = [crypto.randomUUID()];
  ws.activeTabIndex = 0;
  ws.plan = null;
  ws.planModalOpen = false;
  ws.codeBrowser = createInitialCodeBrowserState();
  ws.executionSha = null;
  ws.executions = [];
  ws.publish = null;
  ws.contextChip = null;
  ws.diff = createInitialDiffState();
  ws.browserCompare = createInitialBrowserCompareState();
  // Chat-scoped windows close on switch; branch-level ones (git/caps/
  // archive/sessions) survive it, as before the window machine.
  if (ws.window === 'code' || ws.window === 'browsers') ws.window = null;
  ws.automatism = null;
  ws.targetAhead = false;
  ws.pickerActive = false;
  ws.elementEdit = createInitialElementEditState();
  ws.inputModal = null;
};
