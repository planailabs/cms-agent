//! Edge auth for preview hosts: HMAC-signed `cms_preview` cookie.
//!
//! Cookie value format: `<userId>.<expiresAtMs>.<sigBase64url>` where
//! `sig = HMAC-SHA256(secret, "<userId>.<expiresAtMs>")`, base64url without padding.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, PartialEq)]
pub enum AuthError {
    Malformed,
    BadSignature,
    Expired,
}

/// Verify a `cms_preview` cookie value. Returns the userId on success.
pub fn verify_preview_cookie(value: &str, secret: &[u8], now_ms: u64) -> Result<String, AuthError> {
    // Split from the right so userIds containing '.' still work.
    let (message, sig_b64) = value.rsplit_once('.').ok_or(AuthError::Malformed)?;
    let (user_id, expires_str) = message.rsplit_once('.').ok_or(AuthError::Malformed)?;
    let expires_at_ms: u64 = expires_str.parse().map_err(|_| AuthError::Malformed)?;
    let sig = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| AuthError::Malformed)?;

    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    // Constant-time comparison.
    mac.verify_slice(&sig).map_err(|_| AuthError::BadSignature)?;

    if expires_at_ms <= now_ms {
        return Err(AuthError::Expired);
    }
    Ok(user_id.to_string())
}

/// Extract a cookie value by name from a `Cookie:` header value ("a=b; c=d").
pub fn cookie_value<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    cookie_header.split(';').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k.trim() == name).then(|| v.trim())
    })
}

/// Produce a valid cookie value; used by tests (and handy for debugging).
#[allow(dead_code)]
pub fn sign_preview_cookie(user_id: &str, expires_at_ms: u64, secret: &[u8]) -> String {
    let message = format!("{user_id}.{expires_at_ms}");
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    let sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{message}.{sig}")
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret";

    #[test]
    fn valid_cookie_verifies() {
        let cookie = sign_preview_cookie("user-123", 2_000, SECRET);
        assert_eq!(
            verify_preview_cookie(&cookie, SECRET, 1_000),
            Ok("user-123".to_string())
        );
    }

    #[test]
    fn user_id_with_dots_verifies() {
        let cookie = sign_preview_cookie("user@example.com", 2_000, SECRET);
        assert_eq!(
            verify_preview_cookie(&cookie, SECRET, 1_000),
            Ok("user@example.com".to_string())
        );
    }

    #[test]
    fn expired_cookie_rejected() {
        let cookie = sign_preview_cookie("user-123", 1_000, SECRET);
        assert_eq!(
            verify_preview_cookie(&cookie, SECRET, 1_000),
            Err(AuthError::Expired)
        );
        assert_eq!(
            verify_preview_cookie(&cookie, SECRET, 5_000),
            Err(AuthError::Expired)
        );
    }

    #[test]
    fn tampered_cookie_rejected() {
        let cookie = sign_preview_cookie("user-123", 2_000, SECRET);
        // Tamper with the userId
        let tampered = cookie.replacen("user-123", "user-456", 1);
        assert_eq!(
            verify_preview_cookie(&tampered, SECRET, 1_000),
            Err(AuthError::BadSignature)
        );
        // Tamper with the expiry
        let tampered = cookie.replacen(".2000.", ".9999.", 1);
        assert_eq!(
            verify_preview_cookie(&tampered, SECRET, 1_000),
            Err(AuthError::BadSignature)
        );
        // Wrong secret
        assert_eq!(
            verify_preview_cookie(&cookie, b"other-secret", 1_000),
            Err(AuthError::BadSignature)
        );
    }

    #[test]
    fn malformed_cookie_rejected() {
        for bad in ["", "abc", "a.b", "user.notanumber.c2ln", "user.123.!!!"] {
            assert_eq!(
                verify_preview_cookie(bad, SECRET, 1_000),
                Err(AuthError::Malformed),
                "input: {bad:?}"
            );
        }
    }

    #[test]
    fn cookie_header_parsing() {
        let header = "foo=bar; cms_preview=u.123.sig; baz=qux";
        assert_eq!(cookie_value(header, "cms_preview"), Some("u.123.sig"));
        assert_eq!(cookie_value(header, "foo"), Some("bar"));
        assert_eq!(cookie_value(header, "missing"), None);
        assert_eq!(cookie_value("", "cms_preview"), None);
    }
}
