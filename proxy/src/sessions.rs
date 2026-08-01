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

    /// Forget one session immediately (sign-out, deletion, revocation).
    ///
    /// Without this the only thing that ever removed a session was the CMS
    /// replacing the whole snapshot on its reconciliation tick, so a signed-out
    /// cookie kept opening previews until the next sweep. Revocation is a
    /// security operation; it should not wait for a poll.
    pub fn forget(&self, token: &str) {
        self.sessions
            .write()
            .expect("sessions lock poisoned")
            .remove(token);
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
    fn forget_revokes_immediately() {
        let store = SessionStore::default();
        store.upsert(ActiveSession {
            token: "gone".into(),
            expires_at_ms: 9999.0,
        });
        assert!(store.is_active("gone", 0));
        store.forget("gone");
        // Not "expired later" — gone now, without waiting for a reconcile.
        assert!(!store.is_active("gone", 0));
        // Forgetting something absent is not an error (double sign-out).
        store.forget("never-existed");
    }

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
