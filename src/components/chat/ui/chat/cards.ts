/**
 * Workflow Cards — plan approval, execution-finished, execution-committed,
 * publish progress, and the context chip. Rendered inside the chat section.
 */

import { escapeHtml } from '../../utils/html';
import type { AppState, ChatState } from '../../app/state';

type AiChat = NonNullable<ChatState['aiChat']>;

// ── Plan approval card (question: propose_plan) ─────────────────────────

interface ProposePlanInput {
  summary?: string;
  steps?: string[];
  files?: Array<{ path: string; action: string; reason: string }>;
  pages?: Array<{ url: string; expectedEffect: string }>;
  risk?: string;
  questions?: string[];
}

const RISK_CLASSES: Record<string, string> = {
  content: 'ws-badge--ok',
  template: 'ws-badge--warn',
  code: 'ws-badge--warn',
  dependency: 'ws-badge--danger',
};

const renderPlanApprovalCard = (mc: AiChat): string => {
  if (mc.phase !== 'question' || mc.clientPrompt?.toolName !== 'propose_plan') return '';
  const input = mc.clientPrompt.input as ProposePlanInput;

  const steps = (input.steps ?? [])
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join('');
  const files = (input.files ?? [])
    .map(
      (f) => `<tr>
        <td class="ws-mono">${escapeHtml(f.path)}</td>
        <td><span class="ws-badge">${escapeHtml(f.action)}</span></td>
        <td>${escapeHtml(f.reason)}</td>
      </tr>`,
    )
    .join('');
  const pages = (input.pages ?? [])
    .map((p) => `<li><span class="ws-mono">${escapeHtml(p.url)}</span> — ${escapeHtml(p.expectedEffect)}</li>`)
    .join('');
  const questions = (input.questions ?? [])
    .map((q) => `<li>${escapeHtml(q)}</li>`)
    .join('');
  const risk = input.risk ?? 'content';

  return `<div class="ws-card" data-card="plan-approval">
      <div class="ws-card__header">
        <span class="ws-card__title">Proposed plan</span>
        <span class="ws-badge ${RISK_CLASSES[risk] ?? ''}">risk: ${escapeHtml(risk)}</span>
      </div>
      ${input.summary ? `<p class="ws-card__summary">${escapeHtml(input.summary)}</p>` : ''}
      ${steps ? `<div class="ws-card__section"><span class="ws-card__label">Steps</span><ol class="ws-card__list ws-card__list--ordered">${steps}</ol></div>` : ''}
      ${files ? `<div class="ws-card__section"><span class="ws-card__label">Files</span>
        <table class="ws-table"><thead><tr><th>Path</th><th>Action</th><th>Reason</th></tr></thead><tbody>${files}</tbody></table></div>` : ''}
      ${pages ? `<div class="ws-card__section"><span class="ws-card__label">Pages</span><ul class="ws-card__list">${pages}</ul></div>` : ''}
      ${questions ? `<div class="ws-card__section"><span class="ws-card__label">Open questions</span><ul class="ws-card__list">${questions}</ul></div>` : ''}
      <div class="ws-card__actions">
        <button type="button" class="chat-cta-button ws-cta--primary" data-action="ws-approve-plan">Approve plan</button>
        <button type="button" class="chat-cta-button" data-action="ws-request-changes">Request changes</button>
      </div>
    </div>`;
};

// ── Execution-finished card (question: finish_execution) ────────────────

const renderExecutionFinishedCard = (mc: AiChat): string => {
  if (mc.phase !== 'question' || mc.clientPrompt?.toolName !== 'finish_execution') return '';
  if (mc.clientPrompt.dismissed) return '';
  const input = mc.clientPrompt.input as { summary?: string };

  return `<div class="ws-card" data-card="execution-finished">
      <div class="ws-card__header">
        <span class="ws-card__title">Implementation finished</span>
      </div>
      ${input.summary ? `<p class="ws-card__summary">${escapeHtml(input.summary)}</p>` : ''}
      <div class="ws-card__actions">
        <button type="button" class="chat-cta-button ws-cta--primary" data-action="ws-create-preview">Create preview</button>
        <button type="button" class="chat-cta-button chat-cta-button--cancel" data-action="ws-dismiss-finish">Not yet — keep chatting</button>
      </div>
    </div>`;
};

// ── Execution-committed card (rendered INLINE in the transcript by
// bubbles.ts at its chronological position) ─────────────────────────────

export const renderExecutionCard = (exec: import('../../../workspace/state').ExecutionCard): string => {
  const shortSha = escapeHtml(exec.sha.slice(0, 8));
  if (exec.reverted) {
    return `<div class="ws-card ws-card--muted" data-card="execution">
        <div class="ws-card__header">
          <span class="ws-card__title"><span class="ws-mono">${shortSha}</span> reverted</span>
        </div>
        <p class="ws-card__summary">${escapeHtml(exec.summary)}</p>
        <p class="ws-card__note">Undone by ${escapeHtml(exec.reverted.by)} (revert <span class="ws-mono">${escapeHtml(exec.reverted.revertSha.slice(0, 8))}</span>)</p>
      </div>`;
  }
  return `<div class="ws-card" data-card="execution">
      <div class="ws-card__header">
        <span class="ws-card__title">Committed <span class="ws-mono">${shortSha}</span></span>
      </div>
      <p class="ws-card__summary">${escapeHtml(exec.summary)}</p>
      <div class="ws-card__actions">
        <button type="button" class="chat-cta-button" data-action="ws-undo-execution"
          data-sha="${escapeHtml(exec.sha)}" ${exec.busy ? 'disabled' : ''}>
          ${exec.busy ? 'Undoing…' : 'Undo'}
        </button>
      </div>
    </div>`;
};

// ── Publish progress card (publish_log / publish_done) ──────────────────

const renderPublishCard = (state: AppState): string => {
  const pub = state.workspace.publish;
  if (!pub) return '';

  const lines = pub.lines.map((l) => escapeHtml(l)).join('\n');
  const log = lines ? `<pre class="ws-publish-log">${lines}</pre>` : '';

  if (pub.status === 'running') {
    return `<div class="ws-card" data-card="publish">
        <div class="ws-card__header">
          <span class="ws-card__title"><span class="ws-spinner"></span> Publishing <span class="ws-mono">${escapeHtml(pub.sha.slice(0, 8))}</span>…</span>
        </div>
        ${log}
      </div>`;
  }

  if (pub.status === 'succeeded') {
    const link = pub.externalUrl
      ? `<p class="ws-card__note"><a href="${escapeHtml(pub.externalUrl)}" target="_blank" rel="noopener">View deployment ↗</a></p>`
      : '';
    return `<div class="ws-card" data-card="publish">
        <div class="ws-card__header">
          <span class="ws-card__title">Published <span class="ws-mono">${escapeHtml(pub.sha.slice(0, 8))}</span> ✓</span>
        </div>
        ${log}
        ${link}
      </div>`;
  }

  return `<div class="ws-card ws-card--danger" data-card="publish">
      <div class="ws-card__header">
        <span class="ws-card__title">Publish failed</span>
      </div>
      ${pub.error ? `<p class="ws-card__note ws-card__note--danger">${escapeHtml(pub.error)}</p>` : ''}
      ${log}
      <div class="ws-card__actions">
        <button type="button" class="chat-cta-button" data-action="ws-retry-publish">Retry</button>
      </div>
    </div>`;
};

// ── Context chip (selection/element from the preview overlay) ────────────

export const renderContextChip = (state: AppState): string => {
  const ws = state.workspace;
  const chip = ws.contextChip;
  if (!chip) return '';

  let label: string;
  if (chip.kind === 'selection' && chip.context.selection) {
    const exact = chip.context.selection.exact;
    label = `“${exact.length > 60 ? `${exact.slice(0, 60)}…` : exact}”`;
  } else if (chip.context.element) {
    const el = chip.context.element;
    label = `<${el.tag}${el.id ? `#${el.id}` : ''}>`;
  } else {
    label = chip.context.route ?? chip.context.url;
  }

  return `<div class="ws-chip-row">
      <span class="ws-chip" title="${escapeHtml(chip.context.route ?? chip.context.url)}">
        <span class="ws-chip__kind">${chip.kind === 'selection' ? '❝' : '⌖'}</span>
        <span class="ws-chip__label">${escapeHtml(label)}</span>
        <button type="button" class="ws-chip__remove" data-action="ws-chip-remove" aria-label="Remove context">×</button>
      </span>
    </div>`;
};

// ── Combined export ──────────────────────────────────────────────────────

export const renderWorkflowCards = (state: AppState): string => {
  const mc = state.chat?.aiChat;
  if (!mc) return '';
  return [
    renderPublishCard(state),
    renderPlanApprovalCard(mc),
    renderExecutionFinishedCard(mc),
  ].join('');
};
