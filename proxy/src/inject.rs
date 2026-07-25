//! HTML overlay injection: add the injected-agent `<script>` tag before
//! `</head>` (case-insensitive), falling back to `</body>`. If neither
//! exists, skip.

/// Path on PREVIEW hosts that the proxy rewrites to the CMS's
/// /injected-cms-agent.js — the script loads same-origin, so dev servers'
/// cross-origin subresource blocking never triggers.
pub const AGENT_PROXY_PATH: &str = "/__cms/injected-cms-agent.js";

/// Path on the CMS upstream that serves the bootstrap bundle.
pub const AGENT_CMS_PATH: &str = "/injected-cms-agent.js";

/// The tag injected into preview HTML. `cms_origin` (scheme://base_domain)
/// tells the bootstrap which parent origin to trust — it can no longer derive
/// that from its own src, which is now the preview origin.
pub fn agent_script_tag(cms_origin: &str) -> String {
    format!(r#"<script src="{AGENT_PROXY_PATH}" data-cms-origin="{cms_origin}" defer></script>"#)
}

/// Returns the rewritten HTML, or None when there is no injection point
/// (caller should pass the body through unmodified).
pub fn inject_overlay(html: &[u8], script_tag: &str) -> Option<Vec<u8>> {
    let pos = find_ci(html, b"</head>").or_else(|| find_ci(html, b"</body>"))?;
    let mut out = Vec::with_capacity(html.len() + script_tag.len());
    out.extend_from_slice(&html[..pos]);
    out.extend_from_slice(script_tag.as_bytes());
    out.extend_from_slice(&html[pos..]);
    Some(out)
}

/// Find `needle` (must be ASCII lowercase) in `haystack`, case-insensitively.
fn find_ci(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w.eq_ignore_ascii_case(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag() -> String {
        agent_script_tag("http://cms.example.com")
    }

    #[test]
    fn tag_is_same_origin_with_cms_origin_attr() {
        assert_eq!(
            tag(),
            "<script src=\"/__cms/injected-cms-agent.js\" \
             data-cms-origin=\"http://cms.example.com\" defer></script>"
        );
    }

    #[test]
    fn injects_before_head_close() {
        let html = b"<html><head><title>t</title></head><body>hi</body></html>";
        let out = inject_overlay(html, &tag()).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert_eq!(
            s,
            format!(
                "<html><head><title>t</title>{}</head><body>hi</body></html>",
                tag()
            )
        );
    }

    #[test]
    fn head_close_is_case_insensitive() {
        let html = b"<HTML><HEAD></HEAD><BODY></BODY></HTML>";
        let s = String::from_utf8(inject_overlay(html, &tag()).unwrap()).unwrap();
        assert!(s.contains("defer></script></HEAD>"));
    }

    #[test]
    fn falls_back_to_body_close() {
        let html = b"<html><body>hi</body></html>";
        let s = String::from_utf8(inject_overlay(html, &tag()).unwrap()).unwrap();
        assert!(s.contains("defer></script></body>"));
    }

    #[test]
    fn no_injection_point_returns_none() {
        assert!(inject_overlay(b"just some text, not html", &tag()).is_none());
        assert!(inject_overlay(b"", &tag()).is_none());
        assert!(inject_overlay(b"<html><head>unclosed", &tag()).is_none());
    }
}
