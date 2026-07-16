//! SSE client: live routing-table updates from the CMS
//! (/api/internal/proxy-events), authenticated with the shared token file
//! the CMS creates in VAR_DIR. Reconnects with capped exponential backoff;
//! the token file is re-read on every attempt so CMS-side rotation only
//! needs a proxy reconnect, not a restart.
//!
//! reqwest handles HTTP; the SSE framing is parsed here (a dedicated
//! eventsource crate would fight our token-per-attempt reconnect loop).

use crate::routes::{parse_routes, RoutesStore};
use futures_util::StreamExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// Incremental SSE parser: feed raw chunks, get (event, data) pairs.
/// Comment lines (`: ping`) and unknown fields are ignored.
#[derive(Default)]
pub struct SseParser {
    buf: String,
}

impl SseParser {
    pub fn feed(&mut self, chunk: &str) -> Vec<(String, String)> {
        self.buf.push_str(chunk);
        let mut events = Vec::new();
        while let Some(pos) = self.buf.find("\n\n") {
            let block: String = self.buf.drain(..pos + 2).collect();
            let mut event = String::from("message");
            let mut data_lines: Vec<String> = Vec::new();
            for line in block.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    event = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("data:") {
                    data_lines.push(v.strip_prefix(' ').unwrap_or(v).to_string());
                }
            }
            if !data_lines.is_empty() {
                events.push((event, data_lines.join("\n")));
            }
        }
        events
    }
}

/// Apply a `routes` event payload to the store. Returns false for invalid
/// payloads (last good config is kept, mirroring the file loader).
pub fn apply_routes_event(store: &RoutesStore, data: &str) -> bool {
    match parse_routes(data) {
        Ok(routes) => {
            if *store.get() != routes {
                log::info!(
                    "routes updated via SSE: cms={} previews={}",
                    routes.cms,
                    routes.previews.len()
                );
                store.set(routes);
            }
            true
        }
        Err(e) => {
            log::warn!("ignoring invalid routes event: {e}");
            false
        }
    }
}

pub fn spawn_sse_client(store: Arc<RoutesStore>, token_path: PathBuf) {
    std::thread::Builder::new()
        .name("cms-sse-client".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime for sse client");
            rt.block_on(run(store, token_path));
        })
        .expect("failed to spawn sse client thread");
}

async fn run(store: Arc<RoutesStore>, token_path: PathBuf) {
    let client = reqwest::Client::new();
    let mut backoff = BACKOFF_START;
    loop {
        let token = match std::fs::read_to_string(&token_path) {
            Ok(t) if !t.trim().is_empty() => t.trim().to_string(),
            _ => {
                log::debug!(
                    "internal token {} not available yet, retrying",
                    token_path.display()
                );
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
                continue;
            }
        };
        // The CMS upstream can move (routes updates carry it) — resolve fresh
        // from the store on every attempt.
        let url = format!("http://{}/api/internal/proxy-events", store.get().cms);
        match connect(&client, &url, &token, &store).await {
            Ok(true) => {
                // Had a live stream — reconnect promptly.
                log::warn!("CMS SSE stream ended, reconnecting");
                backoff = BACKOFF_START;
            }
            Ok(false) => log::warn!("CMS SSE endpoint rejected the connection"),
            Err(e) => log::warn!("CMS SSE connection to {url} failed: {e}"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// Returns Ok(true) when at least one event was received before the stream
/// ended, Ok(false) for a non-2xx response.
async fn connect(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    store: &RoutesStore,
) -> Result<bool, reqwest::Error> {
    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await?;
    if !resp.status().is_success() {
        log::warn!("CMS SSE endpoint returned {}", resp.status());
        return Ok(false);
    }
    log::info!("connected to CMS SSE at {url}");

    let mut got_event = false;
    let mut parser = SseParser::default();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        for (event, data) in parser.feed(&String::from_utf8_lossy(&chunk)) {
            if event == "routes" {
                apply_routes_event(store, &data);
                got_event = true;
            }
        }
    }
    Ok(got_event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::Routes;

    #[test]
    fn parser_handles_split_chunks_and_comments() {
        let mut p = SseParser::default();
        assert!(p.feed("event: rou").is_empty());
        assert!(p.feed("tes\ndata: {\"a\":1}\n").is_empty());
        let events = p.feed("\n: ping\n\nevent: x\ndata: y\n\n");
        assert_eq!(
            events,
            vec![
                ("routes".to_string(), "{\"a\":1}".to_string()),
                ("x".to_string(), "y".to_string()),
            ]
        );
    }

    #[test]
    fn parser_joins_multiline_data() {
        let mut p = SseParser::default();
        let events = p.feed("data: line1\ndata: line2\n\n");
        assert_eq!(events, vec![("message".to_string(), "line1\nline2".to_string())]);
    }

    #[test]
    fn routes_event_updates_store_and_keeps_last_good() {
        let store = RoutesStore::new(Routes::fallback("127.0.0.1:4321"));
        assert!(apply_routes_event(
            &store,
            r#"{"cms":"127.0.0.1:9999","previews":{"b":"127.0.0.1:1"}}"#
        ));
        assert_eq!(store.get().cms, "127.0.0.1:9999");
        assert_eq!(store.get().previews["b"], "127.0.0.1:1");

        assert!(!apply_routes_event(&store, "{ broken"));
        assert_eq!(store.get().cms, "127.0.0.1:9999"); // last good kept
    }
}
