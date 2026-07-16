//! Last-access timestamps per preview branch, for the CMS's idle-stop logic.
//!
//! In-memory map updated on every preview request; flushed to
//! `${VAR_DIR}/proxy-access.json` at most every 10 seconds (atomic tmp+rename).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct AccessTracker {
    map: Mutex<HashMap<String, u64>>,
    dirty: AtomicBool,
}

impl AccessTracker {
    pub fn new() -> Arc<Self> {
        Arc::new(AccessTracker {
            map: Mutex::new(HashMap::new()),
            dirty: AtomicBool::new(false),
        })
    }

    /// Record a request for `branch` at `now_ms`.
    pub fn touch(&self, branch: &str, now_ms: u64) {
        self.map
            .lock()
            .expect("access lock poisoned")
            .insert(branch.to_string(), now_ms);
        self.dirty.store(true, Ordering::Release);
    }

    /// Write the map to `path` if anything changed since the last flush.
    /// Atomic: writes `<path>.tmp` then renames over `path`.
    pub fn flush_if_dirty(&self, path: &Path) -> std::io::Result<()> {
        if !self.dirty.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        let snapshot = self.map.lock().expect("access lock poisoned").clone();
        let json = serde_json::to_vec(&snapshot).expect("map serializes");
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, &json).and_then(|_| std::fs::rename(&tmp, path)) {
            // retry on next tick
            self.dirty.store(true, Ordering::Release);
            return Err(e);
        }
        Ok(())
    }
}

/// Flush the tracker to disk every 10 seconds on a background thread.
pub fn spawn_flusher(tracker: Arc<AccessTracker>, path: PathBuf) {
    std::thread::Builder::new()
        .name("access-flusher".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(10));
            if let Err(e) = tracker.flush_if_dirty(&path) {
                log::warn!("failed to write {}: {e}", path.display());
            }
        })
        .expect("failed to spawn access flusher thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_and_flush_writes_json_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proxy-access.json");
        let tracker = AccessTracker::new();

        // nothing dirty -> no file
        tracker.flush_if_dirty(&path).unwrap();
        assert!(!path.exists());

        tracker.touch("my-branch", 1234);
        tracker.touch("other", 5678);
        tracker.touch("my-branch", 9999); // latest wins
        tracker.flush_if_dirty(&path).unwrap();

        let data = std::fs::read_to_string(&path).unwrap();
        let map: HashMap<String, u64> = serde_json::from_str(&data).unwrap();
        assert_eq!(map["my-branch"], 9999);
        assert_eq!(map["other"], 5678);
        // no leftover tmp file
        assert!(!path.with_extension("json.tmp").exists());

        // flush again without changes -> file untouched (mtime aside), no error
        tracker.flush_if_dirty(&path).unwrap();
    }
}
