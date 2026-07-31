/**
 * Initial injected-agent module — navigation beacon, text-selection
 * "Chat about this" button, and the element picker.
 *
 * Bundled by esbuild (src/lib/injected/bundle.ts) and served at
 * /injected-agent-module.js; the workspace fetches that file and pushes its
 * text into the preview iframe, where the engine evaluates the bundle and
 * calls this default export with the agent API (see protocol.ts). Imports are
 * fine here — the bundle is self-contained by construction.
 *
 * Re-loadable: everything attached is undone via agent.onTeardown, so pushing
 * a new module replaces this one cleanly.
 */
import type { AgentApi } from '../protocol';
import { initConfig } from './config';
import { createListen } from './dom';
import { initEditMode } from './editMode';
import { initNavigation } from './navigation';
import { initSelection } from './selection';
import { initPicker } from './picker';
import { initThemeSync } from './theme';

const STYLE =
  '.cms-ov-btn{position:absolute;z-index:2147483646;padding:4px 10px;border-radius:999px;' +
  'border:1px solid #7852ee;background:#1e1e1e;color:#eee;font:12px/1.4 system-ui,sans-serif;' +
  'cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap}' +
  '.cms-ov-btn:hover{background:#2a2a2a}' +
  '.cms-ov-btn.cms-ov-light{background:#fff;color:#222;box-shadow:0 4px 14px rgba(0,0,0,.18)}' +
  '.cms-ov-btn.cms-ov-light:hover{background:#f3f0ff}' +
  '.cms-ov-pick-help{position:fixed;z-index:2147483646;top:16px;left:50%;transform:translateX(-50%);' +
  'max-width:calc(100vw - 32px);padding:8px 14px;border-radius:999px;background:#1e1e1e;color:#fff;' +
  'font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4);pointer-events:none;' +
  'display:flex;align-items:center;gap:10px}' +
  '.cms-ov-pick-help__close{pointer-events:auto;border:0;background:transparent;color:inherit;' +
  'font:inherit;font-size:16px;line-height:1;cursor:pointer;padding:0 2px;opacity:.7}' +
  '.cms-ov-pick-help__close:hover{opacity:1}' +
  '.cms-ov-hl{position:fixed;z-index:2147483645;pointer-events:none;' +
  'outline:2px solid #7852ee;outline-offset:-1px;background:rgba(120,82,238,.12);border-radius:2px}' +
  '.cms-ov-edit-input{position:absolute;z-index:2147483646;padding:6px;border-radius:8px;' +
  'border:1px solid #e5484d;background:#1e1e1e;box-shadow:0 4px 14px rgba(0,0,0,.35)}' +
  '.cms-ov-edit-input.cms-ov-light{background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.18)}' +
  '.cms-ov-edit-input input{width:220px;border:0;outline:0;background:transparent;' +
  'color:#eee;font:13px/1.4 system-ui,sans-serif}' +
  '.cms-ov-edit-input.cms-ov-light input{color:#222}' +
  '.cms-ov-bubble{position:absolute;z-index:2147483646;max-width:280px;padding:6px 10px;' +
  'border-radius:8px;background:#1e1e1e;color:#eee;font:12px/1.5 system-ui,sans-serif;' +
  'box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none;white-space:pre-wrap}' +
  '.cms-ov-bubble.cms-ov-light{background:#fff;color:#222;box-shadow:0 4px 14px rgba(0,0,0,.18)}' +
  '.cms-ov-ring{position:absolute;z-index:2147483645;pointer-events:none;' +
  'border:2px solid #e5484d;border-radius:4px;box-shadow:0 0 0 2px rgba(255,255,255,.6)}' +
  '.cms-ov-ring--pin{border-radius:50%}' +
  '.cms-ov-bin{position:absolute;z-index:2147483646;width:26px;height:26px;padding:0;' +
  'border-radius:50%;border:1px solid #e5484d;background:#1e1e1e;font:13px/24px system-ui,sans-serif;' +
  'text-align:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)}' +
  '.cms-ov-bin:hover{background:#3a1d1f}' +
  '.cms-ov-edit{border-color:#7852ee;color:#eee}' +
  '.cms-ov-edit:hover{background:#2a2340}';

export default function cmsAgentModule(agent: AgentApi): void {
  const style = document.createElement('style');
  style.setAttribute('data-cms-overlay', '');
  style.textContent = STYLE;
  (document.head || document.documentElement).appendChild(style);
  agent.onTeardown(() => style.remove());

  initConfig(agent);
  initThemeSync(agent);
  const listen = createListen(agent);
  initNavigation(agent, listen);
  initSelection(agent, listen);
  initPicker(agent);
  initEditMode(agent, listen);
}
