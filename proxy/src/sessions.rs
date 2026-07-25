use napi_derive::napi;
use std::collections::HashMap;
use std::sync::RwLock;

#[napi(object)]
pub struct ActiveSession {
    pub token: String,
    pub expires_at_ms: f64,
}

#[derive(Default)]
pub struct SessionStore {
    sessions: RwLock<HashMap<String, u64>>,
}

impl SessionStore {
    pub fn upsert(&self, session: ActiveSession) {
        if session.expires_at_ms.is_finite() && session.expires_at_ms >= 0.0 {
            self.sessions
                .write()
                .expect("sessions lock poisoned")
                .insert(session.token, session.expires_at_ms as u64);
        }
    }

    pub fn replace(&self, sessions: Vec<ActiveSession>) {
        let sessions = sessions
            .into_iter()
            .filter_map(|session| {
                (session.expires_at_ms.is_finite() && session.expires_at_ms >= 0.0)
                    .then(|| (session.token, session.expires_at_ms as u64))
            })
            .collect();
        *self.sessions.write().expect("sessions lock poisoned") = sessions;
    }

    pub fn is_active(&self, token: &str, now_ms: u64) -> bool {
        self.sessions
            .read()
            .expect("sessions lock poisoned")
            .get(token)
            .is_some_and(|expires| *expires > now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_current_snapshot_and_unexpired_sessions_are_active() {
        let store = SessionStore::default();
        store.replace(vec![ActiveSession {
            token: "a".into(),
            expires_at_ms: 2000.0,
        }]);
        assert!(store.is_active("a", 1999));
        assert!(!store.is_active("a", 2000));
        store.replace(vec![ActiveSession {
            token: "b".into(),
            expires_at_ms: 3000.0,
        }]);
        assert!(!store.is_active("a", 2001));
        assert!(store.is_active("b", 2001));
        store.upsert(ActiveSession {
            token: "c".into(),
            expires_at_ms: 4000.0,
        });
        assert!(store.is_active("c", 2001));
    }
}
