import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('production server entry', () => {
  it('refuses to start without the native proxy', () => {
    const env = { ...process.env };
    delete env.PROXY_NATIVE_PATH;
    const result = spawnSync(process.execPath, [path.resolve('server.mjs')], {
      env,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PROXY_NATIVE_PATH is required');
  });
});
