/**
 * Metrics — OpenTelemetry instruments, scraped in Prometheus text format.
 *
 * One exposition serves BOTH halves of the process: the OTel meter provider
 * below and the embedded Rust proxy's own registry, concatenated — they are
 * one process, so making operators scrape two targets for it would be an
 * implementation detail leaking into their config.
 *
 * It is served by a small listener of its own on an EPHEMERAL port, which
 * the proxy routes `/metrics` to on the CMS host. So a scrape arrives through
 * the same front door as every other route — same address, same TLS — while
 * the listener itself stays on loopback behind an unguessable port. It
 * carries no build version or commit: that is authed-only elsewhere and must
 * not leak in through a label.
 *
 * What each instrument is for is documented where it is recorded; this module
 * only owns names, units and buckets.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Counter, Histogram, ObservableGauge } from '@opentelemetry/api';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { AggregationType, MeterProvider, type ViewOptions } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { env } from '@/lib/env';

/**
 * Prometheus renders an instrument named `a.b.c` as `a_b_c`, and appends
 * `_total` to counters — but never a unit suffix. So the seconds live in the
 * name: `cms.turn.duration.seconds` scrapes as `cms_turn_duration_seconds`,
 * which is what an alert rule expects to find.
 */
const SECONDS = 's';

/** Sub-second work that occasionally hangs: HTTP, tool calls, screenshots. */
const FAST_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
/** Work measured in minutes: turns, preview boots, deploys. */
const SLOW_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600];

/** Named one by one, not by wildcard: two views matching the same instrument
 *  is a stream conflict, and the one that wins is not the one you meant. */
const bucketViews = (boundaries: number[], instruments: string[]): ViewOptions[] =>
  instruments.map((instrumentName) => ({
    instrumentName,
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries },
    },
  }));

const VIEWS: ViewOptions[] = [
  ...bucketViews(FAST_BUCKETS, [
    'cms.http.server.duration.seconds',
    'cms.toolcall.duration.seconds',
    'cms.screenshot.duration.seconds',
  ]),
  ...bucketViews(SLOW_BUCKETS, [
    'cms.turn.duration.seconds',
    'cms.preview.start.duration.seconds',
    'cms.deploy.duration.seconds',
  ]),
];

/**
 * Positional args, in the order the class takes them:
 * (prefix, appendTimestamp, withResourceConstantLabels, withoutTargetInfo,
 * withoutScopeInfo). Only the last matters here — without it every series
 * carries otel_scope_name="cms-agent", which is noise in a process with one
 * meter and makes every query longer to write.
 */
const SERIALIZER = new PrometheusSerializer(undefined, false, undefined, false, true);

interface MetricsState {
  provider: MeterProvider;
  reader: PrometheusExporter;
  histograms: Map<string, Histogram>;
  counters: Map<string, Counter>;
  gauges: Map<string, { gauge: ObservableGauge; callback: (result: { observe: (value: number) => void }) => void }>;
}

// globalThis-backed for the same reason the preview manager and the SSE bus
// are: a Vite HMR reload would otherwise leave the live gauges registered on
// a provider nothing scrapes.
const g = globalThis as typeof globalThis & { __cmsMetrics?: MetricsState };

function metrics(): MetricsState {
  if (g.__cmsMetrics) return g.__cmsMetrics;
  // preventServerStart: this module serves the exposition itself (see above),
  // so the exporter is used purely as the reader half.
  const reader = new PrometheusExporter({ preventServerStart: true });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'cms-agent' }),
    views: VIEWS,
    readers: [reader],
  });
  return (g.__cmsMetrics = {
    provider,
    reader,
    histograms: new Map(),
    counters: new Map(),
    gauges: new Map(),
  });
}

const meter = () => metrics().provider.getMeter('cms-agent');

function histogram(name: string, description: string): Histogram {
  const state = metrics();
  let h = state.histograms.get(name);
  if (!h) {
    h = meter().createHistogram(name, { description, unit: SECONDS });
    state.histograms.set(name, h);
  }
  return h;
}

function counter(name: string, description: string, unit?: string): Counter {
  const state = metrics();
  let c = state.counters.get(name);
  if (!c) {
    c = meter().createCounter(name, { description, ...(unit ? { unit } : {}) });
    state.counters.set(name, c);
  }
  return c;
}

/**
 * Start a stopwatch. Returns elapsed SECONDS, which is the unit every
 * duration instrument here is declared in — a caller that passes
 * milliseconds by accident lands in the last bucket and looks like a hang.
 */
export function startTimer(): () => number {
  const started = performance.now();
  return () => (performance.now() - started) / 1000;
}

/**
 * A value the metrics endpoint reads at scrape time instead of one that is
 * added to as it changes: sizes of live maps (running previews, open SSE
 * streams, queue depth) are always correct this way, where increment/
 * decrement pairs drift the moment one path forgets to decrement.
 *
 * Re-registering the same name replaces the reader (HMR).
 */
export function registerGauge(name: string, description: string, read: () => number): void {
  const state = metrics();
  const existing = state.gauges.get(name);
  if (existing) existing.gauge.removeCallback(existing.callback);
  const gauge = existing?.gauge ?? meter().createObservableGauge(name, { description });
  const callback = (result: { observe: (value: number) => void }) => result.observe(read());
  gauge.addCallback(callback);
  state.gauges.set(name, { gauge, callback });
}

/** One agent turn, end to end (lib/agent/handler). */
export function recordTurn(outcome: 'ok' | 'error' | 'stopped', seconds: number): void {
  histogram('cms.turn.duration.seconds', 'Agent turn duration').record(seconds, { outcome });
}

/** One phase of a preview start: dependency install, then dev-server boot. */
export function recordPreviewStart(
  phase: 'deps' | 'server',
  outcome: 'ok' | 'error',
  seconds: number,
): void {
  histogram('cms.preview.start.duration.seconds', 'Preview start duration, per phase').record(
    seconds,
    { phase, outcome },
  );
}

/** One publication, from the row being created to succeeded/failed. */
export function recordDeploy(flow: string, outcome: 'ok' | 'error', seconds: number): void {
  histogram('cms.deploy.duration.seconds', 'Deploy duration, per flow').record(seconds, {
    flow,
    outcome,
  });
}

/** One MCP/built-in tool call (lib/agent/mcp). */
export function recordToolCall(tool: string, outcome: 'ok' | 'error', seconds: number): void {
  histogram('cms.toolcall.duration.seconds', 'Agent tool call duration').record(seconds, {
    tool,
    outcome,
  });
}

/** One playwright capture (lib/diff/screenshot). */
export function recordScreenshot(kind: string, outcome: 'ok' | 'error', seconds: number): void {
  histogram('cms.screenshot.duration.seconds', 'Browser capture duration').record(seconds, {
    kind,
    outcome,
  });
}

/** One handled request, labelled by ROUTE PATTERN — never the raw path,
 *  which carries chat and branch ids and would be unbounded. */
export function recordHttpRequest(route: string, status: number, seconds: number): void {
  histogram('cms.http.server.duration.seconds', 'HTTP request duration').record(seconds, {
    route,
    status,
  });
}

/**
 * Model tokens, per model and direction. TokenUsage rows remain the billing
 * record — this counter exists so a runaway turn can be alerted on live,
 * without a query.
 */
export function countTokens(model: string, input: number, output: number): void {
  const c = counter('cms.tokens', 'Model tokens by model and direction', '{token}');
  if (input > 0) c.add(input, { model, kind: 'input' });
  if (output > 0) c.add(output, { model, kind: 'output' });
}

/**
 * The whole exposition: OTel instruments plus the embedded proxy's registry.
 *
 * proxyNative is imported lazily so this module stays free of the database
 * (proxyNative reads sessions) — a test that scrapes metrics should not need
 * a Prisma client.
 */
export async function metricsText(): Promise<string> {
  const { reader } = metrics();
  const { resourceMetrics, errors } = await reader.collect();
  if (errors.length > 0) console.warn('[metrics] collection errors:', ...errors);
  const own = SERIALIZER.serialize(resourceMetrics);
  let proxy = '';
  try {
    const { proxyMetricsText } = await import('@/lib/proxyNative');
    proxy = proxyMetricsText();
  } catch (err) {
    // The proxy addon is absent in tests and in `astro dev` without it —
    // serving the half we do have beats serving a 500.
    console.warn('[metrics] proxy metrics unavailable:', err);
  }
  return proxy ? `${own}\n${proxy}` : own;
}

/**
 * May this scrape read the exposition?
 *
 * With no METRICS_TOKEN set, yes — nothing should have to be configured to
 * get metrics on a development machine, which is how they end up not existing
 * when they are finally needed. Production is the other way round: the CMS
 * host is reachable from outside there, so a token is REQUIRED and the
 * listener refuses to start without one (see startMetricsServer).
 */
export function metricsAuthorized(authorization: string | undefined): boolean {
  const token = env().METRICS_TOKEN;
  if (!token) return true;
  const offered = (authorization ?? '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(offered);
  const right = Buffer.from(token);
  // Length is compared first because timingSafeEqual throws on a mismatch —
  // it leaks the token's length and nothing else.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The metrics listener, on an EPHEMERAL loopback port.
 *
 * Random because nothing should have to configure it and nothing else should
 * be able to count on it: the port is published to the embedded proxy in the
 * routes table (preview/manager) and reached only as `/metrics` on the CMS
 * host — the same front door as every other route. The port is never public
 * and never guessable.
 *
 * `onListening` fires once the port is known, so the caller can republish the
 * routes table with it. Idempotent (HMR).
 */
export function startMetricsServer(onListening: () => void): void {
  const e = env();
  if (!e.METRICS_ENABLED) return;
  // Same shape as the sandbox's production refusal: a default that is right
  // for a laptop is wrong for a public host, and the boot is where that gets
  // said — not a scrape six months later that nobody was authenticating.
  if (!e.METRICS_TOKEN && process.env.NODE_ENV === 'production') {
    throw new Error(
      'METRICS_TOKEN is required in production: /metrics is served on the CMS host. ' +
        'Set one (any 16+ character secret) and give it to the scraper, or set METRICS_ENABLED=false.',
    );
  }
  const state = g as { __cmsMetricsServer?: Server };
  if (state.__cmsMetricsServer) return;

  const server = createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    if (!metricsAuthorized(req.headers.authorization)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    metricsText().then(
      (body) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
      },
      (err: unknown) => {
        console.error('[metrics] collection failed:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`# collection failed: ${err instanceof Error ? err.message : String(err)}\n`);
      },
    );
  });
  server.on('error', (err) => console.error('[metrics] listener failed:', err));
  // Port 0 = the OS picks a free one. HOST, because that is the address the
  // proxy dials for every other upstream (::1 in dev, 127.0.0.1 in prod).
  server.listen(0, env().HOST, () => {
    console.log(`[metrics] /metrics ready (internal port ${metricsPort()})`);
    onListening();
  });
  // Never a reason to hold the process open by itself.
  server.unref();
  state.__cmsMetricsServer = server;
}

/** The listener's port once it is up, for the routes table. */
export function metricsPort(): number | null {
  const server = (g as { __cmsMetricsServer?: Server }).__cmsMetricsServer;
  const address = server?.address();
  return address && typeof address === 'object' ? address.port : null;
}
