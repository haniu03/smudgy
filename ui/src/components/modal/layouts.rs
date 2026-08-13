//! The Layouts menu: browsing, applying, and curating the active session's
//! server's named layouts.
//!
//! The modal is a small state machine over the per-server store. Browsing
//! lists the layouts (clicking a name applies it — the full user flow);
//! each entry offers overwrite-with-current, rename, and delete, every
//! destructive step behind an explicit confirmation stage. "Save current
//! as…" and Reset run through the same stages. Store reads and the local
//! disk operations (rename, delete) happen here directly; anything that
//! spans windows or sessions — capture-and-save, apply, reset — is emitted
//! as an [`Event`] for the daemon.
//!
//! The keep-or-close stage is entered from the outside: a user apply whose
//! projection finds live sessions the layout omits routes its questions
//! back into the open modal, every session defaulting to Keep — closing is
//! never silent, only an explicitly toggled row closes.
//!
//! There is deliberately no current-layout indicator and no dirty tracking:
//! applying is a one-shot stamp, and script churn would stale any tracked
//! state within seconds.

use std::path::PathBuf;

use iced::widget::{Id, button, column, container, operation, row, scrollable, text, text_input};
use iced::{Length, Task};
use smudgy_core::session::SessionId;

use crate::i18n::{t, ts};
use crate::theme::{self, Element};
use crate::workspace::TemplateSource;
use crate::workspace::layouts;

/// Stable widget id for the name input of the save-as/rename stages, so
/// opening the stage can move keyboard focus into it.
fn name_input_id() -> Id {
    Id::new("layouts-name-input")
}

/// One live session the layout being applied omits, awaiting its
/// keep-or-close answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmittedRow {
    pub session: SessionId,
    /// Presentation label ("profile on server"), built by the daemon from
    /// the session store.
    pub label: String,
    /// The explicit answer; `false` (keep) until the user toggles it.
    pub close: bool,
}

/// Outcome of the daemon-side save, reported back into the open modal so a
/// partial capture is annotated rather than silent.
#[derive(Debug, Clone, PartialEq)]
pub enum SaveOutcome {
    Saved {
        name: String,
        /// Placeholder tabs the capture had to leave out (retained
        /// vacancies and panes that could not round-trip).
        omitted: usize,
    },
    Failed {
        error: String,
    },
}

/// What confirming the overwrite stage performs: saving the current
/// footprint over the target layout, or renaming an existing layout over
/// it. Both replace the target, so both share the stage and its wording.
#[derive(Debug, Clone, PartialEq)]
enum OverwriteAction {
    Save,
    Rename { from: String },
}

/// Which stage the modal is in.
#[derive(Debug, Clone, PartialEq)]
enum Stage {
    Browse,
    SaveAs {
        name: String,
        error: Option<String>,
    },
    ConfirmOverwrite {
        name: String,
        action: OverwriteAction,
    },
    Rename {
        from: String,
        to: String,
        error: Option<String>,
    },
    ConfirmDelete {
        name: String,
    },
    ConfirmReset,
    KeepOrClose {
        source: TemplateSource,
        rows: Vec<OmittedRow>,
    },
}

#[derive(Debug)]
pub struct State {
    /// The owning server (the active session's) — layouts resolve against
    /// its store and nothing else.
    server: String,
    /// The server's `layouts/` directory; `None` when the home directory
    /// cannot be resolved (the store lists empty and writes fail loudly).
    dir: Option<PathBuf>,
    layouts: Vec<String>,
    stage: Stage,
    /// The last save's outcome, shown as a status line while browsing.
    outcome: Option<SaveOutcome>,
}

#[derive(Debug, Clone)]
pub enum Message {
    ApplyPressed(String),
    SaveAsPressed,
    NameChanged(String),
    SaveAsConfirmed,
    OverwritePressed(String),
    OverwriteConfirmed,
    RenamePressed(String),
    RenameConfirmed,
    DeletePressed(String),
    DeleteConfirmed,
    ResetPressed,
    ResetConfirmed,
    /// Cancel the current stage back to browsing.
    Back,
    ToggleClose(SessionId, bool),
    KeepOrCloseConfirmed,
}

/// What the modal asks the daemon to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// Apply `name` (the full user flow; the daemon may route questions
    /// back through [`State::prompt_keep_or_close`]).
    Apply { name: String },
    /// Re-run a prompted apply — of a named layout or a last-session
    /// restore — with every omitted session explicitly answered.
    ApplyWithAnswers {
        source: TemplateSource,
        close: Vec<SessionId>,
        keep: Vec<SessionId>,
    },
    /// Capture the owning server's footprint and save it as `name`.
    Save { name: String },
    /// Release the active session's retained slot geometry and re-place
    /// its panes from current script definitions.
    Reset,
}

impl State {
    /// Open the menu over `server`'s store, listing synchronously so the
    /// modal renders populated.
    #[must_use]
    pub fn opening(server: String) -> Self {
        let dir = layouts::layouts_dir(&server);
        Self::with_dir(server, dir)
    }

    /// The testable constructor: a store rooted at an explicit directory.
    #[must_use]
    pub fn with_dir(server: String, dir: Option<PathBuf>) -> Self {
        let layouts = dir.as_deref().map(layouts::list_in).unwrap_or_default();
        Self {
            server,
            dir,
            layouts,
            stage: Stage::Browse,
            outcome: None,
        }
    }

    /// The owning server this menu is scoped to.
    #[must_use]
    pub fn server(&self) -> &str {
        &self.server
    }

    /// Whether the menu is sitting in its browse stage — no half-typed name,
    /// no pending confirmation, no keep-or-close answers in progress. The
    /// hosting window delivers a parked keep-or-close prompt only here.
    #[must_use]
    pub fn is_browsing(&self) -> bool {
        matches!(self.stage, Stage::Browse)
    }

    /// Enter the keep-or-close stage for the omitted sessions of the
    /// template being applied — every row defaulting to Keep.
    pub fn prompt_keep_or_close(&mut self, source: TemplateSource, rows: Vec<OmittedRow>) {
        self.stage = Stage::KeepOrClose { source, rows };
    }

    /// Record the daemon's save outcome and refresh the listing.
    pub fn record_save_outcome(&mut self, outcome: SaveOutcome) {
        self.refresh();
        self.outcome = Some(outcome);
    }

    fn refresh(&mut self) {
        self.layouts = self
            .dir
            .as_deref()
            .map(layouts::list_in)
            .unwrap_or_default();
    }

    /// Whether `name` folds onto an existing layout.
    fn exists(&self, name: &str) -> bool {
        self.dir
            .as_deref()
            .is_some_and(|dir| layouts::exists_in(dir, name))
    }
}

pub fn update(state: &mut State, message: Message) -> (Task<Message>, Option<Event>) {
    match message {
        Message::ApplyPressed(name) => (Task::none(), Some(Event::Apply { name })),
        Message::SaveAsPressed => {
            state.stage = Stage::SaveAs {
                name: String::new(),
                error: None,
            };
            state.outcome = None;
            (operation::focus(name_input_id()), None)
        }
        Message::NameChanged(value) => {
            match &mut state.stage {
                Stage::SaveAs { name, error } => {
                    *name = value;
                    *error = None;
                }
                Stage::Rename { to, error, .. } => {
                    *to = value;
                    *error = None;
                }
                _ => {}
            }
            (Task::none(), None)
        }
        Message::SaveAsConfirmed => {
            let Stage::SaveAs { name, error } = &mut state.stage else {
                return (Task::none(), None);
            };
            let candidate = name.trim().to_string();
            if let Err(reason) = smudgy_core::models::naming::validate_name(&candidate) {
                *error = Some(reason);
                return (Task::none(), None);
            }
            if state.exists(&candidate) {
                // Saving onto an existing layout is an overwrite: it gets
                // the same explicit confirmation the per-item button does.
                state.stage = Stage::ConfirmOverwrite {
                    name: candidate,
                    action: OverwriteAction::Save,
                };
                return (Task::none(), None);
            }
            state.stage = Stage::Browse;
            (Task::none(), Some(Event::Save { name: candidate }))
        }
        Message::OverwritePressed(name) => {
            state.stage = Stage::ConfirmOverwrite {
                name,
                action: OverwriteAction::Save,
            };
            state.outcome = None;
            (Task::none(), None)
        }
        Message::OverwriteConfirmed => {
            let Stage::ConfirmOverwrite { name, action } = &state.stage else {
                return (Task::none(), None);
            };
            let name = name.clone();
            match action.clone() {
                OverwriteAction::Save => {
                    state.stage = Stage::Browse;
                    (Task::none(), Some(Event::Save { name }))
                }
                OverwriteAction::Rename { from } => {
                    perform_rename(state, from, name);
                    (Task::none(), None)
                }
            }
        }
        Message::RenamePressed(name) => {
            state.stage = Stage::Rename {
                from: name.clone(),
                to: name,
                error: None,
            };
            state.outcome = None;
            (operation::focus(name_input_id()), None)
        }
        Message::RenameConfirmed => {
            let Stage::Rename { from, to, error } = &mut state.stage else {
                return (Task::none(), None);
            };
            let target = to.trim().to_string();
            if let Err(reason) = smudgy_core::models::naming::validate_name(&target) {
                *error = Some(reason);
                return (Task::none(), None);
            }
            let from = from.clone();
            // Renaming onto a *different* existing layout replaces it —
            // that replacement gets the same explicit confirmation an
            // overwrite-save does. A pure casing change of the same layout
            // passes through freely.
            if !smudgy_core::models::naming::names_conflict(&from, &target) && state.exists(&target)
            {
                state.stage = Stage::ConfirmOverwrite {
                    name: target,
                    action: OverwriteAction::Rename { from },
                };
                return (Task::none(), None);
            }
            perform_rename(state, from, target);
            (Task::none(), None)
        }
        Message::DeletePressed(name) => {
            state.stage = Stage::ConfirmDelete { name };
            state.outcome = None;
            (Task::none(), None)
        }
        Message::DeleteConfirmed => {
            let Stage::ConfirmDelete { name } = &state.stage else {
                return (Task::none(), None);
            };
            let name = name.clone();
            if let Some(dir) = state.dir.as_deref()
                && let Err(error) = layouts::delete_in(dir, &name)
            {
                log::warn!("[layouts] delete of '{name}' failed: {error}");
            }
            state.stage = Stage::Browse;
            state.refresh();
            (Task::none(), None)
        }
        Message::ResetPressed => {
            state.stage = Stage::ConfirmReset;
            state.outcome = None;
            (Task::none(), None)
        }
        Message::ResetConfirmed => {
            state.stage = Stage::Browse;
            (Task::none(), Some(Event::Reset))
        }
        Message::Back => {
            state.stage = Stage::Browse;
            (Task::none(), None)
        }
        Message::ToggleClose(session, close) => {
            if let Stage::KeepOrClose { rows, .. } = &mut state.stage
                && let Some(row) = rows.iter_mut().find(|row| row.session == session)
            {
                row.close = close;
            }
            (Task::none(), None)
        }
        Message::KeepOrCloseConfirmed => {
            let Stage::KeepOrClose { source, rows } = &state.stage else {
                return (Task::none(), None);
            };
            let event = Event::ApplyWithAnswers {
                source: source.clone(),
                close: rows
                    .iter()
                    .filter(|row| row.close)
                    .map(|row| row.session)
                    .collect(),
                keep: rows
                    .iter()
                    .filter(|row| !row.close)
                    .map(|row| row.session)
                    .collect(),
            };
            state.stage = Stage::Browse;
            (Task::none(), Some(event))
        }
    }
}

/// Execute a validated rename, landing back in Browse on success or in the
/// rename form with the store's error on failure.
fn perform_rename(state: &mut State, from: String, target: String) {
    let result = match state.dir.as_deref() {
        Some(dir) => layouts::rename_in(dir, &from, &target),
        None => Err(layouts::LayoutStoreError::OutsideStore),
    };
    match result {
        Ok(()) => {
            state.stage = Stage::Browse;
            state.refresh();
        }
        Err(error) => {
            log::warn!("[layouts] rename of '{from}' to '{target}' failed: {error}");
            state.stage = Stage::Rename {
                from,
                to: target,
                error: Some(error.to_string()),
            };
        }
    }
}

pub fn view(state: &State) -> Element<'_, Message> {
    let body: Element<'_, Message> = match &state.stage {
        Stage::Browse => browse(state),
        Stage::SaveAs { name, error } => name_form(
            &t!("layouts-save-as"),
            name,
            error.as_deref(),
            Message::SaveAsConfirmed,
        ),
        Stage::ConfirmOverwrite { name, .. } => confirm(
            t!("layouts-confirm-overwrite", "name" => name),
            Message::OverwriteConfirmed,
            &t!("layouts-overwrite"),
        ),
        Stage::Rename { to, error, .. } => name_form(
            &t!("layouts-rename"),
            to,
            error.as_deref(),
            Message::RenameConfirmed,
        ),
        Stage::ConfirmDelete { name } => confirm(
            t!("layouts-confirm-delete", "name" => name),
            Message::DeleteConfirmed,
            &t!("action-delete"),
        ),
        Stage::ConfirmReset => confirm(
            t!("layouts-confirm-reset"),
            Message::ResetConfirmed,
            &t!("layouts-reset"),
        ),
        Stage::KeepOrClose { rows, .. } => keep_or_close(rows),
    };
    container(body).padding(16).width(Length::Fill).into()
}

fn browse(state: &State) -> Element<'_, Message> {
    let mut listing = column![].spacing(4);
    if state.layouts.is_empty() {
        listing = listing.push(
            text(t!("layouts-empty", "server" => state.server()))
                .size(13)
                .style(theme::builtins::text::muted),
        );
    }
    for name in &state.layouts {
        let entry = row![
            button(text(name.clone()).size(14))
                .style(theme::builtins::button::list_item)
                .width(Length::Fill)
                .on_press(Message::ApplyPressed(name.clone())),
            button(text(t!("layouts-overwrite")).size(12))
                .style(theme::builtins::button::subtle)
                .padding([4, 8])
                .on_press(Message::OverwritePressed(name.clone())),
            button(text(t!("layouts-rename")).size(12))
                .style(theme::builtins::button::subtle)
                .padding([4, 8])
                .on_press(Message::RenamePressed(name.clone())),
            button(text(t!("action-delete")).size(12))
                .style(theme::builtins::button::subtle)
                .padding([4, 8])
                .on_press(Message::DeletePressed(name.clone())),
        ]
        .spacing(6)
        .align_y(iced::alignment::Vertical::Center);
        listing = listing.push(entry);
    }

    let mut content = column![
        text(t!("layouts-apply-hint"))
            .size(12)
            .style(theme::builtins::text::muted),
        scrollable(listing).height(Length::Fill),
    ]
    .spacing(10)
    .height(Length::Fill);

    if let Some(outcome) = &state.outcome {
        let line: Element<'_, Message> = match outcome {
            SaveOutcome::Saved { name, omitted: 0 } => text(t!("layouts-saved", "name" => name))
                .size(12)
                .style(theme::builtins::text::muted)
                .into(),
            SaveOutcome::Saved { name, omitted } => {
                let count = omitted.to_string();
                text(t!("layouts-saved-partial", "name" => name, "count" => &count))
                    .size(12)
                    .style(theme::builtins::text::danger)
                    .into()
            }
            SaveOutcome::Failed { error } => text(t!("layouts-save-failed", "error" => error))
                .size(12)
                .style(theme::builtins::text::danger)
                .into(),
        };
        content = content.push(line);
    }

    content = content.push(
        row![
            button(text(t!("layouts-save-as")).size(13))
                .style(theme::builtins::button::secondary)
                .on_press(Message::SaveAsPressed),
            button(text(t!("layouts-reset")).size(13))
                .style(theme::builtins::button::secondary)
                .on_press(Message::ResetPressed),
        ]
        .spacing(8),
    );
    content.into()
}

/// The shared one-field form for save-as and rename: label, input (Enter
/// submits, Escape backs out through the modal's global handler), error
/// line, confirm/cancel.
fn name_form<'a>(
    label: &str,
    value: &str,
    error: Option<&'a str>,
    submit: Message,
) -> Element<'a, Message> {
    let error_line: Element<'_, Message> = match error {
        Some(error) => text(error.to_string())
            .size(12)
            .style(theme::builtins::text::danger)
            .into(),
        None => iced::widget::space::horizontal().into(),
    };
    column![
        text(label.to_string()).size(14),
        text_input(ts!("layouts-name-placeholder"), value)
            .id(name_input_id())
            .on_input(Message::NameChanged)
            .on_submit(submit.clone()),
        error_line,
        row![
            button(text(t!("action-save")).size(13))
                .style(theme::builtins::button::primary)
                .on_press(submit),
            button(text(t!("action-cancel")).size(13))
                .style(theme::builtins::button::secondary)
                .on_press(Message::Back),
        ]
        .spacing(8),
    ]
    .spacing(10)
    .into()
}

/// A confirmation stage: the question, then an explicit confirm beside a
/// cancel.
fn confirm<'a>(question: String, action: Message, action_label: &str) -> Element<'a, Message> {
    column![
        text(question).size(14),
        row![
            button(text(action_label.to_string()).size(13))
                .style(theme::builtins::button::primary)
                .on_press(action),
            button(text(t!("action-cancel")).size(13))
                .style(theme::builtins::button::secondary)
                .on_press(Message::Back),
        ]
        .spacing(8),
    ]
    .spacing(12)
    .into()
}

fn keep_or_close(rows: &[OmittedRow]) -> Element<'_, Message> {
    let mut listing = column![].spacing(6);
    for row_state in rows {
        let session = row_state.session;
        // The chosen side is marked twice over: the primary button style
        // (color) and a check-glyph label (shape) — the answer stays
        // legible without color vision.
        let keep_style = if row_state.close {
            theme::builtins::button::secondary
        } else {
            theme::builtins::button::primary
        };
        let close_style = if row_state.close {
            theme::builtins::button::primary
        } else {
            theme::builtins::button::secondary
        };
        let keep_label = if row_state.close {
            t!("layouts-keep")
        } else {
            t!("layouts-keep-chosen")
        };
        let close_label = if row_state.close {
            t!("layouts-close-chosen")
        } else {
            t!("layouts-close")
        };
        listing = listing.push(
            row![
                text(row_state.label.clone()).size(13).width(Length::Fill),
                button(text(keep_label).size(12))
                    .style(keep_style)
                    .padding([4, 8])
                    .on_press(Message::ToggleClose(session, false)),
                button(text(close_label).size(12))
                    .style(close_style)
                    .padding([4, 8])
                    .on_press(Message::ToggleClose(session, true)),
            ]
            .spacing(6)
            .align_y(iced::alignment::Vertical::Center),
        );
    }
    column![
        text(t!("layouts-keep-or-close-intro")).size(13),
        scrollable(listing).height(Length::Fill),
        row![
            button(text(t!("layouts-apply")).size(13))
                .style(theme::builtins::button::primary)
                .on_press(Message::KeepOrCloseConfirmed),
            button(text(t!("action-cancel")).size(13))
                .style(theme::builtins::button::secondary)
                .on_press(Message::Back),
        ]
        .spacing(8),
    ]
    .spacing(10)
    .height(Length::Fill)
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::dto;

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

    fn state_with_layouts(names: &[&str]) -> (tempfile::TempDir, State) {
        let root = tempfile::tempdir().expect("temp dir");
        let dir = root.path().join("layouts");
        let workspace = minimal_workspace();
        for name in names {
            layouts::save_in(&dir, name, &workspace).expect("seed layout");
        }
        let state = State::with_dir("Arctic".to_string(), Some(dir));
        (root, state)
    }

    fn event(state: &mut State, message: Message) -> Option<Event> {
        update(state, message).1
    }

    #[test]
    fn clicking_a_layout_applies_it() {
        let (_root, mut state) = state_with_layouts(&["combat"]);
        assert_eq!(
            event(&mut state, Message::ApplyPressed("combat".to_string())),
            Some(Event::Apply {
                name: "combat".to_string()
            })
        );
    }

    #[test]
    fn save_as_validates_the_name_before_anything_happens() {
        let (_root, mut state) = state_with_layouts(&[]);
        assert!(event(&mut state, Message::SaveAsPressed).is_none());
        assert!(event(&mut state, Message::NameChanged("a/b".to_string())).is_none());
        assert!(event(&mut state, Message::SaveAsConfirmed).is_none());
        let Stage::SaveAs { error, .. } = &state.stage else {
            panic!("still in the save-as stage");
        };
        assert!(error.is_some(), "the invalid name is called out");
    }

    #[test]
    fn save_as_over_a_case_variant_requires_the_overwrite_confirmation() {
        let (_root, mut state) = state_with_layouts(&["Combat"]);
        event(&mut state, Message::SaveAsPressed);
        event(&mut state, Message::NameChanged("COMBAT".to_string()));
        assert!(
            event(&mut state, Message::SaveAsConfirmed).is_none(),
            "an existing (case-folded) name is not saved outright"
        );
        assert!(matches!(
            &state.stage,
            Stage::ConfirmOverwrite {
                name,
                action: OverwriteAction::Save
            } if name == "COMBAT"
        ));
        assert_eq!(
            event(&mut state, Message::OverwriteConfirmed),
            Some(Event::Save {
                name: "COMBAT".to_string()
            })
        );
        assert_eq!(state.stage, Stage::Browse);
    }

    #[test]
    fn fresh_names_save_without_a_confirmation() {
        let (_root, mut state) = state_with_layouts(&[]);
        event(&mut state, Message::SaveAsPressed);
        event(&mut state, Message::NameChanged("peace".to_string()));
        assert_eq!(
            event(&mut state, Message::SaveAsConfirmed),
            Some(Event::Save {
                name: "peace".to_string()
            })
        );
    }

    #[test]
    fn delete_requires_its_confirmation_and_refreshes_the_list() {
        let (_root, mut state) = state_with_layouts(&["combat"]);
        assert!(event(&mut state, Message::DeletePressed("combat".to_string())).is_none());
        assert_eq!(state.layouts, vec!["combat".to_string()]);
        assert!(event(&mut state, Message::DeleteConfirmed).is_none());
        assert!(state.layouts.is_empty(), "the listing refreshed");
    }

    #[test]
    fn cancelling_a_confirmation_changes_nothing() {
        let (_root, mut state) = state_with_layouts(&["combat"]);
        event(&mut state, Message::DeletePressed("combat".to_string()));
        assert!(event(&mut state, Message::Back).is_none());
        assert_eq!(state.stage, Stage::Browse);
        assert_eq!(state.layouts, vec!["combat".to_string()]);
    }

    #[test]
    fn rename_validates_and_renames_in_the_store() {
        let (_root, mut state) = state_with_layouts(&["combat"]);
        event(&mut state, Message::RenamePressed("combat".to_string()));
        event(&mut state, Message::NameChanged("nul".to_string()));
        assert!(event(&mut state, Message::RenameConfirmed).is_none());
        assert!(
            matches!(&state.stage, Stage::Rename { error: Some(_), .. }),
            "a reserved device name is rejected in place"
        );
        event(&mut state, Message::NameChanged("peace".to_string()));
        assert!(event(&mut state, Message::RenameConfirmed).is_none());
        assert_eq!(state.stage, Stage::Browse);
        assert_eq!(state.layouts, vec!["peace".to_string()]);
    }

    #[test]
    fn rename_onto_a_different_layout_requires_the_overwrite_confirmation() {
        let (_root, mut state) = state_with_layouts(&["combat", "peace"]);
        event(&mut state, Message::RenamePressed("combat".to_string()));
        event(&mut state, Message::NameChanged("PEACE".to_string()));
        assert!(event(&mut state, Message::RenameConfirmed).is_none());
        assert!(matches!(
            &state.stage,
            Stage::ConfirmOverwrite {
                name,
                action: OverwriteAction::Rename { from }
            } if name == "PEACE" && from == "combat"
        ));
        // Nothing moved while the confirmation is open.
        assert_eq!(
            state.layouts,
            vec!["combat".to_string(), "peace".to_string()]
        );
        assert!(event(&mut state, Message::OverwriteConfirmed).is_none());
        assert_eq!(state.stage, Stage::Browse);
        // The rename replaced peace by renaming over its file: the
        // displaced stem stands and combat is gone.
        assert_eq!(state.layouts, vec!["peace".to_string()]);
    }

    #[test]
    fn rename_replace_cancels_back_to_browsing_untouched() {
        let (_root, mut state) = state_with_layouts(&["combat", "peace"]);
        event(&mut state, Message::RenamePressed("combat".to_string()));
        event(&mut state, Message::NameChanged("peace".to_string()));
        event(&mut state, Message::RenameConfirmed);
        assert!(event(&mut state, Message::Back).is_none());
        assert_eq!(state.stage, Stage::Browse);
        assert_eq!(
            state.layouts,
            vec!["combat".to_string(), "peace".to_string()]
        );
    }

    #[test]
    fn case_only_renames_stay_free_of_confirmation() {
        let (_root, mut state) = state_with_layouts(&["combat"]);
        event(&mut state, Message::RenamePressed("combat".to_string()));
        event(&mut state, Message::NameChanged("COMBAT".to_string()));
        assert!(event(&mut state, Message::RenameConfirmed).is_none());
        assert_eq!(state.stage, Stage::Browse);
        assert_eq!(state.layouts, vec!["COMBAT".to_string()]);
    }

    #[test]
    fn reset_requires_its_confirmation() {
        let (_root, mut state) = state_with_layouts(&[]);
        assert!(event(&mut state, Message::ResetPressed).is_none());
        assert_eq!(
            event(&mut state, Message::ResetConfirmed),
            Some(Event::Reset)
        );
    }

    #[test]
    fn keep_or_close_defaults_to_keep_and_partitions_by_explicit_toggle() {
        let (_root, mut state) = state_with_layouts(&["combat"]);
        state.prompt_keep_or_close(
            TemplateSource::Named("combat".to_string()),
            vec![
                OmittedRow {
                    session: SessionId::from(1),
                    label: "imm on Arctic".to_string(),
                    close: false,
                },
                OmittedRow {
                    session: SessionId::from(2),
                    label: "alt on Arctic".to_string(),
                    close: false,
                },
            ],
        );
        // Confirming untouched answers keeps everything: closing is never
        // the silent default. A last-session restore's questions ride the
        // same stage, its source echoed back for the re-entry apply.
        let mut untouched = State::with_dir("Arctic".to_string(), None);
        untouched.prompt_keep_or_close(
            TemplateSource::LastSession,
            vec![OmittedRow {
                session: SessionId::from(7),
                label: "imm on Arctic".to_string(),
                close: false,
            }],
        );
        assert_eq!(
            event(&mut untouched, Message::KeepOrCloseConfirmed),
            Some(Event::ApplyWithAnswers {
                source: TemplateSource::LastSession,
                close: vec![],
                keep: vec![SessionId::from(7)],
            })
        );

        // An explicit toggle closes exactly that session.
        event(&mut state, Message::ToggleClose(SessionId::from(2), true));
        assert_eq!(
            event(&mut state, Message::KeepOrCloseConfirmed),
            Some(Event::ApplyWithAnswers {
                source: TemplateSource::Named("combat".to_string()),
                close: vec![SessionId::from(2)],
                keep: vec![SessionId::from(1)],
            })
        );
    }

    #[test]
    fn save_outcome_annotates_partial_captures() {
        let (_root, mut state) = state_with_layouts(&[]);
        state.record_save_outcome(SaveOutcome::Saved {
            name: "combat".to_string(),
            omitted: 2,
        });
        assert_eq!(
            state.outcome,
            Some(SaveOutcome::Saved {
                name: "combat".to_string(),
                omitted: 2
            })
        );
        // The daemon saved after this modal listed: the listing refreshed.
        assert!(state.layouts.is_empty(), "seeded empty; still empty");
    }
}
