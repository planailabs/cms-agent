/**
 * Metrics: the exposition, the ephemeral listener, and its token gate.
 *
 * The instruments themselves are recorded from a dozen call sites; what is
 * worth pinning down here is the contract everything else depends on — that a
 * recorded value reaches a Prometheus scrape under the name an alert rule
 * would be written against, that the listener publishes a port for the proxy
 * to route /metrics to, and that the token is enforced when one is set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';

const g = globalThis as typeof globalThis & {
  __cmsMetrics?: unknown;
  __cmsMetricsServer?: { close(): void };
};

/** A fresh module graph per test: the meter provider and the listener are
 *  process singletons on globalThis, which is the point of them. */
async function freshMetrics() {
  g.__cmsMetricsServer?.close();
  delete g.__cmsMetricsServer;
  delete g.__cmsMetrics;
  resetEnvCache();
  vi.resetModules();
  return import('@/lib/metrics');
}

const port = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('metrics exposition', () => {
  beforeEach(() => {
    delete process.env.METRICS_TOKEN;
    delete process.env.METRICS_ENABLED;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    g.__cmsMetricsServer?.close();
    delete g.__cmsMetricsServer;
    delete g.__cmsMetrics;
    resetEnvCache();
  });

  it('renders recorded instruments under their Prometheus names', async () => {
    const m = await freshMetrics();
    m.recordTurn('ok', 12);
    m.recordTurn('stopped', 3);
    m.recordPreviewStart('deps', 'error', 41);
    m.recordDeploy('git-push', 'ok', 90);
    m.recordToolCall('write_file', 'ok', 0.02);
    m.recordScreenshot('shot', 'ok', 1.5);
    m.recordHttpRequest('/api/chat/message', 202, 0.03);
    m.countTokens('gpt-test', 1200, 340);

    const text = await m.metricsText();

    expect(text).toContain('cms_turn_duration_seconds_count{outcome="ok"} 1');
    expect(text).toContain('cms_turn_duration_seconds_count{outcome="stopped"} 1');
    expect(text).toContain('cms_preview_start_duration_seconds_sum{phase="deps",outcome="error"} 41');
    expect(text).toContain('cms_deploy_duration_seconds_sum{flow="git-push",outcome="ok"} 90');
    expect(text).toContain('cms_toolcall_duration_seconds_count{tool="write_file",outcome="ok"} 1');
    expect(text).toContain('cms_screenshot_duration_seconds_count{kind="shot",outcome="ok"} 1');
    expect(text).toContain('cms_http_server_duration_seconds_count{route="/api/chat/message",status="202"} 1');
    expect(text).toContain('cms_tokens_total{model="gpt-test",kind="input"} 1200');
    expect(text).toContain('cms_tokens_total{model="gpt-test",kind="output"} 340');
  });

  it('buckets slow work in minutes and fast work in milliseconds', async () => {
    const m = await freshMetrics();
    // 90s is over every fast boundary but well inside the slow ones: if the
    // views ever stop applying, a deploy lands in +Inf and the histogram
    // stops being able to tell 2 minutes from 20.
    m.recordDeploy('git-push', 'ok', 90);
    m.recordToolCall('lint', 'ok', 0.3);
    const text = await m.metricsText();

    expect(text).toContain('cms_deploy_duration_seconds_bucket{flow="git-push",outcome="ok",le="120"} 1');
    expect(text).toContain('cms_deploy_duration_seconds_bucket{flow="git-push",outcome="ok",le="60"} 0');
    expect(text).toContain('cms_toolcall_duration_seconds_bucket{tool="lint",outcome="ok",le="0.5"} 1');
  });

  it('reads gauges at scrape time, not at registration time', async () => {
    const m = await freshMetrics();
    let running = 0;
    m.registerGauge('cms.test.instances', 'Test gauge', () => running);

    running = 3;
    expect(await m.metricsText()).toContain('cms_test_instances 3');
    running = 0;
    expect(await m.metricsText()).toContain('cms_test_instances 0');
  });

  it('re-registering a gauge replaces its reader instead of doubling it', async () => {
    const m = await freshMetrics();
    m.registerGauge('cms.test.streams', 'Test gauge', () => 1);
    m.registerGauge('cms.test.streams', 'Test gauge', () => 7);

    const lines = (await m.metricsText())
      .split('\n')
      .filter((l) => l.startsWith('cms_test_streams '));
    expect(lines).toEqual(['cms_test_streams 7']);
  });
});

describe('metrics listener', () => {
  beforeEach(() => {
    delete process.env.METRICS_TOKEN;
    delete process.env.METRICS_ENABLED;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    g.__cmsMetricsServer?.close();
    delete g.__cmsMetricsServer;
    delete g.__cmsMetrics;
    delete process.env.METRICS_TOKEN;
    delete process.env.NODE_ENV;
    resetEnvCache();
  });

  it('binds an ephemeral port and reports it for the routes table', async () => {
    const m = await freshMetrics();
    expect(m.metricsPort()).toBeNull();

    const listening = new Promise<void>((resolve) => m.startMetricsServer(resolve));
    await listening;

    const bound = m.metricsPort();
    expect(bound).toBeTypeOf('number');
    // Ephemeral: never the documented Prometheus default, never fixed.
    expect(bound).not.toBe(9464);
    expect(bound).toBeGreaterThan(1024);
  });

  it('serves the exposition and 404s anything else', async () => {
    const m = await freshMetrics();
    m.recordTurn('ok', 1);
    await new Promise<void>((resolve) => m.startMetricsServer(resolve));

    const base = `http://127.0.0.1:${m.metricsPort()}`;
    const ok = await fetch(`${base}/metrics`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('cms_turn_duration_seconds_count');

    expect((await fetch(`${base}/`)).status).toBe(404);
  });

  it('requires the bearer token once METRICS_TOKEN is set', async () => {
    process.env.METRICS_TOKEN = 'a-sixteen-plus-character-token';
    const m = await freshMetrics();
    await new Promise<void>((resolve) => m.startMetricsServer(resolve));
    const url = `http://127.0.0.1:${m.metricsPort()}/metrics`;

    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await fetch(url, {
      headers: { authorization: 'Bearer a-sixteen-plus-character-token' },
    });
    expect(ok.status).toBe(200);
  });

  it('refuses to start in production without a token', async () => {
    process.env.NODE_ENV = 'production';
    const m = await freshMetrics();
    expect(() => m.startMetricsServer(() => {})).toThrow(/METRICS_TOKEN is required/);
    expect(m.metricsPort()).toBeNull();
  });

  it('publishes its port in the routes table the proxy reads', async () => {
    const m = await freshMetrics();
    const { currentRoutesJson } = await import('@/lib/preview/manager');

    // Before it listens the key is absent — the proxy 404s /metrics rather
    // than sending it to the CMS upstream.
    expect(JSON.parse(currentRoutesJson()).metrics).toBeUndefined();

    await new Promise<void>((resolve) => m.startMetricsServer(resolve));
    const routes = JSON.parse(currentRoutesJson()) as { metrics?: string };
    expect(routes.metrics).toBe(`127.0.0.1:${m.metricsPort()}`);
  });

  it('does not start at all when disabled', async () => {
    process.env.METRICS_ENABLED = 'false';
    const m = await freshMetrics();
    m.startMetricsServer(() => {
      throw new Error('must not listen');
    });
    await port();
    expect(m.metricsPort()).toBeNull();
  });
});
