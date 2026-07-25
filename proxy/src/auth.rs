//! Verification of Better Auth's signed session cookie.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, PartialEq)]
pub enum AuthError {
    Malformed,
    BadSignature,
}

/// Verify Better Auth's `<session token>.<base64 HMAC>` cookie and return its
/// database session token. Database presence and expiry are checked separately.
pub fn verify_session_cookie(value: &str, secret: &[u8]) -> Result<String, AuthError> {
    let decoded = urlencoding::decode(value).map_err(|_| AuthError::Malformed)?;
    let (token, signature) = decoded.rsplit_once('.').ok_or(AuthError::Malformed)?;
    if token.is_empty() {
        return Err(AuthError::Malformed);
    }
    let signature = STANDARD
        .decode(signature)
        .map_err(|_| AuthError::Malformed)?;
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(token.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| AuthError::BadSignature)?;
    Ok(token.to_string())
}

pub fn cookie_value<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    cookie_header.split(';').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key.trim() == name).then(|| value.trim())
    })
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret";

    fn cookie(token: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(SECRET).unwrap();
        mac.update(token.as_bytes());
        let signature = STANDARD.encode(mac.finalize().into_bytes());
        urlencoding::encode(&format!("{token}.{signature}")).into_owned()
    }

    #[test]
    fn verifies_better_auth_cookie() {
        assert_eq!(
            verify_session_cookie(&cookie("session-token"), SECRET),
            Ok("session-token".into())
        );
    }

    #[test]
    fn rejects_tampering_and_malformed_values() {
        assert_eq!(
            verify_session_cookie(&cookie("session-token"), b"wrong"),
            Err(AuthError::BadSignature)
        );
        assert_eq!(
            verify_session_cookie("missing-signature", SECRET),
            Err(AuthError::Malformed)
        );
        assert_eq!(
            verify_session_cookie(".%3D", SECRET),
            Err(AuthError::Malformed)
        );
    }

    #[test]
    fn extracts_cookie_from_header() {
        let header = "foo=bar; __Secure-better-auth.session_token=abc%3D; baz=qux";
        assert_eq!(
            cookie_value(header, "__Secure-better-auth.session_token"),
            Some("abc%3D")
        );
    }
}
