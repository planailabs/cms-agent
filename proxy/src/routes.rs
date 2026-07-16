//! Routes file loading, hot reload, and Host-header route decisions.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, RwLock};

/// Contract with the TypeScript CMS: `${VAR_DIR}/proxy-routes.json`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Routes {
    /// Upstream for the base domain, e.g. "127.0.0.1:4321".
    pub cms: String,
    /// Branch name -> preview upstream, e.g. "my-branch" -> "127.0.0.1:43211".
    #[serde(default)]
    pub previews: HashMap<String, String>,
}

impl Routes {
    /// Config used until the routes file has been read successfully at least once.
    pub fn fallback(cms_upstream: &str) -> Self {
        Routes {
            cms: cms_upstream.to_string(),
            previews: HashMap::new(),
        }
    }
}

pub fn parse_routes(data: &str) -> Result<Routes, serde_json::Error> {
    serde_json::from_str(data)
}

/// Where a request should go, decided from the Host header.
#[derive(Debug, Clone, PartialEq)]
pub enum RouteDecision {
    /// Host == BASE_DOMAIN -> CMS upstream.
    Cms { upstream: String },
    /// Host == <branch>.BASE_DOMAIN and <branch> is a known preview.
    Preview { branch: String, upstream: String },
    /// Host == <branch>.BASE_DOMAIN, valid label but unknown -> ask the CMS to boot it.
    Boot { branch: String, upstream: String },
    /// Anything else.
    NotFound,
}

/// Strip an optional `:port` suffix from a Host header value.
pub fn strip_port(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        // IPv6 literal: [::1]:8080
        if let Some(end) = rest.find(']') {
            return &host[..end + 2];
        }
        return host;
    }
    match host.rfind(':') {
        Some(i) => &host[..i],
        None => host,
    }
}

/// Syntactically valid DNS label: ^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$
pub fn valid_label(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 63 {
        return false;
    }
    let inner_ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-';
    let edge_ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    edge_ok(&b[0]) && edge_ok(&b[b.len() - 1]) && b.iter().all(inner_ok)
}

/// Decide the route for a request Host header.
pub fn decide(host: &str, base_domain: &str, routes: &Routes) -> RouteDecision {
    let host = strip_port(host.trim()).to_ascii_lowercase();
    let base = base_domain.to_ascii_lowercase();
    if host == base {
        return RouteDecision::Cms {
            upstream: routes.cms.clone(),
        };
    }
    if let Some(branch) = host.strip_suffix(&format!(".{base}")) {
        if valid_label(branch) {
            if let Some(upstream) = routes.previews.get(branch) {
                return RouteDecision::Preview {
                    branch: branch.to_string(),
                    upstream: upstream.clone(),
                };
            }
            return RouteDecision::Boot {
                branch: branch.to_string(),
                upstream: routes.cms.clone(),
            };
        }
    }
    RouteDecision::NotFound
}

/// Shared, hot-reloadable routes config.
pub struct RoutesStore {
    inner: RwLock<Arc<Routes>>,
}

impl RoutesStore {
    pub fn new(initial: Routes) -> Self {
        RoutesStore {
            inner: RwLock::new(Arc::new(initial)),
        }
    }

    pub fn get(&self) -> Arc<Routes> {
        self.inner.read().expect("routes lock poisoned").clone()
    }

    pub fn set(&self, routes: Routes) {
        *self.inner.write().expect("routes lock poisoned") = Arc::new(routes);
    }

    /// Try to load `path` into the store. On any error the last good config is kept.
    /// Returns true if the store was updated.
    pub fn try_reload(&self, path: &Path) -> bool {
        let data = match std::fs::read_to_string(path) {
            Ok(d) => d,
            Err(e) => {
                log::debug!("routes file {} unreadable: {e}", path.display());
                return false;
            }
        };
        match parse_routes(&data) {
            Ok(routes) => {
                if *self.get() != routes {
                    log::info!(
                        "routes reloaded: cms={} previews={}",
                        routes.cms,
                        routes.previews.len()
                    );
                    self.set(routes);
                }
                true
            }
            Err(e) => {
                log::warn!(
                    "routes file {} invalid, keeping last good config: {e}",
                    path.display()
                );
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routes() -> Routes {
        let mut previews = HashMap::new();
        previews.insert("my-branch".to_string(), "127.0.0.1:43211".to_string());
        Routes {
            cms: "127.0.0.1:4321".to_string(),
            previews,
        }
    }

    #[test]
    fn base_domain_goes_to_cms() {
        assert_eq!(
            decide("cms.example.com", "cms.example.com", &routes()),
            RouteDecision::Cms {
                upstream: "127.0.0.1:4321".into()
            }
        );
    }

    #[test]
    fn known_branch_goes_to_preview_upstream() {
        assert_eq!(
            decide("my-branch.cms.example.com", "cms.example.com", &routes()),
            RouteDecision::Preview {
                branch: "my-branch".into(),
                upstream: "127.0.0.1:43211".into()
            }
        );
    }

    #[test]
    fn unknown_valid_branch_goes_to_boot() {
        assert_eq!(
            decide("new-thing.cms.example.com", "cms.example.com", &routes()),
            RouteDecision::Boot {
                branch: "new-thing".into(),
                upstream: "127.0.0.1:4321".into()
            }
        );
    }

    #[test]
    fn garbage_hosts_are_not_found() {
        let r = routes();
        assert_eq!(decide("evil.com", "cms.example.com", &r), RouteDecision::NotFound);
        assert_eq!(decide("", "cms.example.com", &r), RouteDecision::NotFound);
        // nested label is not a single branch label
        assert_eq!(
            decide("a.b.cms.example.com", "cms.example.com", &r),
            RouteDecision::NotFound
        );
        // invalid labels
        assert_eq!(
            decide("-bad.cms.example.com", "cms.example.com", &r),
            RouteDecision::NotFound
        );
        assert_eq!(
            decide("bad-.cms.example.com", "cms.example.com", &r),
            RouteDecision::NotFound
        );
        assert_eq!(
            decide("UP_PER.cms.example.com", "cms.example.com", &r),
            RouteDecision::NotFound
        );
        // suffix match must be on a label boundary
        assert_eq!(
            decide("xcms.example.com", "cms.example.com", &r),
            RouteDecision::NotFound
        );
    }

    #[test]
    fn port_is_stripped_from_host() {
        let r = routes();
        assert_eq!(
            decide("cms.example.com:8080", "cms.example.com", &r),
            RouteDecision::Cms {
                upstream: "127.0.0.1:4321".into()
            }
        );
        assert_eq!(
            decide("my-branch.cms.example.com:8080", "cms.example.com", &r),
            RouteDecision::Preview {
                branch: "my-branch".into(),
                upstream: "127.0.0.1:43211".into()
            }
        );
    }

    #[test]
    fn host_matching_is_case_insensitive() {
        assert_eq!(
            decide("My-Branch.CMS.Example.COM", "cms.example.com", &routes()),
            RouteDecision::Preview {
                branch: "my-branch".into(),
                upstream: "127.0.0.1:43211".into()
            }
        );
    }

    #[test]
    fn valid_label_rules() {
        assert!(valid_label("a"));
        assert!(valid_label("a1-b2"));
        assert!(valid_label(&"a".repeat(63)));
        assert!(!valid_label(&"a".repeat(64)));
        assert!(!valid_label(""));
        assert!(!valid_label("-a"));
        assert!(!valid_label("a-"));
        assert!(!valid_label("a.b"));
        assert!(!valid_label("A"));
    }

    #[test]
    fn parse_routes_valid() {
        let r = parse_routes(
            r#"{"cms":"127.0.0.1:4321","previews":{"my-branch":"127.0.0.1:43211"}}"#,
        )
        .unwrap();
        assert_eq!(r, routes());
        // previews may be omitted
        let r = parse_routes(r#"{"cms":"127.0.0.1:4321"}"#).unwrap();
        assert!(r.previews.is_empty());
    }

    #[test]
    fn parse_routes_broken() {
        assert!(parse_routes("not json").is_err());
        assert!(parse_routes(r#"{"previews":{}}"#).is_err()); // missing cms
    }

    #[test]
    fn store_keeps_last_good_on_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proxy-routes.json");
        let store = RoutesStore::new(Routes::fallback("127.0.0.1:4321"));

        // never loaded -> fallback
        assert_eq!(store.get().cms, "127.0.0.1:4321");
        // missing file -> keep fallback
        assert!(!store.try_reload(&path));
        assert_eq!(store.get().cms, "127.0.0.1:4321");

        // good file -> loaded
        std::fs::write(&path, r#"{"cms":"127.0.0.1:9999","previews":{"b":"127.0.0.1:1"}}"#)
            .unwrap();
        assert!(store.try_reload(&path));
        assert_eq!(store.get().cms, "127.0.0.1:9999");
        assert_eq!(store.get().previews["b"], "127.0.0.1:1");

        // broken file -> keep last good
        std::fs::write(&path, "{ broken").unwrap();
        assert!(!store.try_reload(&path));
        assert_eq!(store.get().cms, "127.0.0.1:9999");
    }
}
