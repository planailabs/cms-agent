/**
 * Custom MCP bridge integration: the bundled mcporter bridge runs in the
 * REAL bwrap jail, spawns a dependency-free stdio fixture server there, and
 * the attachment round-trips tool calls. Also proves the isolation point:
 * the fixture sees only the jail env, not the app's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { sandboxHomeDir } from '@/lib/sandbox';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'mcp-echo-server.mjs');

let custom: typeof import('@/lib/agent/mcp/custom');
let varDir: string;

beforeAll(async () => {
  varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-mcp-it-'));
  process.env.VAR_DIR = varDir;
  // A secret the fixture must NOT see from inside the jail.
  process.env.MCP_LEAK_CANARY = 'leaked-secret';
  resetEnvCache();
  custom = await import('@/lib/agent/mcp/custom');

  // Stage the fixture into the bridge session HOME (visible at /home/sandbox)
  fs.copyFileSync(FIXTURE, path.join(sandboxHomeDir('mcp-bridge'), 'echo-server.mjs'));
  fs.writeFileSync(
    path.join(varDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: { echo: { command: 'node', args: ['/home/sandbox/echo-server.mjs'] } },
    }),
  );
}, 60_000);

afterAll(async () => {
  // Empty VAR_DIR → the module closes the shared bridge (and its children).
  process.env.VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-mcp-it-off-'));
  resetEnvCache();
  await custom?.attachCustomMcps();
  delete process.env.MCP_LEAK_CANARY;
  // No rmSync of varDir: the sandbox squashfuse mount lives under it (EBUSY).
});

describe('custom MCP bridge (sandboxed)', () => {
  it('attaches jailed servers with prefixed tools and round-trips a call', async () => {
    const attachments = await custom.attachCustomMcps();
    expect(attachments).toHaveLength(1);
    const [bridge] = attachments;
    expect(bridge.toolNames).toEqual(new Set(['mcp_echo_echo', 'mcp_echo_env']));
    const echoTool = bridge.openAiTools.find((t) => t.function.name === 'mcp_echo_echo');
    expect(echoTool?.function.description).toContain('MCP server "echo"');
    expect(echoTool?.function.parameters).toHaveProperty('properties');
    expect(bridge.promptHint).toContain('echo');

    expect(await bridge.callTool('mcp_echo_echo', { text: 'hi' })).toBe('echo:hi');
  }, 120_000);

  it('runs the servers inside the jail — clean env, jail HOME', async () => {
    const [bridge] = await custom.attachCustomMcps();
    const envJson = JSON.parse(await bridge.callTool('mcp_echo_env', {})) as Record<
      string,
      string
    >;
    expect(envJson.HOME).toBe('/home/sandbox');
    expect(envJson.MCP_LEAK_CANARY).toBeUndefined();
    expect(envJson.DATABASE_URL).toBeUndefined();
  }, 60_000);

  it('reuses the bridge while the config is unchanged', async () => {
    const first = await custom.attachCustomMcps();
    const second = await custom.attachCustomMcps();
    expect(second[0]).toBe(first[0]);
  });
});
