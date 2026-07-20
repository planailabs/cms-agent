/**
 * Custom MCP servers (${VAR_DIR}/mcp.json via the mcporter runtime) — a real
 * stdio fixture server is spawned from test/fixtures; no network involved.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { attachCustomMcps } from '@/lib/agent/mcp/custom';

const FIXTURE = path.resolve(__dirname, 'fixtures/mcp-echo-server.mjs');

let varDir: string;

beforeAll(() => {
  varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-mcp-'));
  process.env.VAR_DIR = varDir;
  resetEnvCache();
  fs.writeFileSync(
    path.join(varDir, 'mcp.json'),
    JSON.stringify({
      mcpServers: { echo: { command: process.execPath, args: [FIXTURE] } },
    }),
  );
});

afterAll(async () => {
  // Point at an empty VAR_DIR so the module closes the shared runtime
  // (and the fixture child) instead of leaking it past the test file.
  process.env.VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-mcp-off-'));
  resetEnvCache();
  await attachCustomMcps();
  fs.rmSync(varDir, { recursive: true, force: true });
});

describe('custom MCP servers', () => {
  it('attaches configured stdio servers with prefixed tool names', async () => {
    const attachments = await attachCustomMcps();
    expect(attachments).toHaveLength(1);
    const [echo] = attachments;
    expect(echo.toolNames).toEqual(new Set(['mcp_echo_echo']));
    const [tool] = echo.openAiTools;
    expect(tool.function.name).toBe('mcp_echo_echo');
    expect(tool.function.description).toContain('MCP server "echo"');
    expect(tool.function.parameters).toHaveProperty('properties');
    expect(tool.function.parameters).not.toHaveProperty('$schema');
    expect(echo.promptHint).toContain('"echo" MCP server');
  }, 30_000);

  it('round-trips a tool call through the runtime', async () => {
    const [echo] = await attachCustomMcps();
    expect(await echo.callTool('mcp_echo_echo', { text: 'hi' })).toBe('echo:hi');
  }, 30_000);

  it('reuses the runtime while the config is unchanged', async () => {
    const first = await attachCustomMcps();
    const second = await attachCustomMcps();
    expect(second).toBe(first);
  });

  it('returns no attachments without a config file', async () => {
    const prev = process.env.VAR_DIR;
    process.env.VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-mcp-none-'));
    resetEnvCache();
    try {
      expect(await attachCustomMcps()).toEqual([]);
    } finally {
      process.env.VAR_DIR = prev;
      resetEnvCache();
    }
  });
});
