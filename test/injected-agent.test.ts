/**
 * The injected agent ships as *serialized compiled source* (fn.toString(),
 * see src/pages/injected-cms-agent.js.ts / injected-agent-module.js.ts), so
 * both functions must stay self-contained: valid standalone JS with no
 * references to module scope. These tests catch a bundler transform (helper
 * hoisting, import rewriting) silently breaking that contract.
 */
import { describe, it, expect } from 'vitest';
import { cmsAgentBootstrap } from '@/injected/bootstrap';
import { cmsAgentModule } from '@/injected/agentModule';

describe('injected agent artifacts', () => {
  it('bootstrap serializes to parseable, import-free JS', () => {
    const src = `(${cmsAgentBootstrap.toString()})();`;
    expect(() => new Function(src)).not.toThrow(); // parse only, no execution
    expect(src).not.toMatch(/\brequire\s*\(|\bimport\s*[({]|\bfrom\s+["']/);
    expect(src).not.toContain('__vite');
  });

  it('module serializes to a function expression taking the agent api', () => {
    const src = `(${cmsAgentModule.toString()})`;
    const factory = new Function(`return ${src};`)() as unknown;
    expect(typeof factory).toBe('function');
    expect((factory as (agent: unknown) => void).length).toBe(1);
    expect(src).not.toMatch(/\brequire\s*\(|\bimport\s*[({]|\bfrom\s+["']/);
    expect(src).not.toContain('__vite');
  });
});
