//! Last-access timestamps per preview branch, for the CMS's idle-stop logic.
//!
//! In-memory map updated on every preview request, read by the CMS over
//! N-API. Rust already owns the map and Node already holds the addon for
//! routes and sessions, so the timestamps travel the same way: there is no
//! writer thread, no dirty flag, no temp-file rename and no JSON parse on the
//! Node side for state that never left the process.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::Arc;

pub struct AccessTracker {
    map: Mutex<HashMap<String, u64>>,
}

impl AccessTracker {
    pub fn new() -> Arc<Self> {
        Arc::new(AccessTracker {
            map: Mutex::new(HashMap::new()),
        })
    }

    /// Record a request for `branch` at `now_ms`.
    pub fn touch(&self, branch: &str, now_ms: u64) {
        self.map
            .lock()
            .expect("access lock poisoned")
            .insert(branch.to_string(), now_ms);
    }

    /// Every branch's last access, as (branch, ms) pairs.
    ///
    /// A snapshot rather than a drain: the CMS sweeps on its own schedule and
    /// compares against an idle timeout, so forgetting an entry after reading
    /// it would make the NEXT sweep believe a branch had never been touched.
    pub fn snapshot(&self) -> Vec<(String, u64)> {
        self.map
            .lock()
            .expect("access lock poisoned")
            .iter()
            .map(|(branch, at)| (branch.clone(), *at))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_records_the_latest_time_per_branch() {
        let tracker = AccessTracker::new();
        assert!(tracker.snapshot().is_empty());

        tracker.touch("my-branch", 1234);
        tracker.touch("other", 5678);
        tracker.touch("my-branch", 9999); // latest wins

        let map: HashMap<String, u64> = tracker.snapshot().into_iter().collect();
        assert_eq!(map["my-branch"], 9999);
        assert_eq!(map["other"], 5678);
    }

    #[test]
    fn snapshot_does_not_forget_what_it_returned() {
        // A drain would make the next sweep think the branch was never used.
        let tracker = AccessTracker::new();
        tracker.touch("kept", 42);
        assert_eq!(tracker.snapshot().len(), 1);
        assert_eq!(tracker.snapshot().len(), 1);
    }
}
