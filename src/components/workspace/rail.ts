/**
 * Icon Rail (redesign) — vertical tool strip on the far left. Two stage
 * tools (suggest-changes edit mode, element picker) plus one button per
 * registered main-area window (workspace/window.ts) and settings. Window
 * buttons come straight from the registry — registering a window is all it
 * takes to appear here.
 */

import { escapeHtml } from '../chat/utils/html';
import { t, uiLocale } from '@/lib/i18n';
import type { AppState } from '../chat/app/state';
import { canEnterEditMode } from './preview';
import { registeredWindows } from './window';

const ICONS = {
  edit: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.2 2.3l2.5 2.5-8.2 8.2-3.2.7.7-3.2z"/><path d="M9.6 3.9l2.5 2.5"/></svg>`,
  pick: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"/></svg>`,
  settings: `<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.3"/><circle cx="8" cy="8" r="5.8"/><path d="M8 2.2v1.5M8 12.3v1.5M2.2 8h1.5M12.3 8h1.5"/></svg>`,
};

const EDIT_TOOLS = ['cursor', 'move', 'swap', 'draw', 'comment'] as const;

const railButton = (
  action: string,
  icon: string,
  tooltip: string,
  opts: { active?: boolean; disabled?: boolean } = {},
): string => `<button type="button"
    class="ws-rail__btn tooltip tooltip--right ${opts.active ? 'is-active' : ''}"
    data-action="${action}" data-tooltip="${escapeHtml(tooltip)}"
    aria-label="${escapeHtml(tooltip)}" ${opts.disabled ? 'disabled aria-disabled="true"' : ''}>${icon}</button>`;

const renderEditMenu = (state: AppState): string => {
  const locale = uiLocale();
  const items = EDIT_TOOLS.map(
    (tool) => `<button type="button" class="ws-edit-menu__item ${state.workspace.elementEdit.tool === tool ? 'is-active' : ''}"
      role="menuitem" data-action="ws-edit-tool" data-tool="${tool}">
      ${escapeHtml(t(locale, `workspace.preview.tool.${tool}`))}
    </button>`,
  ).join('');
  return `<div class="ws-edit-menu" role="menu">
      <div class="ws-edit-menu__head">${escapeHtml(t(locale, 'workspace.preview.editMode'))}</div>
      ${items}
      <button type="button" class="ws-edit-menu__item" role="menuitem" data-action="ws-edit-undo">${escapeHtml(t(locale, 'workspace.preview.editUndo'))}</button>
      <button type="button" class="ws-edit-menu__item" role="menuitem" data-action="ws-edit-clear">${escapeHtml(t(locale, 'workspace.preview.editClear'))}</button>
      <button type="button" class="ws-edit-menu__item" role="menuitem" data-action="ws-edit-exit">${escapeHtml(t(locale, 'workspace.preview.exitEdit'))}</button>
    </div>`;
};

export const renderRail = (state: AppState): string => {
  const locale = uiLocale();
  const ws = state.workspace;
  const editable = canEnterEditMode(state);
  const editing = ws.elementEdit.active;

  const windows = registeredWindows()
    .map((def) => {
      const btn = railButton(def.railAction, def.icon, t(locale, def.tooltipKey), {
        active: ws.window === def.kind,
        disabled: def.disabled?.(state) ?? false,
      });
      const menu = def.railMenu?.(state);
      // The wrapper is the hover target for the flyout — without it the menu
      // would close the moment the pointer left the 30px button.
      return menu ? `<span class="ws-rail__item">${btn}${menu}</span>` : btn;
    })
    .join('');

  const editButton = railButton(
      editing ? 'ws-edit-exit' : 'ws-edit-mode',
      ICONS.edit,
      t(locale, editing ? 'workspace.preview.exitEdit' : 'workspace.preview.editModeTitle'),
      { active: editing, disabled: !editable && !editing },
    );

  return `
    ${editing ? `<span class="ws-rail__item">${editButton}${renderEditMenu(state)}</span>` : editButton}
    ${railButton('ws-element-pick', ICONS.pick, t(locale, 'workspace.preview.pickTitle'), {
      active: ws.pickerActive,
      disabled: editing || !state.activeBranchId,
    })}
    <span class="ws-rail__sep" aria-hidden="true"></span>
    ${windows}
    <span class="ws-rail__spacer" aria-hidden="true"></span>
    ${railButton('settings-link', ICONS.settings, t(locale, 'workspace.rail.settings'))}`;
};
