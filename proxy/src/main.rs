//! cms-agent-proxy: stable public entrypoint for the CMS.
//!
//! Routes by Host header:
//! - BASE_DOMAIN            -> CMS upstream (routes file `cms`, fallback CMS_UPSTREAM)
//! - <branch>.BASE_DOMAIN   -> known preview upstream (routes file `previews`),
//!                             with HTTP/1.1 Upgrade (WebSocket) passthrough for Vite HMR
//! - <valid>.BASE_DOMAIN    -> CMS upstream at /__preview/boot/<branch> (boot page)
//! - anything else          -> 404
//!
//! Preview hosts are gated by the HMAC-signed `cms_preview` cookie, and HTML
//! responses from running previews get the overlay script injected.

mod access;
mod auth;
mod inject;
mod routes;
mod sse;

use async_trait::async_trait;
use bytes::Bytes;
use pingora::http::ResponseHeader;
use pingora::prelude::*;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use access::AccessTracker;
use routes::{RouteDecision, Routes, RoutesStore};

/// HTML bodies larger than this are passed through without overlay injection.
const MAX_INJECT_BYTES: usize = 4 * 1024 * 1024;

struct Config {
    listen: String,
    base_domain: String,
    var_dir: PathBuf,
    require_auth: bool,
    cookie_secret: Vec<u8>,
    public_scheme: String,
    cms_upstream: String,
}

impl Config {
    fn from_env() -> Config {
        fn required(name: &str) -> String {
            std::env::var(name).unwrap_or_else(|_| {
                eprintln!("cms-agent-proxy: missing required env var {name}");
                std::process::exit(1);
            })
        }
        fn or_default(name: &str, default: &str) -> String {
            std::env::var(name).unwrap_or_else(|_| default.to_string())
        }

        let require_auth = or_default("PREVIEW_REQUIRE_AUTH", "true") != "false";
        let cookie_secret = if require_auth {
            required("PREVIEW_COOKIE_SECRET").into_bytes()
        } else {
            std::env::var("PREVIEW_COOKIE_SECRET")
                .unwrap_or_default()
                .into_bytes()
        };
        Config {
            listen: or_default("PROXY_LISTEN", "0.0.0.0:8080"),
            base_domain: required("BASE_DOMAIN"),
            var_dir: PathBuf::from(required("VAR_DIR")),
            require_auth,
            cookie_secret,
            public_scheme: or_default("PUBLIC_SCHEME", "http"),
            cms_upstream: or_default("CMS_UPSTREAM", "127.0.0.1:4321"),
        }
    }
}

struct CmsProxy {
    base_domain: String,
    require_auth: bool,
    cookie_secret: Vec<u8>,
    signin_url: String,
    overlay_tag: String,
    routes: Arc<RoutesStore>,
    access: Arc<AccessTracker>,
}

#[derive(Default)]
struct RequestCtx {
    /// Resolved upstream "host:port"; None only when the request was answered early.
    upstream: Option<String>,
    /// True for case 2 (running preview): CSP strip + overlay injection apply.
    is_preview: bool,
    /// True while an HTML response body is being buffered for injection.
    buffering: bool,
    buffer: Vec<u8>,
}

impl CmsProxy {
    fn is_authorized(&self, session: &Session) -> bool {
        if !self.require_auth {
            return true;
        }
        let now = auth::now_ms();
        for value in session.req_header().headers.get_all(http::header::COOKIE) {
            if let Ok(s) = value.to_str() {
                if let Some(cookie) = auth::cookie_value(s, "cms_preview") {
                    if auth::verify_preview_cookie(cookie, &self.cookie_secret, now).is_ok() {
                        return true;
                    }
                }
            }
        }
        false
    }

    async fn redirect_signin(&self, session: &mut Session) -> Result<()> {
        let mut resp = ResponseHeader::build(302, Some(3))?;
        resp.insert_header("Location", self.signin_url.as_str())?;
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

#[async_trait]
impl ProxyHttp for CmsProxy {
    type CTX = RequestCtx;

    fn new_ctx(&self) -> Self::CTX {
        RequestCtx::default()
    }

    async fn request_filter(&self, session: &mut Session, ctx: &mut Self::CTX) -> Result<bool> {
        let Some(host) = request_host(session.req_header()) else {
            session.respond_error(404).await?;
            return Ok(true);
        };
        let routes: Arc<Routes> = self.routes.get();

        match routes::decide(&host, &self.base_domain, &routes) {
            RouteDecision::Cms { upstream } => {
                // The CMS does its own auth — pass through.
                ctx.upstream = Some(upstream);
            }
            RouteDecision::Preview { branch, upstream } => {
                if !self.is_authorized(session) {
                    self.redirect_signin(session).await?;
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
                    ctx.upstream = Some(upstream);
                    ctx.is_preview = true;
                }
            }
            RouteDecision::Boot { branch, upstream } => {
                if !self.is_authorized(session) {
                    self.redirect_signin(session).await?;
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
                session.respond_error(404).await?;
                return Ok(true);
            }
        }
        Ok(false)
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
        let out = inject::inject_overlay(&html, &self.overlay_tag).unwrap_or(html);
        *body = Some(Bytes::from(out));
        Ok(None)
    }
}

fn main() {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));
    let cfg = Config::from_env();

    let routes_path = cfg.var_dir.join("proxy-routes.json");
    let access_path = cfg.var_dir.join("proxy-access.json");

    // Boot fallback from the routes file; everything after that arrives live
    // over the token-authenticated SSE subscription to the CMS.
    let store = Arc::new(RoutesStore::new(Routes::fallback(&cfg.cms_upstream)));
    store.try_reload(&routes_path);
    sse::spawn_sse_client(store.clone(), cfg.var_dir.join("internal-token"));

    let access = AccessTracker::new();
    access::spawn_flusher(access.clone(), access_path);

    let proxy = CmsProxy {
        signin_url: format!("{}://{}/signin/", cfg.public_scheme, cfg.base_domain),
        overlay_tag: inject::agent_script_tag(&format!(
            "{}://{}",
            cfg.public_scheme, cfg.base_domain
        )),
        base_domain: cfg.base_domain,
        require_auth: cfg.require_auth,
        cookie_secret: cfg.cookie_secret,
        routes: store,
        access,
    };

    let mut server = Server::new(None).expect("pingora server init");
    server.bootstrap();
    let mut service = http_proxy_service(&server.configuration, proxy);
    service.add_tcp(&cfg.listen);
    server.add_service(service);
    log::info!("cms-agent-proxy listening on {}", cfg.listen);
    server.run_forever();
}
