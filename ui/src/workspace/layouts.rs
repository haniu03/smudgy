//! The per-server named-layout store: `<home>/<server>/layouts/<name>.json`.
//!
//! A named layout is a [`dto::Workspace`] template, byte-compatible with
//! the per-server `last-session.json` snapshots (same schema, same
//! version). Unlike those it is written only on explicit save — a direct
//! atomic write, never through the autosave writer — and it is filed under
//! the server that owns it, so conventional names ("combat", "peace")
//! never collide across servers and deleting a server removes its layouts
//! with it.
//!
//! Names are validated by [`naming::validate_name`] — the automation/module
//! validator, which rejects path separators, traversal, control characters,
//! and Windows device names — NOT the pane-name rules, which permit
//! separators. On top of validation, every write resolves through
//! [`contained`], which canonicalizes and verifies the destination's parent
//! is the `layouts/` directory itself: a name that validated but still
//! escaped could only reach disk through a bug, and the containment check
//! turns that bug into an error instead of a stray file.
//!
//! Names fold case-insensitively ([`fold`], matching
//! [`naming::names_conflict`]): two names folding to the same string are the
//! same layout and resolve to the same file, whatever the filesystem's own
//! case sensitivity. The display casing of the first save is kept as the
//! file stem; a later save under a different casing overwrites the same
//! file without renaming it.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use smudgy_core::models::naming;
use smudgy_core::models::persistence::write_atomic;

use super::{dto, file};

/// The per-server directory named layouts live in, beside `server.json` and
/// `profiles/`.
pub const LAYOUTS_DIR_NAME: &str = "layouts";

/// Why a store operation failed, in user-presentable terms.
#[derive(Debug)]
pub enum LayoutStoreError {
    /// The name failed [`naming::validate_name`]; the payload is the
    /// validator's human-readable reason.
    InvalidName(String),
    /// No layout resolves to this name for the server.
    NotFound(String),
    /// The layout file exists but holds no usable windows (malformed files
    /// are set aside by the reader; an empty-but-valid template is equally
    /// unusable as a layout).
    Unusable(String),
    /// The resolved destination escaped the `layouts/` directory.
    OutsideStore,
    Io(io::Error),
}

impl std::fmt::Display for LayoutStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidName(reason) => write!(f, "{reason}"),
            Self::NotFound(name) => write!(f, "no layout named '{name}'"),
            Self::Unusable(name) => write!(f, "layout '{name}' holds no usable windows"),
            Self::OutsideStore => write!(f, "layout path escapes the layouts directory"),
            Self::Io(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for LayoutStoreError {}

impl From<io::Error> for LayoutStoreError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

/// The identity fold for layout names — the same fold
/// [`naming::names_conflict`] applies, so an in-app uniqueness answer and an
/// on-disk collision can never disagree.
#[must_use]
pub fn fold(name: &str) -> String {
    name.trim().to_lowercase()
}

/// The `layouts/` directory for `server`, or `None` when the smudgy home
/// cannot be resolved. The directory itself is created lazily by writes;
/// reads treat a missing directory as an empty store.
#[must_use]
pub fn layouts_dir(server: &str) -> Option<PathBuf> {
    match smudgy_core::get_smudgy_home() {
        Ok(home) => Some(home.join(server).join(LAYOUTS_DIR_NAME)),
        Err(err) => {
            log::info!("[layouts] cannot resolve the smudgy home directory: {err}");
            None
        }
    }
}

/// Validate `name` and hand back its trimmed form.
fn validated(name: &str) -> Result<&str, LayoutStoreError> {
    naming::validate_name(name).map_err(LayoutStoreError::InvalidName)?;
    Ok(name.trim())
}

/// The path a fresh layout file for `name` would occupy in `dir`. The name
/// must already be validated; the stem keeps the caller's display casing.
fn fresh_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.json"))
}

/// Verify that `path` (whose file may not exist yet) resolves inside `dir`:
/// canonicalize both the directory and the candidate's parent and require
/// them equal. Runs after name validation as defense in depth — validation
/// already rejects separators and traversal, so a failure here is a bug
/// surfacing as an error rather than as a stray file.
fn contained(dir: &Path, path: &Path) -> Result<(), LayoutStoreError> {
    let canonical_dir = dir.canonicalize()?;
    let canonical_parent = path
        .parent()
        .ok_or(LayoutStoreError::OutsideStore)?
        .canonicalize()?;
    if canonical_parent == canonical_dir {
        Ok(())
    } else {
        Err(LayoutStoreError::OutsideStore)
    }
}

/// The existing file in `dir` whose stem folds equal to `name`, if any —
/// the resolution step that makes case variants the same layout.
fn resolve_in(dir: &Path, name: &str) -> Option<PathBuf> {
    let folded = fold(name);
    for entry in fs::read_dir(dir).ok()? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if fold(stem) == folded {
            return Some(path);
        }
    }
    None
}

/// The stored layout names in `dir` (display casing as saved), sorted by
/// their case-folded form. A missing directory is an empty store. Stems
/// that fail [`naming::validate_name`] are filtered out: every store
/// operation validates its name first, so such a file could never be
/// loaded, renamed, or deleted through the store — listing it would only
/// offer an entry no action can address.
#[must_use]
pub fn list_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                if !path.is_file()
                    || !path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
                {
                    return None;
                }
                let stem = path.file_stem()?.to_str()?;
                if naming::validate_name(stem).is_err() {
                    return None;
                }
                Some(stem.to_string())
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    names.sort_by_key(|name| fold(name));
    names
}

/// Whether a layout resolving to `name` exists in `dir`.
#[must_use]
pub fn exists_in(dir: &Path, name: &str) -> bool {
    validated(name)
        .ok()
        .and_then(|name| resolve_in(dir, name))
        .is_some()
}

/// Save `workspace` as the layout `name` in `dir`, creating the directory
/// as needed. A name folding onto an existing layout overwrites that
/// layout's file (same layout, whatever the casing); otherwise the file
/// takes the caller's display casing as its stem. The write goes through
/// the canonical atomic replace directly — explicit save, never the
/// autosave writer.
pub fn save_in(dir: &Path, name: &str, workspace: &dto::Workspace) -> Result<(), LayoutStoreError> {
    let name = validated(name)?;
    let bytes = serialize(workspace)?;
    let path = write_resolved(dir, name, &bytes)?;
    log::info!(
        "[layouts] saved layout '{name}' ({} bytes) to {}",
        bytes.len(),
        path.display()
    );
    Ok(())
}

/// Serialize `workspace` into the store's canonical bytes: pretty JSON
/// with a trailing newline, byte-identical to what [`save_in`] writes.
fn serialize(workspace: &dto::Workspace) -> Result<Vec<u8>, LayoutStoreError> {
    let mut bytes = serde_json::to_vec_pretty(workspace)
        .map_err(|err| LayoutStoreError::Io(io::Error::new(io::ErrorKind::InvalidData, err)))?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Resolve `name`'s destination in `dir` — the existing fold-matching file
/// if any, else a fresh stem in the caller's display casing — and write
/// `bytes` there atomically, creating the directory as needed. Resolution
/// happens here, at write time, so deferred writes of the same folded name
/// can never fan out into casing siblings.
fn write_resolved(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, LayoutStoreError> {
    fs::create_dir_all(dir)?;
    let path = resolve_in(dir, name).unwrap_or_else(|| fresh_path(dir, name));
    contained(dir, &path)?;
    write_atomic(&path, bytes)?;
    Ok(path)
}

/// Load the layout resolving to `name` from `dir`, sanitized. Malformed or
/// wrong-version files degrade exactly like the workspace mirror (set
/// aside, never destroyed); a file that degrades to zero windows is
/// reported [`LayoutStoreError::Unusable`] rather than applied as a no-op.
pub fn load_in(dir: &Path, name: &str) -> Result<dto::Workspace, LayoutStoreError> {
    let name = validated(name)?;
    let path = resolve_in(dir, name).ok_or_else(|| LayoutStoreError::NotFound(name.to_string()))?;
    let workspace = file::load_from(&path);
    if workspace.windows.is_empty() {
        return Err(LayoutStoreError::Unusable(name.to_string()));
    }
    Ok(workspace)
}

/// Rename the layout resolving to `old` to `new`. A `new` folding equal to
/// `old` is a pure casing change of the same layout. A `new` folding onto a
/// *different* existing layout replaces it (callers confirm first) by
/// renaming the source directly over the displaced file: one atomic
/// replacement, so no crash can lose the displaced layout while the source
/// still stands under its old name. The displaced file's stem — and with it
/// its display casing — survives, exactly as a fold-matching save keeps the
/// first-saved stem.
pub fn rename_in(dir: &Path, old: &str, new: &str) -> Result<(), LayoutStoreError> {
    let old = validated(old)?;
    let new = validated(new)?;
    let source = resolve_in(dir, old).ok_or_else(|| LayoutStoreError::NotFound(old.to_string()))?;
    let target = match resolve_in(dir, new) {
        // A distinct displaced layout: rename atomically over its file. A
        // fold-equal resolution is the source itself — a casing change —
        // which renames to the fresh stem instead.
        Some(displaced) if displaced != source => displaced,
        _ => fresh_path(dir, new),
    };
    contained(dir, &target)?;
    fs::rename(&source, &target)?;
    log::info!(
        "[layouts] renamed layout '{old}' to '{new}' ({} -> {})",
        source.display(),
        target.display()
    );
    Ok(())
}

/// Delete the layout resolving to `name`.
pub fn delete_in(dir: &Path, name: &str) -> Result<(), LayoutStoreError> {
    let name = validated(name)?;
    let path = resolve_in(dir, name).ok_or_else(|| LayoutStoreError::NotFound(name.to_string()))?;
    fs::remove_file(&path)?;
    log::info!("[layouts] deleted layout '{name}' ({})", path.display());
    Ok(())
}

/// [`list_in`] against `server`'s store. A server whose store cannot be
/// resolved lists nothing.
#[must_use]
pub fn list(server: &str) -> Vec<String> {
    layouts_dir(server).map_or_else(Vec::new, |dir| list_in(&dir))
}

/// [`load_in`] against `server`'s store.
pub fn load(server: &str, name: &str) -> Result<dto::Workspace, LayoutStoreError> {
    let dir = layouts_dir(server).ok_or(LayoutStoreError::OutsideStore)?;
    load_in(&dir, name)
}

/// [`save_in`] against `server`'s store.
pub fn save(server: &str, name: &str, workspace: &dto::Workspace) -> Result<(), LayoutStoreError> {
    let dir = layouts_dir(server).ok_or(LayoutStoreError::OutsideStore)?;
    save_in(&dir, name, workspace)
}

/// [`rename_in`] against `server`'s store.
pub fn rename(server: &str, old: &str, new: &str) -> Result<(), LayoutStoreError> {
    let dir = layouts_dir(server).ok_or(LayoutStoreError::OutsideStore)?;
    rename_in(&dir, old, new)
}

/// [`delete_in`] against `server`'s store.
pub fn delete(server: &str, name: &str) -> Result<(), LayoutStoreError> {
    let dir = layouts_dir(server).ok_or(LayoutStoreError::OutsideStore)?;
    delete_in(&dir, name)
}

/// [`exists_in`] against `server`'s store.
#[must_use]
pub fn exists(server: &str, name: &str) -> bool {
    layouts_dir(server).is_some_and(|dir| exists_in(&dir, name))
}

// ---------------------------------------------------------------------
// Deferred saves
// ---------------------------------------------------------------------

/// A background writer for script-initiated saves, keeping the
/// fsync-bearing atomic write off the update thread. Validation and
/// serialization stay on the caller's thread (the captured snapshot must
/// be consistent with the cycle that took it — and a bad name still fails
/// synchronously); only the disk write is deferred.
///
/// Writes coalesce per layout identity (store directory + folded name)
/// with a trailing debounce: a burst of saves of the same name — a
/// `layout.save` in a per-line trigger, say — performs one write once the
/// burst pauses, and the latest snapshot wins. A sustained burst cannot
/// defer the write forever: total deferral is capped, after which the
/// newest snapshot so far is flushed and the next save starts a new burst.
///
/// Deferred writes are best-effort by contract: dropping the saver
/// disconnects the queue and joins the worker, which flushes everything
/// still pending on the way out — but a crash before the flush loses
/// whatever was deferred, and write failures are logged, not reported to
/// the script.
#[derive(Debug)]
pub struct DebouncedSaver {
    sender: Option<mpsc::Sender<SaveRequest>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

/// One deferred save as submitted: destination resolution happens at
/// write time, so a burst under a fresh name cannot fan out into casing
/// siblings.
struct SaveRequest {
    dir: PathBuf,
    name: String,
    bytes: Vec<u8>,
}

/// One coalesced save awaiting its flush.
struct PendingSave {
    dir: PathBuf,
    name: String,
    bytes: Vec<u8>,
    /// When the trailing debounce elapses (pushed back by each new save).
    due: Instant,
    /// The deferral cap: the flush happens no later than this, however
    /// steadily new saves arrive.
    deadline: Instant,
}

/// The trailing quiet period a save waits for before it is written.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);

/// The cap on total deferral under a sustained burst, as a multiple of the
/// debounce period.
const SAVE_MAX_DEFERRAL_FACTOR: u32 = 10;

impl DebouncedSaver {
    /// A saver with the production debounce period.
    #[must_use]
    pub fn new() -> Self {
        Self::with_debounce(SAVE_DEBOUNCE)
    }

    /// A saver with an explicit debounce period (tests use a short one).
    #[must_use]
    pub fn with_debounce(debounce: Duration) -> Self {
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("layout-saves".to_string())
            .spawn(move || saver_worker(&receiver, debounce))
            .expect("the layout-save worker thread spawns");
        Self {
            sender: Some(sender),
            worker: Some(worker),
        }
    }

    /// Validate `name`, serialize `workspace`, and queue the write for
    /// `dir`. Errors are the synchronous ones only (a rejected name, an
    /// unserializable template); the write itself is deferred and
    /// best-effort.
    pub fn submit(
        &self,
        dir: PathBuf,
        name: &str,
        workspace: &dto::Workspace,
    ) -> Result<(), LayoutStoreError> {
        let name = validated(name)?.to_string();
        let bytes = serialize(workspace)?;
        if let Some(sender) = &self.sender {
            // A send failure means the worker is gone (it never exits
            // while the sender lives, so this is unreachable in practice);
            // the write is best-effort, so it degrades to a dropped save.
            let _ = sender.send(SaveRequest { dir, name, bytes });
        }
        Ok(())
    }
}

impl Default for DebouncedSaver {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for DebouncedSaver {
    fn drop(&mut self) {
        // Disconnect the queue; the worker flushes everything still
        // pending and exits, and the join makes that flush happen-before
        // the drop returns.
        drop(self.sender.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// The saver's worker loop: coalesce incoming requests per (directory,
/// folded name), flush each once its debounce elapses or its deferral cap
/// is hit, and flush everything on disconnect.
fn saver_worker(receiver: &mpsc::Receiver<SaveRequest>, debounce: Duration) {
    let max_deferral = debounce.saturating_mul(SAVE_MAX_DEFERRAL_FACTOR);
    let mut pending: HashMap<(PathBuf, String), PendingSave> = HashMap::new();
    loop {
        let now = Instant::now();
        pending.retain(|_, save| {
            if save.due > now && save.deadline > now {
                return true;
            }
            flush_save(save);
            false
        });
        let wait = pending
            .values()
            .map(|save| save.due.min(save.deadline))
            .min()
            .map(|next| next.saturating_duration_since(now));
        let received = match wait {
            Some(wait) => match receiver.recv_timeout(wait) {
                Ok(request) => Some(request),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            },
            None => match receiver.recv() {
                Ok(request) => Some(request),
                Err(mpsc::RecvError) => break,
            },
        };
        if let Some(request) = received {
            let now = Instant::now();
            let key = (request.dir.clone(), fold(&request.name));
            match pending.entry(key) {
                // The latest snapshot (and display casing) wins; the
                // debounce trails the newest save, under the cap.
                std::collections::hash_map::Entry::Occupied(mut entry) => {
                    let save = entry.get_mut();
                    save.name = request.name;
                    save.bytes = request.bytes;
                    save.due = now + debounce;
                }
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(PendingSave {
                        dir: request.dir,
                        name: request.name,
                        bytes: request.bytes,
                        due: now + debounce,
                        deadline: now + max_deferral,
                    });
                }
            }
        }
    }
    for save in pending.values() {
        flush_save(save);
    }
}

/// Write one coalesced save, logging rather than reporting: the deferred
/// path has no caller left to hear an error.
fn flush_save(save: &PendingSave) {
    match write_resolved(&save.dir, &save.name, &save.bytes) {
        Ok(path) => log::info!(
            "[layouts] saved layout '{}' ({} bytes) to {}",
            save.name,
            save.bytes.len(),
            path.display()
        ),
        Err(error) => log::warn!(
            "[layouts] deferred save of layout '{}' failed: {error}",
            save.name
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_workspace() -> dto::Workspace {
        serde_json::from_value(serde_json::json!({
            "version": dto::SCHEMA_VERSION,
            "sessions": [{"id": 1, "server": "Arctic", "profile": "imm", "connect": true}],
            "windows": [{
                "id": 1,
                "geometry": {"x": 0.0, "y": 0.0, "width": 800.0, "height": 600.0, "scale": 1.0},
                "clusters": [{"weight": 1.0, "root": {"group": {
                    "tabs": [{"slot": 1, "id": "main"}], "selected": 0
                }}}]
            }]
        }))
        .expect("minimal workspace parses")
    }

    fn store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temporary directory");
        let layouts = dir.path().join(LAYOUTS_DIR_NAME);
        (dir, layouts)
    }

    #[test]
    fn save_load_round_trips_and_lists_sorted() {
        let (_root, dir) = store();
        let workspace = minimal_workspace();
        save_in(&dir, "Peace", &workspace).expect("save");
        save_in(&dir, "combat", &workspace).expect("save");
        assert_eq!(
            list_in(&dir),
            vec!["combat".to_string(), "Peace".to_string()]
        );
        let loaded = load_in(&dir, "peace").expect("case-folded resolution");
        assert_eq!(loaded, workspace);
    }

    #[test]
    fn case_variants_are_the_same_layout_and_keep_the_first_stem() {
        let (_root, dir) = store();
        let workspace = minimal_workspace();
        save_in(&dir, "Combat", &workspace).expect("save");
        // A different casing overwrites the same file rather than minting a
        // sibling; the original stem stands.
        save_in(&dir, "COMBAT", &workspace).expect("overwrite");
        assert_eq!(list_in(&dir), vec!["Combat".to_string()]);
        assert!(exists_in(&dir, "combat"));
    }

    #[test]
    fn invalid_names_are_rejected_before_any_disk_access() {
        let (_root, dir) = store();
        let workspace = minimal_workspace();
        for name in ["", "a/b", "a\\b", "..", "con", "trailing.", "a\tb"] {
            assert!(
                matches!(
                    save_in(&dir, name, &workspace),
                    Err(LayoutStoreError::InvalidName(_))
                ),
                "should reject {name:?}"
            );
        }
        // Nothing was created — not even the layouts directory.
        assert!(!dir.exists());
    }

    #[test]
    fn spaces_and_punctuation_are_valid_layout_names() {
        let (_root, dir) = store();
        let workspace = minimal_workspace();
        save_in(&dir, "Combat (PvP)", &workspace).expect("permissive names save");
        assert!(exists_in(&dir, "combat (pvp)"));
        load_in(&dir, "Combat (PvP)").expect("load");
    }

    #[test]
    fn missing_layouts_are_not_found_and_missing_stores_list_empty() {
        let (_root, dir) = store();
        assert!(list_in(&dir).is_empty());
        assert!(matches!(
            load_in(&dir, "ghost"),
            Err(LayoutStoreError::NotFound(_))
        ));
        assert!(matches!(
            delete_in(&dir, "ghost"),
            Err(LayoutStoreError::NotFound(_))
        ));
    }

    #[test]
    fn malformed_files_are_set_aside_and_reported_unusable() {
        let (_root, dir) = store();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("broken.json"), b"{ not json").unwrap();
        assert!(matches!(
            load_in(&dir, "broken"),
            Err(LayoutStoreError::Unusable(_))
        ));
        // The reader set the evidence aside; the store no longer lists it.
        assert!(dir.join("broken.json.invalid").exists());
        assert!(list_in(&dir).is_empty());
    }

    #[test]
    fn rename_changes_casing_in_place_and_replaces_a_distinct_target() {
        let (_root, dir) = store();
        let workspace = minimal_workspace();
        save_in(&dir, "combat", &workspace).expect("save");
        rename_in(&dir, "combat", "Combat").expect("casing rename");
        assert_eq!(list_in(&dir), vec!["Combat".to_string()]);

        // Replacing a distinct layout renames atomically over its file, so
        // the displaced stem (and its casing) stands — the same rule a
        // fold-matching save follows.
        save_in(&dir, "peace", &workspace).expect("save");
        rename_in(&dir, "Combat", "PEACE").expect("replacing rename");
        assert_eq!(list_in(&dir), vec!["peace".to_string()]);
        load_in(&dir, "PEACE").expect("the replaced layout resolves by fold");
    }

    #[test]
    fn invalid_stems_are_filtered_from_listings() {
        let (_root, dir) = store();
        let workspace = minimal_workspace();
        save_in(&dir, "combat", &workspace).expect("save");
        // A trailing-dot stem fails the naming rule: no store operation
        // could ever address it, so the listing must not offer it.
        fs::write(dir.join("bad..json"), b"{}").unwrap();
        assert_eq!(list_in(&dir), vec!["combat".to_string()]);
    }

    #[test]
    fn deferred_saves_coalesce_per_folded_name_with_the_latest_bytes_winning() {
        let (_root, dir) = store();
        let saver = DebouncedSaver::with_debounce(Duration::from_millis(20));
        let first = minimal_workspace();
        let mut second = minimal_workspace();
        second.sessions[0].profile = "alt".to_string();
        // A burst of case variants of one name: one file, latest bytes.
        saver
            .submit(dir.clone(), "Combat", &first)
            .expect("first submit");
        saver
            .submit(dir.clone(), "COMBAT", &second)
            .expect("second submit");
        // Dropping the saver joins the worker after its flush, making the
        // outcome deterministic without waiting out the debounce.
        drop(saver);
        // A coalesced burst behaves as if only its last save happened, so
        // the surviving save's casing mints the stem.
        assert_eq!(list_in(&dir), vec!["COMBAT".to_string()]);
        let loaded = load_in(&dir, "combat").expect("load");
        assert_eq!(loaded, second, "the latest snapshot won");
    }

    #[test]
    fn deferred_saves_reject_invalid_names_synchronously() {
        let (_root, dir) = store();
        let saver = DebouncedSaver::with_debounce(Duration::from_millis(20));
        assert!(matches!(
            saver.submit(dir.clone(), "a/b", &minimal_workspace()),
            Err(LayoutStoreError::InvalidName(_))
        ));
        drop(saver);
        assert!(!dir.exists(), "nothing was queued, nothing was written");
    }

    #[test]
    fn fold_agrees_with_core_and_the_naming_conflict_rule() {
        use smudgy_core::models::naming;
        use smudgy_core::session::runtime::layout_fold;
        // Names chosen to stress trimming, ASCII case, and the multi-byte
        // lowercasings where naive folds drift apart. The three folds —
        // this store's, core's layout-op fold, and the one
        // `names_conflict` applies — are independent implementations that
        // must be the same function, or an in-app uniqueness answer and an
        // on-disk collision could disagree; this test is what pins their
        // agreement.
        let tricky = [
            "combat",
            "COMBAT",
            "  padded  ",
            "Combat (PvP)",
            "Straße",
            "STRASSE",
            "İstanbul",
            "istanbul",
            "ΣΟΦΟΣ",
            "σοφος",
        ];
        for name in tricky {
            assert_eq!(fold(name), layout_fold(name), "folds diverge on {name:?}");
        }
        for a in tricky {
            for b in tricky {
                assert_eq!(
                    naming::names_conflict(a, b),
                    fold(a) == fold(b),
                    "conflict rule diverges on {a:?} vs {b:?}"
                );
            }
        }
    }

    #[test]
    fn delete_removes_by_folded_resolution() {
        let (_root, dir) = store();
        let workspace = minimal_workspace();
        save_in(&dir, "Combat", &workspace).expect("save");
        delete_in(&dir, "cOmBaT").expect("delete resolves case-insensitively");
        assert!(list_in(&dir).is_empty());
    }

    #[test]
    fn non_json_neighbors_are_invisible_to_the_store() {
        let (_root, dir) = store();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notes.txt"), b"not a layout").unwrap();
        fs::create_dir_all(dir.join("sub.json")).unwrap();
        assert!(list_in(&dir).is_empty());
        assert!(!exists_in(&dir, "notes"));
    }
}
