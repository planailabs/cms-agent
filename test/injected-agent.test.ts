/**
 * The injected agent ships as esbuild bundles served by prerendered endpoints
 * (see src/lib/injected/bundle.ts). These tests build both entries exactly
 * like the endpoints do and check the contracts the engine relies on: the
 * bootstrap parses standalone, and evaluating the module bundle in a function
 * scope (as the engine's cms:load-module does) yields the factory.
 */
import { describe, it, expect } from 'vitest';
import {
  ANNOTATE_GLOBAL,
  annotateRuntimeSource,
  bundleInjected,
  MODULE_GLOBAL,
} from '@/lib/injected/bundle';

describe('injected agent bundles', () => {
  it('bootstrap bundles to parseable standalone JS', async () => {
    const src = await bundleInjected('bootstrap');
    expect(() => new Function(src)).not.toThrow(); // parse only, no execution
    expect(src).toContain('cms:agent-ready');
  });

  it('module bundle exposes the default-export factory via the global name', async () => {
    const src = await bundleInjected('module');
    // Mirror the engine's evaluation: function scope, extract the global
    const exported = new Function(
      `"use strict";${src}
      return typeof ${MODULE_GLOBAL} !== "undefined" ? ${MODULE_GLOBAL} : undefined;`,
    )() as { default?: unknown } | undefined;
    const factory = typeof exported === 'function' ? exported : exported?.default;
    expect(typeof factory).toBe('function');
    expect((factory as (agent: unknown) => void).length).toBe(1);
  });

  it('annotate bundle exposes apply() via its global name', async () => {
    // The runtime accessor (dev path = esbuild; prod falls back to the
    // prerendered dist/client file) must serve the same bundle.
    expect(await annotateRuntimeSource()).toBe(await bundleInjected('annotate'));
    const src = await bundleInjected('annotate');
    const exported = new Function(
      `"use strict";${src}
      return typeof ${ANNOTATE_GLOBAL} !== "undefined" ? ${ANNOTATE_GLOBAL} : undefined;`,
    )() as { apply?: unknown } | undefined;
    expect(typeof exported?.apply).toBe('function');
  });
});
