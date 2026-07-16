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
import { createListen } from './dom';
import { initNavigation } from './navigation';
import { initSelection } from './selection';
import { initPicker } from './picker';

const STYLE =
  '.cms-ov-btn{position:absolute;z-index:2147483646;padding:4px 10px;border-radius:999px;' +
  'border:1px solid #7852ee;background:#1e1e1e;color:#eee;font:12px/1.4 system-ui,sans-serif;' +
  'cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap}' +
  '.cms-ov-btn:hover{background:#2a2a2a}' +
  '.cms-ov-hl{position:fixed;z-index:2147483645;pointer-events:none;' +
  'outline:2px solid #7852ee;outline-offset:-1px;background:rgba(120,82,238,.12);border-radius:2px}';

export default function cmsAgentModule(agent: AgentApi): void {
  const style = document.createElement('style');
  style.setAttribute('data-cms-overlay', '');
  style.textContent = STYLE;
  (document.head || document.documentElement).appendChild(style);
  agent.onTeardown(() => style.remove());

  const listen = createListen(agent);
  initNavigation(agent, listen);
  initSelection(agent, listen);
  initPicker(agent);
}
