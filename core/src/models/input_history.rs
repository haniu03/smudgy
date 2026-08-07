//! Durable recent command history for a server profile.

use std::fs;
use std::io;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::get_smudgy_home;

use super::persistence::write_atomic;

const INPUT_HISTORY_FILE: &str = "input-history.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredInputHistory {
    #[serde(default)]
    commands: Vec<String>,
}

/// Loads the recent command history for a server profile, newest first.
///
/// A missing file is the normal first-session case and returns an empty
/// history. Other read and parse failures are reported so the caller can log
/// them while still opening the session with an empty history.
///
/// # Errors
///
/// Returns an error when the Smudgy home cannot be located, the history file
/// cannot be read, or its JSON cannot be parsed.
pub fn load_input_history(server_name: &str, profile_name: &str) -> Result<Vec<String>> {
    let profile_dir = get_smudgy_home()?
        .join(server_name)
        .join("profiles")
        .join(profile_name);
    load_input_history_in(&profile_dir)
}

/// Saves a server profile's recent command history, newest first.
///
/// The profile directory must already exist. This avoids resurrecting a
/// deleted or renamed profile when a stale live session eventually closes.
///
/// # Errors
///
/// Returns an error when the Smudgy home cannot be located, the profile
/// directory is missing, or the history cannot be serialized and atomically
/// written.
pub fn save_input_history(
    server_name: &str,
    profile_name: &str,
    commands: &[String],
) -> Result<()> {
    let profile_dir = get_smudgy_home()?
        .join(server_name)
        .join("profiles")
        .join(profile_name);
    save_input_history_in(&profile_dir, commands)
}

fn load_input_history_in(profile_dir: &Path) -> Result<Vec<String>> {
    let path = profile_dir.join(INPUT_HISTORY_FILE);
    match fs::read_to_string(&path) {
        Ok(contents) => {
            let stored: StoredInputHistory = serde_json::from_str(&contents)
                .with_context(|| format!("Failed to parse {}", path.display()))?;
            Ok(stored.commands)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error).with_context(|| format!("Failed to read {}", path.display())),
    }
}

fn save_input_history_in(profile_dir: &Path, commands: &[String]) -> Result<()> {
    if !profile_dir.is_dir() {
        anyhow::bail!(
            "Profile directory not found or not a directory: {}",
            profile_dir.display()
        );
    }
    let path = profile_dir.join(INPUT_HISTORY_FILE);
    let contents = serde_json::to_string_pretty(&StoredInputHistory {
        commands: commands.to_vec(),
    })
    .context("Failed to serialize input history")?;
    write_atomic(&path, contents.as_bytes())
        .with_context(|| format!("Failed to write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_history_is_empty() {
        let dir = tempfile::tempdir().expect("temporary directory");
        assert!(
            load_input_history_in(dir.path())
                .expect("missing is valid")
                .is_empty()
        );
    }

    #[test]
    fn history_round_trips_newest_first() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let commands = vec!["say żurek".to_string(), "north".to_string()];

        save_input_history_in(dir.path(), &commands).expect("save history");

        assert_eq!(
            load_input_history_in(dir.path()).expect("load history"),
            commands
        );
    }

    #[test]
    fn malformed_history_is_reported() {
        let dir = tempfile::tempdir().expect("temporary directory");
        fs::write(dir.path().join(INPUT_HISTORY_FILE), "not json").expect("write fixture");

        assert!(load_input_history_in(dir.path()).is_err());
    }

    #[test]
    fn save_does_not_create_a_missing_profile() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let missing = dir.path().join("missing-profile");

        assert!(save_input_history_in(&missing, &["look".to_string()]).is_err());
        assert!(!missing.exists());
    }
}
