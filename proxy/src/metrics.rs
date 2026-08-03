//! Proxy metrics, in Prometheus text format.
//!
//! The proxy runs inside the CMS process (N-API), so it does not serve its own
//! scrape endpoint: `proxyMetricsText()` hands this registry's exposition to
//! the Node side, which appends it to its own (see src/lib/metrics.ts). One
//! process, one scrape target.
//!
//! Labels are deliberately bounded. The routing decision has five values and
//! the status is a class, so the whole surface is ~20 series no matter how
//! much traffic or how many branches pass through.
//! ponytail: no per-branch label — branches are created and deleted all day
//! and every one of them would leave a series behind forever. Add one (and a
//! restart-bounded cleanup) only if "which preview is slow" ever stops being
//! answerable from the CMS-side preview metrics.

use prometheus::{Encoder, HistogramOpts, HistogramVec, IntCounterVec, Opts, Registry, TextEncoder};
use std::sync::OnceLock;

/// Proxy hops are fast or they are a problem: the interesting resolution is
/// milliseconds, with a long tail for streamed responses (SSE, Vite HMR).
const BUCKETS: &[f64] = &[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0];

struct Metrics {
    registry: Registry,
    requests: IntCounterVec,
    duration: HistogramVec,
    upstream_errors: IntCounterVec,
}

static METRICS: OnceLock<Metrics> = OnceLock::new();

fn metrics() -> &'static Metrics {
    METRICS.get_or_init(|| {
        let registry = Registry::new();
        let requests = IntCounterVec::new(
            Opts::new(
                "cms_proxy_requests_total",
                "Proxied requests by routing decision and status class",
            ),
            &["decision", "status"],
        )
        .expect("static metric definition is valid");
        let duration = HistogramVec::new(
            HistogramOpts::new(
                "cms_proxy_request_duration_seconds",
                "Time from accepting a request to finishing its response",
            )
            .buckets(BUCKETS.to_vec()),
            &["decision"],
        )
        .expect("static metric definition is valid");
        let upstream_errors = IntCounterVec::new(
            Opts::new(
                "cms_proxy_upstream_errors_total",
                "Requests that ended in a proxy or upstream error",
            ),
            &["decision"],
        )
        .expect("static metric definition is valid");
        for collector in [
            Box::new(requests.clone()) as Box<dyn prometheus::core::Collector>,
            Box::new(duration.clone()),
            Box::new(upstream_errors.clone()),
        ] {
            registry
                .register(collector)
                .expect("each collector is registered once");
        }
        Metrics {
            registry,
            requests,
            duration,
            upstream_errors,
        }
    })
}

/// Status class as a fixed label. `0` means nothing was written — the client
/// went away, or the connection failed before a response existed.
fn status_class(status: u16) -> &'static str {
    match status {
        0 => "none",
        100..=199 => "1xx",
        200..=299 => "2xx",
        300..=399 => "3xx",
        400..=499 => "4xx",
        _ => "5xx",
    }
}

/// One finished request. Called from the proxy's logging hook, which runs for
/// every request including the ones answered without an upstream (404s, the
/// sign-in redirect).
pub fn record_request(decision: &str, status: u16, seconds: f64, failed: bool) {
    let m = metrics();
    m.requests
        .with_label_values(&[decision, status_class(status)])
        .inc();
    m.duration.with_label_values(&[decision]).observe(seconds);
    if failed {
        m.upstream_errors.with_label_values(&[decision]).inc();
    }
}

/// The registry's exposition, or an empty string if it cannot be encoded —
/// a scrape must never be the thing that takes the proxy down.
pub fn text() -> String {
    let mut buffer = Vec::new();
    let encoder = TextEncoder::new();
    match encoder.encode(&metrics().registry.gather(), &mut buffer) {
        Ok(()) => String::from_utf8(buffer).unwrap_or_default(),
        Err(err) => {
            log::warn!("failed to encode proxy metrics: {err}");
            String::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{record_request, status_class, text};

    #[test]
    fn status_classes_are_bounded() {
        assert_eq!(status_class(0), "none");
        assert_eq!(status_class(200), "2xx");
        assert_eq!(status_class(302), "3xx");
        assert_eq!(status_class(404), "4xx");
        assert_eq!(status_class(502), "5xx");
    }

    #[test]
    fn a_recorded_request_shows_up_in_the_exposition() {
        record_request("preview", 200, 0.02, false);
        record_request("notfound", 404, 0.001, false);
        record_request("cms", 502, 1.5, true);
        let out = text();
        assert!(out.contains("cms_proxy_requests_total{decision=\"preview\",status=\"2xx\"} 1"));
        assert!(out.contains("cms_proxy_requests_total{decision=\"notfound\",status=\"4xx\"} 1"));
        assert!(out.contains("cms_proxy_upstream_errors_total{decision=\"cms\"} 1"));
        assert!(out.contains("cms_proxy_request_duration_seconds_bucket"));
    }
}
