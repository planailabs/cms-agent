//! HTML overlay injection: add `<script src="..." defer></script>` before `</head>`
//! (case-insensitive), falling back to `</body>`. If neither exists, skip.

/// Returns the rewritten HTML, or None when there is no injection point
/// (caller should pass the body through unmodified).
pub fn inject_overlay(html: &[u8], overlay_url: &str) -> Option<Vec<u8>> {
    let pos = find_ci(html, b"</head>").or_else(|| find_ci(html, b"</body>"))?;
    let tag = format!(r#"<script src="{overlay_url}" defer></script>"#);
    let mut out = Vec::with_capacity(html.len() + tag.len());
    out.extend_from_slice(&html[..pos]);
    out.extend_from_slice(tag.as_bytes());
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

    const URL: &str = "http://cms.example.com/preview-overlay.js";

    #[test]
    fn injects_before_head_close() {
        let html = b"<html><head><title>t</title></head><body>hi</body></html>";
        let out = inject_overlay(html, URL).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert_eq!(
            s,
            "<html><head><title>t</title>\
             <script src=\"http://cms.example.com/preview-overlay.js\" defer></script>\
             </head><body>hi</body></html>"
        );
    }

    #[test]
    fn head_close_is_case_insensitive() {
        let html = b"<HTML><HEAD></HEAD><BODY></BODY></HTML>";
        let s = String::from_utf8(inject_overlay(html, URL).unwrap()).unwrap();
        assert!(s.contains("defer></script></HEAD>"));
    }

    #[test]
    fn falls_back_to_body_close() {
        let html = b"<html><body>hi</body></html>";
        let s = String::from_utf8(inject_overlay(html, URL).unwrap()).unwrap();
        assert!(s.contains("defer></script></body>"));
    }

    #[test]
    fn no_injection_point_returns_none() {
        assert!(inject_overlay(b"just some text, not html", URL).is_none());
        assert!(inject_overlay(b"", URL).is_none());
        assert!(inject_overlay(b"<html><head>unclosed", URL).is_none());
    }
}
