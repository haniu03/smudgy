//! The per-server last-session snapshot: `<home>/<server>/last-session.json`.
//!
//! Each server's file holds the most recent arrangement in which that server
//! owned the active session — a footprint-scoped [`dto::Workspace`] template,
//! byte-compatible with named layouts. The autosave pipeline writes it
//! (debounced, checkpointed, quit-flushed) through the workspace writer;
//! nothing here performs a write.
//!
//! Reads are strictly side-effect-free, unlike the named-layout reader: the
//! file is continuously rewritten by autosave, and it is parsed speculatively
//! every time the connect surface lists a server, so a transient problem must
//! neither set the file aside nor touch the disk at all. A file that cannot
//! be used simply offers no restore.

use std::path::{Path, PathBuf};

use super::dto;

/// The per-server snapshot's file name, beside `server.json`, `profiles/`,
/// and `layouts/`.
pub const LAST_SESSION_FILE_NAME: &str = "last-session.json";

/// How many profile names the connect-surface summary spells out before the
/// remainder collapses into an ellipsis.
const SUMMARY_NAMED_LIMIT: usize = 3;

/// The full path of `server`'s last-session snapshot, or `None` when the
/// smudgy home directory cannot be resolved.
#[must_use]
pub fn path(server: &str) -> Option<PathBuf> {
    match smudgy_core::get_smudgy_home() {
        Ok(home) => Some(home.join(server).join(LAST_SESSION_FILE_NAME)),
        Err(err) => {
            log::warn!("[workspace] cannot resolve the smudgy home directory: {err}");
            None
        }
    }
}

/// Read `server`'s last-session template, if a usable one exists: parsed,
/// version-checked, sanitized, and holding at least one window and one
/// session slot (anything less restores nothing and offers nothing).
/// Every failure — missing file, unreadable bytes, malformed JSON, foreign
/// schema version — answers `None` without touching the file.
#[must_use]
pub fn read(server: &str) -> Option<dto::Workspace> {
    read_from(&path(server)?)
}

/// [`read`] against an explicit file path.
#[must_use]
pub fn read_from(path: &Path) -> Option<dto::Workspace> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return None,
        Err(err) => {
            log::info!("[workspace] cannot read {}: {err}", path.display());
            return None;
        }
    };
    let template = match serde_json::from_str::<dto::Workspace>(&raw) {
        Ok(template) => template,
        Err(err) => {
            log::info!(
                "[workspace] {} is not a usable last-session snapshot: {err}",
                path.display()
            );
            return None;
        }
    };
    if template.version != dto::SCHEMA_VERSION {
        log::info!(
            "[workspace] {} is schema version {} (this build speaks {}); not offering it",
            path.display(),
            template.version,
            dto::SCHEMA_VERSION
        );
        return None;
    }
    let template = template.sanitized();
    if template.windows.is_empty() || template.sessions.is_empty() {
        return None;
    }
    Some(template)
}

/// The template's profile names in slot order (slot-list position — the
/// stored ordinal order), for the connect surface's restore summary.
#[must_use]
pub fn profile_names(template: &dto::Workspace) -> Vec<String> {
    template
        .sessions
        .iter()
        .map(|slot| slot.profile.clone())
        .collect()
}

/// Compose the restore affordance's profile summary: names joined in slot
/// order, spelling out at most [`SUMMARY_NAMED_LIMIT`] before the remainder
/// collapses into an ellipsis. `None` for an empty list (nothing to offer).
#[must_use]
pub fn summary(profiles: &[String]) -> Option<String> {
    if profiles.is_empty() {
        return None;
    }
    let mut named: Vec<&str> = profiles
        .iter()
        .take(SUMMARY_NAMED_LIMIT)
        .map(String::as_str)
        .collect();
    if profiles.len() > SUMMARY_NAMED_LIMIT {
        named.push("…");
    }
    Some(named.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temporary directory")
    }

    fn usable() -> String {
        serde_json::json!({
            "version": dto::SCHEMA_VERSION,
            "sessions": [
                {"id": 1, "server": "Arctic", "profile": "Kapusnik", "connect": true},
                {"id": 2, "server": "Arctic", "profile": "Kapusta", "connect": false}
            ],
            "windows": [{
                "id": 1,
                "geometry": {"x": 0.0, "y": 0.0, "width": 800.0, "height": 600.0, "scale": 1.0},
                "clusters": [
                    {"weight": 1.0, "root": {"group": {"tabs": [{"slot": 1, "id": "main"}], "selected": 0}}},
                    {"weight": 1.0, "root": {"group": {"tabs": [{"slot": 2, "id": "main"}], "selected": 0}}}
                ]
            }]
        })
        .to_string()
    }

    #[test]
    fn a_usable_snapshot_reads_with_profiles_in_slot_order() {
        let dir = dir();
        let path = dir.path().join(LAST_SESSION_FILE_NAME);
        std::fs::write(&path, usable()).unwrap();
        let template = read_from(&path).expect("usable snapshot");
        assert_eq!(
            profile_names(&template),
            vec!["Kapusnik".to_string(), "Kapusta".to_string()]
        );
    }

    #[test]
    fn missing_malformed_and_foreign_versions_offer_nothing_and_touch_nothing() {
        let dir = dir();
        let path = dir.path().join(LAST_SESSION_FILE_NAME);
        assert!(read_from(&path).is_none(), "missing file");

        std::fs::write(&path, b"{ not json").unwrap();
        assert!(read_from(&path).is_none(), "malformed file");
        // Unlike the named-layout reader, nothing is set aside: the file is
        // exactly where the autosave writer expects it.
        assert_eq!(std::fs::read(&path).unwrap(), b"{ not json");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);

        std::fs::write(&path, r#"{"version": 9, "sessions": [], "windows": []}"#).unwrap();
        assert!(read_from(&path).is_none(), "foreign schema version");
        assert!(path.exists());
    }

    #[test]
    fn snapshots_without_restorable_content_offer_nothing() {
        let dir = dir();
        let path = dir.path().join(LAST_SESSION_FILE_NAME);
        std::fs::write(
            &path,
            format!(
                r#"{{"version": {}, "sessions": [], "windows": []}}"#,
                dto::SCHEMA_VERSION
            ),
        )
        .unwrap();
        assert!(read_from(&path).is_none());
    }

    #[test]
    fn pipeline_bytes_round_trip_through_the_reader() {
        // Exactly the write half of the autosave pipeline: the captured
        // template serialized as the publisher serializes it (pretty JSON
        // plus trailing newline), delivered through the writer worker, then
        // read back by the connect surface's reader.
        let template: dto::Workspace = serde_json::from_str(&usable()).unwrap();
        let template = template.sanitized();
        let mut bytes = serde_json::to_vec_pretty(&template).unwrap();
        bytes.push(b'\n');

        let dir = dir();
        let path = dir.path().join(LAST_SESSION_FILE_NAME);
        let writer = super::super::writer::Writer::new();
        let (ack, done) = tokio::sync::oneshot::channel();
        writer.publish(
            1,
            path.clone(),
            std::sync::Arc::from(bytes.as_slice()),
            Some(ack),
        );
        done.blocking_recv().expect("worker acknowledges");

        let read_back = read_from(&path).expect("the written snapshot reads back");
        assert_eq!(read_back, template);
        assert_eq!(
            profile_names(&read_back),
            vec!["Kapusnik".to_string(), "Kapusta".to_string()]
        );
    }

    #[test]
    fn summaries_spell_out_few_names_and_truncate_many() {
        let names = |list: &[&str]| -> Vec<String> {
            list.iter().map(|name| (*name).to_string()).collect()
        };
        assert_eq!(summary(&[]), None);
        assert_eq!(summary(&names(&["Kapusnik"])), Some("Kapusnik".to_string()));
        assert_eq!(
            summary(&names(&["Kapusnik", "Kapusta"])),
            Some("Kapusnik, Kapusta".to_string())
        );
        assert_eq!(
            summary(&names(&["a", "b", "c", "d", "e"])),
            Some("a, b, c, …".to_string())
        );
    }
}
