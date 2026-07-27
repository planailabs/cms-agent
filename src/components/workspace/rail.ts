/**
 * Icon Rail (redesign) — vertical tool strip on the far left. Every button
 * reuses an existing delegated action, so this is layout only: suggest
 * changes (edit mode), element picker, cross-browser compare, code browser,
 * git history, and settings.
 */

import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';
import { canEnterEditMode } from './preview';

const ICONS = {
  edit: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.2 2.3l2.5 2.5-8.2 8.2-3.2.7.7-3.2z"/><path d="M9.6 3.9l2.5 2.5"/></svg>`,
  pick: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"/></svg>`,
  browsers: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="M1.8 6h12.4"/><circle cx="4.2" cy="4.4" r="0.45" fill="currentColor" stroke="none"/></svg>`,
  code: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.8 4.2L2.4 8l3.4 3.8M10.2 4.2L13.6 8l-3.4 3.8"/></svg>`,
  git: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/></svg>`,
  settings: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.3"/><circle cx="8" cy="8" r="5.8"/><path d="M8 2.2v1.5M8 12.3v1.5M2.2 8h1.5M12.3 8h1.5"/></svg>`,
};

const railButton = (
  action: string,
  icon: string,
  tooltip: string,
  opts: { active?: boolean; disabled?: boolean } = {},
): string => `<button type="button"
    class="ws-rail__btn tooltip tooltip--right ${opts.active ? 'is-active' : ''}"
    data-action="${action}" data-tooltip="${escapeHtml(tooltip)}"
    aria-label="${escapeHtml(tooltip)}" ${opts.disabled ? 'disabled aria-disabled="true"' : ''}>${icon}</button>`;

export const renderRail = (state: AppState): string => {
  const locale = uiLocale();
  const ws = state.workspace;
  const editable = canEnterEditMode(state);
  const editing = ws.elementEdit.active;

  return `
    ${railButton(
      editing ? 'ws-edit-exit' : 'ws-edit-mode',
      ICONS.edit,
      t(locale, editing ? 'workspace.preview.exitEdit' : 'workspace.preview.editModeTitle'),
      { active: editing, disabled: !editable && !editing },
    )}
    ${railButton('ws-element-pick', ICONS.pick, t(locale, 'workspace.preview.pickTitle'), {
      active: ws.pickerActive,
      disabled: editing || !state.activeChatId,
    })}
    ${railButton('ws-bc-open', ICONS.browsers, t(locale, 'workspace.preview.browsersTitle'), {
      active: ws.browserCompare.open,
    })}
    ${railButton('ws-cb-modal-open', ICONS.code, t(locale, 'workspace.code.openTitle'), {
      active: ws.codeBrowser.open,
    })}
    <span class="ws-rail__sep" aria-hidden="true"></span>
    ${railButton('ws-git-open', ICONS.git, t(locale, 'workspace.sidebar.gitTitle'), {
      active: ws.git.open,
    })}
    <span class="ws-rail__spacer" aria-hidden="true"></span>
    ${railButton('settings-link', ICONS.settings, t(locale, 'workspace.rail.settings'))}`;
};
