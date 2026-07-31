/**
 * Project-mode PostgreSQL lifecycle: what DATABASE_URL is allowed to describe.
 *
 * The lifecycle itself is exercised by running it (see docs/setup.md); what is
 * worth pinning here is the derivation, because a misread URL would either
 * start a cluster nobody asked for or hand `pg_ctl` a shell string with a path
 * in it.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clusterConfig, serverOptions } from '../scripts/local-postgres.mjs';

const config = (url: string, dataDir = '/repo/var/postgres') => clusterConfig(url, dataDir);

describe('clusterConfig', () => {
  it('reads host, port, credentials and database out of the URL', () => {
    const cfg = config('postgresql://cms:secret@localhost:5433/cms_agent');
    expect(cfg).toMatchObject({
      host: 'localhost',
      port: 5433,
      user: 'cms',
      password: 'secret',
      database: 'cms_agent',
      socketDir: '/repo/var/postgres',
    });
  });

  it('defaults the port and the user the way libpq does', () => {
    const cfg = config('postgres://127.0.0.1/cms_agent');
    expect(cfg.port).toBe(5432);
    expect(cfg.user).toBe(os.userInfo().username);
    expect(cfg.password).toBe('');
  });

  it('decodes percent-escaped credentials', () => {
    expect(config('postgresql://c%40ms:p%2Fw@localhost/db')).toMatchObject({
      user: 'c@ms',
      password: 'p/w',
    });
  });

  it('takes ?host= as a socket directory and stops listening on TCP', () => {
    const cfg = clusterConfig('postgresql://cms@localhost/cms_agent?host=./var/run', '/repo/var/postgres');
    expect(cfg.host).toBeNull();
    expect(cfg.socketDir).toBe(path.resolve(process.cwd(), 'var/run'));
  });

  it('refuses a URL that points off this machine', () => {
    expect(() => config('postgresql://cms@db.example.com/cms_agent')).toThrow(/only manages a cluster/);
  });

  it('refuses a URL that is not PostgreSQL, or names no database', () => {
    expect(() => config('mysql://cms@localhost/cms_agent')).toThrow(/not a PostgreSQL URL/);
    expect(() => config('postgresql://cms@localhost')).toThrow(/no database/);
  });

  it('refuses a socket directory the kernel could not fit in sockaddr_un', () => {
    expect(() => config('postgresql://cms@localhost/db', '/' + 'x'.repeat(95))).toThrow(/too long/);
  });
});

describe('serverOptions', () => {
  it('quotes the paths it hands to the shell pg_ctl runs', () => {
    const opts = serverOptions(config("postgresql://cms@localhost:5433/db", "/repo/it's here/pg"));
    expect(opts).toBe(`-p 5433 -k '/repo/it'\\''s here/pg' -c listen_addresses='localhost'`);
  });

  it('leaves listen_addresses empty for a socket-only cluster', () => {
    const cfg = clusterConfig('postgresql://cms@localhost/db?host=./var/run', '/repo/var/postgres');
    expect(serverOptions(cfg)).toContain(`-c listen_addresses=''`);
  });

  it('strips the brackets IPv6 keeps in a URL', () => {
    expect(serverOptions(config('postgresql://cms@[::1]:5432/db'))).toContain(`listen_addresses='::1'`);
  });
});
