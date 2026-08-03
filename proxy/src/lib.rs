//! Native Pingora public entrypoint for cms-agent.
//!
//! Routes by Host header:
//! - BASE_DOMAIN            -> CMS upstream (routes file `cms`, fallback CMS_UPSTREAM)
//! - <branch>.BASE_DOMAIN   -> known preview upstream (routes file `previews`),
//!                             with HTTP/1.1 Upgrade (WebSocket) passthrough for Vite HMR
//! - <valid>.BASE_DOMAIN    -> CMS upstream at /__preview/boot/<branch> (boot page)
//! - anything else          -> 404
//!
//! Preview hosts require a valid Better Auth database session, and HTML
//! responses from running previews get the overlay script injected.

mod access;
mod auth;
mod inject;
mod metrics;
mod routes;
mod sessions;

use async_trait::async_trait;
use bytes::Bytes;
use pingora::http::ResponseHeader;
use pingora::prelude::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

use napi_derive::napi;

use access::AccessTracker;
use routes::{RouteDecision, Routes, RoutesStore, METRICS_PATH};
use sessions::{ActiveSession, SessionStore};

static STATE: OnceLock<Arc<ProxyState>> = OnceLock::new();

fn ensure_listen_available(listen: &str) -> std::io::Result<()> {
    std::net::TcpListener::bind(listen).map(drop)
}

struct ProxyState {
    routes: Arc<RoutesStore>,
    sessions: Arc<SessionStore>,
    /// Preview access times. Rust owns the map; the CMS reads it over N-API
    /// for its idle sweep, so it lives here rather than in a file.
    access: Arc<AccessTracker>,
}

/// HTML bodies larger than this are passed through without overlay injection.
const MAX_INJECT_BYTES: usize = 4 * 1024 * 1024;

struct Config {
    listen: String,
    base_domain: String,
    var_dir: PathBuf,
    require_auth: bool,
    auth_secret: Vec<u8>,
    public_scheme: String,
    cms_upstream: String,
}

impl Config {
    fn from_env() -> Result<Config, String> {
        fn required(name: &str) -> Result<String, String> {
            std::env::var(name).map_err(|_| format!("missing required env var {name}"))
        }
        fn or_default(name: &str, default: &str) -> String {
            std::env::var(name).unwrap_or_else(|_| default.to_string())
        }

        let require_auth = std::env::var("PREVIEW_REQUIRE_AUTH")
            .map(|v| v != "false")
            .unwrap_or_else(|_| !matches!(or_default("SKIP_AUTH", "false").as_str(), "true" | "1"));
        let auth_secret = if require_auth {
            required("BETTER_AUTH_SECRET")?.into_bytes()
        } else {
            std::env::var("BETTER_AUTH_SECRET")
                .unwrap_or_default()
                .into_bytes()
        };
        Ok(Config {
            listen: or_default("PROXY_LISTEN", "0.0.0.0:8080"),
            base_domain: required("BASE_DOMAIN")?,
            var_dir: PathBuf::from(required("VAR_DIR")?),
            require_auth,
            auth_secret,
            public_scheme: or_default("PUBLIC_SCHEME", "http"),
            cms_upstream: or_default("CMS_UPSTREAM", "127.0.0.1:4321"),
        })
    }
}

struct CmsProxy {
    base_domain: String,
    require_auth: bool,
    auth_secret: Vec<u8>,
    /// Proof-of-proxy token stamped on every upstream request; the CMS refuses
    /// anything without it, so nobody reaches its port around this listener.
    proxy_token: String,
    /// scheme://BASE_DOMAIN — the public CMS origin WITHOUT a port. Requests
    /// append the port their Host header carried (the CMS is reached through
    /// this same proxy, so the port is shared); standard ports carry none.
    cms_origin: String,
    routes: Arc<RoutesStore>,
    sessions: Arc<SessionStore>,
    access: Arc<AccessTracker>,
    /// Per-branch User-Agent override (workspace device preview). Set/cleared
    /// by the `__cms_ua` query param on preview requests; applied to every
    /// upstream request for that branch so in-site navigation keeps the
    /// device UA. ponytail: last writer wins per branch — per-session
    /// overrides if concurrent editors ever need different devices.
    ua_overrides: RwLock<HashMap<String, String>>,
}

/// Query param carrying the preview UA override (`__cms_ua=<enc>` sets,
/// `__cms_ua=` clears). Mirrored in src/components/workspace/devices.ts.
const UA_PARAM: &str = "__cms_ua";
const UA_MAX_LEN: usize = 512;

/// UA-override update requested by a query string:
/// `None` = param absent (or undecodable/unsafe — ignored),
/// `Some(None)` = clear, `Some(Some(ua))` = set.
fn ua_override_from_query(query: &str) -> Option<Option<String>> {
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key != UA_PARAM {
            continue;
        }
        if value.is_empty() {
            return Some(None);
        }
        let Ok(decoded) = urlencoding::decode(value) else {
            return None;
        };
        let ua = decoded.into_owned();
        // Header-safe: printable ASCII only, bounded length.
        if ua.len() <= UA_MAX_LEN && ua.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
            return Some(Some(ua));
        }
        return None;
    }
    None
}

/// path?query with the `__cms_ua` pair removed — `None` when the param is
/// absent (leave the URI untouched). The previewed site never sees it.
fn strip_ua_param(path_and_query: &str) -> Option<String> {
    let (path, query) = path_and_query.split_once('?')?;
    let is_ua = |pair: &&str| {
        let key = pair.split_once('=').map_or(*pair, |(k, _)| k);
        key == UA_PARAM
    };
    if !query.split('&').any(|p| is_ua(&p)) {
        return None;
    }
    let rest: Vec<&str> = query.split('&').filter(|p| !is_ua(p)).collect();
    Some(if rest.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{}", rest.join("&"))
    })
}

#[derive(Default)]
struct RequestCtx {
    /// When this request was accepted, and what routing decision it got —
    /// the two things the logging hook needs to record it (metrics.rs).
    started: Option<Instant>,
    decision: &'static str,
    /// Resolved upstream "host:port"; None only when the request was answered early.
    upstream: Option<String>,
    /// True for case 2 (running preview): CSP strip + overlay injection apply.
    is_preview: bool,
    /// Port the request's Host header carried (None on standard ports). The
    /// CMS is reached through this same proxy, so the workspace origin the
    /// bootstrap must trust carries the same port.
    host_port: Option<String>,
    /// True while an HTML response body is being buffered for injection.
    buffering: bool,
    buffer: Vec<u8>,
    /// Active UA override for this preview request (device preview) — carried
    /// into the injected script tag so the page can mirror it on navigator.
    ua_override: Option<String>,
}

impl CmsProxy {
    fn is_authorized(&self, session: &Session) -> bool {
        if !self.require_auth {
            return true;
        }
        let now = auth::now_ms();
        for value in session.req_header().headers.get_all(http::header::COOKIE) {
            if let Ok(s) = value.to_str() {
                for name in [
                    "__Secure-better-auth.session_token",
                    "better-auth.session_token",
                ] {
                    if let Some(cookie) = auth::cookie_value(s, name) {
                        if let Ok(token) = auth::verify_session_cookie(cookie, &self.auth_secret) {
                            if self.sessions.is_active(&token, now) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        false
    }

    fn cms_origin_for(&self, port: Option<&str>) -> String {
        match port {
            Some(p) => format!("{}:{}", self.cms_origin, p),
            None => self.cms_origin.clone(),
        }
    }

    async fn redirect_signin(&self, session: &mut Session, port: Option<&str>) -> Result<()> {
        let signin_url = format!("{}/signin/", self.cms_origin_for(port));
        let mut resp = ResponseHeader::build(302, Some(3))?;
        resp.insert_header("Location", signin_url)?;
        resp.insert_header("Cache-Control", "no-store")?;
        resp.insert_header("Content-Length", "0")?;
        session.write_response_header(Box::new(resp), true).await
    }
}

/// Host header value (falling back to the :authority for h2), untouched.
fn request_host(req: &RequestHeader) -> Option<String> {
    if let Some(host) = req.headers.get(http::header::HOST) {
        if let Ok(s) = host.to_str() {
            return Some(s.to_string());
        }
    }
    req.uri.authority().map(|a| a.to_string())
}

/// Explicit port of a Host header value, if any ("name:8080" → "8080").
/// A bare IPv6 authority ("[::1]") yields None (its colon splits are not
/// all-digit).
fn host_port(host: &str) -> Option<&str> {
    match host.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
            Some(p)
        }
        _ => None,
    }
}

#[async_trait]
impl ProxyHttp for CmsProxy {
    type CTX = RequestCtx;

    fn new_ctx(&self) -> Self::CTX {
        RequestCtx {
            started: Some(Instant::now()),
            decision: "unknown",
            ..RequestCtx::default()
        }
    }

    async fn request_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<bool> {
        let Some(host) = request_host(session.req_header()) else {
            ctx.decision = "notfound";
            session.respond_error(404).await?;
            return Ok(true);
        };
        ctx.host_port = host_port(&host).map(str::to_string);
        let routes: Arc<Routes> = self.routes.get();

        match routes::decide(&host, &self.base_domain, &routes) {
            RouteDecision::Cms { upstream } => {
                // The CMS does its own auth — pass through.
                ctx.decision = "cms";
                // /metrics belongs to the CMS's metrics listener, which binds
                // an ephemeral loopback port and publishes it in the routes
                // table. Routed here so a scrape uses the same front door as
                // every other route instead of a second exposed port; the
                // listener itself enforces METRICS_TOKEN when one is set.
                if session.req_header().uri.path() == METRICS_PATH {
                    let Some(metrics_upstream) = routes.metrics.clone() else {
                        // Not listening (disabled, or not up yet) — a 404 is
                        // the honest answer. Falling through to the CMS
                        // upstream would render the workspace at /metrics.
                        ctx.decision = "notfound";
                        session.respond_error(404).await?;
                        return Ok(true);
                    };
                    ctx.decision = "metrics";
                    ctx.upstream = Some(metrics_upstream);
                } else {
                    ctx.upstream = Some(upstream);
                }
            }
            RouteDecision::Preview { branch, upstream } => {
                ctx.decision = "preview";
                if !self.is_authorized(session) {
                    ctx.decision = "unauthorized";
                    self.redirect_signin(session, ctx.host_port.as_deref()).await?;
                    return Ok(true);
                }
                self.access.touch(&branch, auth::now_ms());
                // The injected-agent bootstrap is served same-origin from the
                // preview host (dev servers block cross-origin subresources):
                // divert /__cms/… to the CMS upstream with the path rewritten.
                if session.req_header().uri.path() == inject::AGENT_PROXY_PATH {
                    let uri: http::Uri = inject::AGENT_CMS_PATH
                        .parse()
                        .expect("static path is a valid URI");
                    session.req_header_mut().set_uri(uri);
                    ctx.upstream = Some(routes.cms.clone());
                } else {
                    // Device preview: the `__cms_ua` query param updates the
                    // per-branch UA override; the param itself never reaches
                    // the previewed site.
                    if let Some(update) = session
                        .req_header()
                        .uri
                        .query()
                        .and_then(ua_override_from_query)
                    {
                        let mut map = self.ua_overrides.write().unwrap();
                        match update {
                            Some(ua) => {
                                map.insert(branch.clone(), ua);
                            }
                            None => {
                                map.remove(&branch);
                            }
                        }
                    }
                    let stripped = session
                        .req_header()
                        .uri
                        .path_and_query()
                        .and_then(|pq| strip_ua_param(pq.as_str()));
                    if let Some(pq) = stripped {
                        if let Ok(uri) = pq.parse::<http::Uri>() {
                            session.req_header_mut().set_uri(uri);
                        }
                    }
                    let ua = self.ua_overrides.read().unwrap().get(&branch).cloned();
                    if let Some(ua) = &ua {
                        session
                            .req_header_mut()
                            .insert_header(http::header::USER_AGENT, ua.as_str())?;
                    }
                    ctx.ua_override = ua;
                    ctx.upstream = Some(upstream);
                    ctx.is_preview = true;
                }
            }
            RouteDecision::Boot { branch, upstream } => {
                ctx.decision = "boot";
                if !self.is_authorized(session) {
                    ctx.decision = "unauthorized";
                    self.redirect_signin(session, ctx.host_port.as_deref()).await?;
                    return Ok(true);
                }
                self.access.touch(&branch, auth::now_ms());
                // /__preview/* (the boot page's SSE wait stream) passes
                // through unrewritten — the CMS serves it on this host.
                if session.req_header().uri.path().starts_with("/__preview/") {
                    ctx.upstream = Some(upstream);
                    return Ok(false);
                }
                // Rewrite to the CMS boot endpoint; method stays as-is (a GET
                // stays a GET). The query is preserved (?retry=1 drives the
                // boot page's retry flow) and the original path+query travels
                // in a header so the CMS can send the browser back to it —
                // the /__preview/boot path itself never reaches the browser.
                let orig = session
                    .req_header()
                    .uri
                    .path_and_query()
                    .map(|pq| pq.as_str().to_string())
                    .unwrap_or_else(|| "/".to_string());
                let query = session
                    .req_header()
                    .uri
                    .query()
                    .map(|q| format!("?{q}"))
                    .unwrap_or_default();
                let uri: http::Uri = format!("/__preview/boot/{branch}{query}")
                    .parse()
                    .expect("validated branch label + query from a parsed URI form a valid path");
                session
                    .req_header_mut()
                    .insert_header("x-cms-boot-origin", &orig)?;
                session.req_header_mut().set_uri(uri);
                ctx.upstream = Some(upstream);
            }
            RouteDecision::NotFound => {
                ctx.decision = "notfound";
                session.respond_error(404).await?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Stamp the proof-of-proxy header. `insert_header` REPLACES whatever the
    /// client sent under that name, so a request cannot smuggle its own token
    /// through this listener — the only value upstream ever sees is ours.
    async fn upstream_request_filter(
        &self,
        _session: &mut Session,
        upstream_request: &mut RequestHeader,
        _ctx: &mut Self::CTX,
    ) -> Result<()> {
        upstream_request.insert_header(auth::PROXY_HEADER, self.proxy_token.as_str())
    }

    async fn upstream_peer(
        &self,
        _session: &mut Session,
        ctx: &mut Self::CTX,
    ) -> Result<Box<HttpPeer>> {
        let upstream = ctx
            .upstream
            .as_deref()
            .ok_or_else(|| Error::explain(ErrorType::InternalError, "no upstream resolved"))?;
        let addr = std::net::ToSocketAddrs::to_socket_addrs(upstream)
            .ok()
            .and_then(|mut addrs| addrs.next())
            .ok_or_else(|| {
                Error::explain(
                    ErrorType::ConnectError,
                    format!("bad upstream address: {upstream}"),
                )
            })?;
        // Plain HTTP/1.1 peer. Pingora handles Upgrade (WebSocket) passthrough
        // natively for h1, which covers Vite HMR.
        Ok(Box::new(HttpPeer::new(addr, false, String::new())))
    }

    async fn response_filter(
        &self,
        _session: &mut Session,
        upstream_response: &mut ResponseHeader,
        ctx: &mut Self::CTX,
    ) -> Result<()> {
        if !ctx.is_preview {
            return Ok(());
        }
        // Dev servers may send CSP that would block the injected overlay script.
        // Previews are auth-gated, so dropping it is acceptable.
        upstream_response.remove_header("content-security-policy");
        upstream_response.remove_header("content-security-policy-report-only");

        if upstream_response.status.as_u16() == 101 {
            // Upgrade (WebSocket) handshake — leave it alone.
            return Ok(());
        }
        let is_html = upstream_response
            .headers
            .get(http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim_start().to_ascii_lowercase().starts_with("text/html"))
            .unwrap_or(false);
        if !is_html {
            return Ok(());
        }
        let content_length = upstream_response
            .headers
            .get(http::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok());
        if matches!(content_length, Some(len) if len > MAX_INJECT_BYTES) {
            // Too large to buffer — pass through unmodified.
            return Ok(());
        }
        // The body length will change; drop Content-Length and switch to
        // chunked transfer encoding (pingora does not add it automatically).
        upstream_response.remove_header(&http::header::CONTENT_LENGTH);
        upstream_response.insert_header("Transfer-Encoding", "chunked")?;
        upstream_response.set_version(http::Version::HTTP_11);
        if let Some(len) = content_length {
            ctx.buffer.reserve(len);
        }
        ctx.buffering = true;
        Ok(())
    }

    fn response_body_filter(
        &self,
        _session: &mut Session,
        body: &mut Option<Bytes>,
        end_of_stream: bool,
        ctx: &mut Self::CTX,
    ) -> Result<Option<Duration>> {
        if !ctx.buffering {
            return Ok(None);
        }
        if let Some(chunk) = body.take() {
            ctx.buffer.extend_from_slice(&chunk);
        }
        if !end_of_stream {
            if ctx.buffer.len() > MAX_INJECT_BYTES {
                // No Content-Length upfront and the body turned out huge:
                // give up on injection and stream out what we have.
                ctx.buffering = false;
                *body = Some(Bytes::from(std::mem::take(&mut ctx.buffer)));
            }
            return Ok(None);
        }
        ctx.buffering = false;
        let html = std::mem::take(&mut ctx.buffer);
        let tag = inject::agent_script_tag(
            &self.cms_origin_for(ctx.host_port.as_deref()),
            ctx.ua_override.as_deref(),
        );
        let out = inject::inject_overlay(&html, &tag).unwrap_or(html);
        *body = Some(Bytes::from(out));
        Ok(None)
    }

    /// Runs for every request, including the ones answered here without an
    /// upstream (404, sign-in redirect) — which is why the metrics are
    /// recorded from this hook rather than around the proxy call.
    async fn logging(&self, session: &mut Session, e: Option<&Error>, ctx: &mut Self::CTX) {
        let status = session
            .response_written()
            .map(|resp| resp.status.as_u16())
            .unwrap_or(0);
        let seconds = ctx
            .started
            .map(|started| started.elapsed().as_secs_f64())
            .unwrap_or_default();
        metrics::record_request(ctx.decision, status, seconds, e.is_some());
    }
}

fn run_proxy(cfg: Config, state: Arc<ProxyState>) {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));
    let routes_path = cfg.var_dir.join("proxy-routes.json");

    // The file is only a boot fallback. Live updates arrive through N-API.
    state.routes.try_reload(&routes_path);

    let proxy = CmsProxy {
        cms_origin: format!("{}://{}", cfg.public_scheme, cfg.base_domain),
        base_domain: cfg.base_domain,
        require_auth: cfg.require_auth,
        proxy_token: auth::proxy_token(&cfg.auth_secret),
        auth_secret: cfg.auth_secret,
        routes: state.routes.clone(),
        sessions: state.sessions.clone(),
        access: state.access.clone(),
        ua_overrides: RwLock::new(HashMap::new()),
    };

    // Short, explicit shutdown timings. Pingora's SIGTERM default sleeps a
    // 5-MINUTE grace period — long-lived SSE/HMR connections never drain, so
    // docker stop (10s) and overmind both ended up SIGKILLing the proxy.
    let mut server_conf = pingora::server::configuration::ServerConf::default();
    server_conf.grace_period_seconds = Some(2);
    server_conf.graceful_shutdown_timeout_seconds = Some(3);
    let mut server = Server::new_with_opt_and_conf(None, server_conf);
    server.bootstrap();
    let mut service = http_proxy_service(&server.configuration, proxy);
    service.add_tcp(&cfg.listen);
    server.add_service(service);
    log::info!("cms-agent-proxy listening on {}", cfg.listen);
    server.run_forever();
}

#[napi(js_name = "startProxy")]
pub fn start_proxy() -> napi::Result<()> {
    let cfg = Config::from_env().map_err(napi::Error::from_reason)?;
    ensure_listen_available(&cfg.listen).map_err(|error| {
        napi::Error::from_reason(format!("cannot bind {}: {error}", cfg.listen))
    })?;
    let state = Arc::new(ProxyState {
        routes: Arc::new(RoutesStore::new(Routes::fallback(&cfg.cms_upstream))),
        sessions: Arc::new(SessionStore::default()),
        access: AccessTracker::new(),
    });
    STATE
        .set(state.clone())
        .map_err(|_| napi::Error::from_reason("proxy already started"))?;
    std::thread::Builder::new()
        .name("cms-agent-proxy".into())
        .spawn(move || run_proxy(cfg, state))
        .map_err(|e| napi::Error::from_reason(format!("failed to start proxy: {e}")))?;
    Ok(())
}

#[napi(js_name = "setProxyRoutes")]
pub fn set_proxy_routes(routes_json: String) -> napi::Result<()> {
    let routes = routes::parse_routes(&routes_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid routes: {e}")))?;
    STATE
        .get()
        .ok_or_else(|| napi::Error::from_reason("proxy is not started"))?
        .routes
        .set(routes);
    Ok(())
}

#[napi(js_name = "setProxySessions")]
pub fn set_proxy_sessions(sessions: Vec<ActiveSession>) -> napi::Result<()> {
    STATE
        .get()
        .ok_or_else(|| napi::Error::from_reason("proxy is not started"))?
        .sessions
        .replace(sessions);
    Ok(())
}

/// Revoke one session in the proxy, now.
///
/// The reconciliation tick would eventually drop it, but "eventually" is the
/// wrong contract for a sign-out: until then the cookie still opens previews.
#[napi(js_name = "dropProxySession")]
pub fn drop_proxy_session(token: String) -> napi::Result<()> {
    STATE
        .get()
        .ok_or_else(|| napi::Error::from_reason("proxy is not started"))?
        .sessions
        .forget(&token);
    Ok(())
}

/// The proxy's own Prometheus exposition, for the CMS to append to its.
///
/// Deliberately not a listener of its own: proxy and CMS are one process, so
/// one scrape endpoint should cover both. Empty before the first request.
#[napi(js_name = "proxyMetricsText")]
pub fn proxy_metrics_text() -> String {
    metrics::text()
}

/// Last-access time per preview branch, for the CMS's idle sweep.
///
/// Returned as pairs rather than a map because napi-rs has no HashMap
/// conversion; the caller turns them back into an object.
#[napi(js_name = "proxyAccessTimes")]
pub fn proxy_access_times() -> napi::Result<Vec<AccessEntry>> {
    Ok(STATE
        .get()
        .ok_or_else(|| napi::Error::from_reason("proxy is not started"))?
        .access
        .snapshot()
        .into_iter()
        .map(|(branch, at_ms)| AccessEntry {
            branch,
            at_ms: at_ms as f64,
        })
        .collect())
}

/// One branch's last access. `at_ms` is f64 because JS numbers are — a
/// millisecond timestamp is exact well past any plausible uptime.
#[napi(object)]
pub struct AccessEntry {
    pub branch: String,
    pub at_ms: f64,
}

#[napi(js_name = "upsertProxySession")]
pub fn upsert_proxy_session(session: ActiveSession) -> napi::Result<()> {
    STATE
        .get()
        .ok_or_else(|| napi::Error::from_reason("proxy is not started"))?
        .sessions
        .upsert(session);
    Ok(())
}

#[cfg(test)]
mod native_tests {
    use super::ensure_listen_available;

    #[test]
    fn listener_preflight_rejects_an_occupied_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        assert!(ensure_listen_available(&address.to_string()).is_err());
    }

    #[test]
    fn ua_override_query_sets_clears_and_ignores() {
        use super::ua_override_from_query;
        assert_eq!(
            ua_override_from_query("__cms_ua=Mozilla%2F5.0%20(iPhone)"),
            Some(Some("Mozilla/5.0 (iPhone)".to_string()))
        );
        // empty value = clear
        assert_eq!(ua_override_from_query("__cms_ua="), Some(None));
        assert_eq!(ua_override_from_query("x=1&__cms_ua=&y=2"), Some(None));
        // absent
        assert_eq!(ua_override_from_query("x=1&y=2"), None);
        assert_eq!(ua_override_from_query(""), None);
        // unsafe values are ignored, not applied
        assert_eq!(ua_override_from_query("__cms_ua=bad%00byte"), None);
        assert_eq!(ua_override_from_query("__cms_ua=line%0Abreak"), None);
        let long = format!("__cms_ua={}", "a".repeat(600));
        assert_eq!(ua_override_from_query(&long), None);
    }

    #[test]
    fn ua_param_is_stripped_from_the_upstream_uri() {
        use super::strip_ua_param;
        assert_eq!(
            strip_ua_param("/about?__cms_ua=Mozilla%2F5.0"),
            Some("/about".to_string())
        );
        assert_eq!(
            strip_ua_param("/p?x=1&__cms_ua=ua&y=2"),
            Some("/p?x=1&y=2".to_string())
        );
        assert_eq!(strip_ua_param("/p?__cms_ua="), Some("/p".to_string()));
        assert_eq!(strip_ua_param("/p?x=1"), None);
        assert_eq!(strip_ua_param("/p"), None);
    }

    #[test]
    fn host_port_extracts_only_explicit_numeric_ports() {
        use super::host_port;
        assert_eq!(host_port("cms.example.com:8080"), Some("8080"));
        assert_eq!(host_port("main.localhost:44341"), Some("44341"));
        assert_eq!(host_port("cms.example.com"), None);
        assert_eq!(host_port("[::1]"), None);
        assert_eq!(host_port("[::1]:8080"), Some("8080"));
        assert_eq!(host_port(":8080"), None);
        assert_eq!(host_port("host:"), None);
    }
}
