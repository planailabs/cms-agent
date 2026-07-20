/**
 * Custom MCP servers — sandbox-free paths only (the live bridge round-trip
 * needs the jail: see test/integration/custom-mcp.test.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { attachCustomMcps } from '@/lib/agent/mcp/custom';

const prevVarDir = process.env.VAR_DIR;

afterAll(() => {
  process.env.VAR_DIR = prevVarDir;
  resetEnvCache();
});

describe('custom MCP servers (unit)', () => {
  it('returns no attachments without a config file', async () => {
    process.env.VAR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-mcp-none-'));
    resetEnvCache();
    expect(await attachCustomMcps()).toEqual([]);
  });
});
