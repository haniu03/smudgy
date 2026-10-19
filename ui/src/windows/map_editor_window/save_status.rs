//! The open map's save status: a readout at the right of the editor's
//! footer and, while a save waits on the viewer's decision, a banner under
//! the toolbar that offers it.

use iced::Length;
use iced::alignment::Vertical;
use iced::widget::{button, container, row, text, tooltip};
use smudgy_cloud::mapper::{AreaSaveStatus, SyncState};

use crate::assets::{bootstrap_icons, fonts};
use crate::components::cloud_errors::display_error;
use crate::theme::Element as ThemedElement;
use crate::theme::builtins;

use super::{MapEditorWindow, Message};

type StyleFn = fn(&crate::Theme) -> text::Style;

fn normal(theme: &crate::Theme) -> text::Style {
    text::Style {
        color: Some(theme.styles.text.normal.scale_alpha(0.7)),
    }
}

fn error(theme: &crate::Theme) -> text::Style {
    text::Style {
        color: Some(theme.styles.text.error),
    }
}

fn save_status(window: &MapEditorWindow) -> AreaSaveStatus {
    window
        .editor
        .area_id()
        .map_or(AreaSaveStatus::Saved, |area_id| {
            window.mapper.area_save_status(area_id)
        })
}

/// The wall-clock time, as hours and minutes, of `next_retry`, an instant
/// `now` measures, when the wall clock reads `wall_now`.
#[must_use]
pub fn retry_clock(
    next_retry: Option<std::time::Instant>,
    now: std::time::Instant,
    wall_now: chrono::DateTime<chrono::Local>,
) -> Option<String> {
    let wait = next_retry?.saturating_duration_since(now);
    let at = wall_now + chrono::Duration::from_std(wait).ok()?;
    Some(at.format("%H:%M").to_string())
}

/// Why the edited map's writes are parked, in the viewer's language: the
/// server's refusal through [`display_error`], or the queue's own `message`
/// for a park the server did not refuse.
fn parked_reason(window: &MapEditorWindow, message: String) -> String {
    window
        .editor
        .area_id()
        .and_then(|area_id| window.mapper.parked_error(area_id))
        .map_or(message, |error| display_error(&error))
}

/// The mapper's cloud-sync readout. While a save is in flight, or waits on
/// the banner's decision, it is a passive status; otherwise it doubles as a
/// **Sync** button that triggers an immediate sync. The engine does not poll
/// on a timer, so this is how the user pulls remote changes (and retries
/// after a failure) on demand.
pub fn readout(window: &MapEditorWindow) -> ThemedElement<'_, Message> {
    let status = save_status(window);
    // With nothing of the open map's waiting to save, the readout says
    // when syncing is offline, and when it tries again.
    let sync = window.mapper.sync_status();
    let (codepoint, label, color): (_, _, StyleFn) = match &status {
        AreaSaveStatus::Saved if sync.state == SyncState::Offline => (
            bootstrap_icons::EXCLAMATION_TRIANGLE,
            match retry_clock(
                sync.next_retry,
                std::time::Instant::now(),
                chrono::Local::now(),
            ) {
                Some(time) => crate::i18n::t!("mapper-status-sync-retrying", "time" => time),
                None => crate::i18n::t!("mapper-status-sync-offline"),
            },
            error,
        ),
        AreaSaveStatus::Saved => (
            bootstrap_icons::CLOUD_CHECK,
            crate::i18n::t!("mapper-status-saved"),
            normal,
        ),
        AreaSaveStatus::Saving(pending) => (
            bootstrap_icons::CLOUD_UPLOAD,
            crate::i18n::t!("mapper-status-saving", "count" => *pending),
            normal,
        ),
        AreaSaveStatus::Offline(pending) => (
            bootstrap_icons::EXCLAMATION_TRIANGLE,
            crate::i18n::t!("mapper-status-offline", "count" => *pending),
            error,
        ),
        AreaSaveStatus::Held(pending) => (
            bootstrap_icons::CLOUD_UPLOAD,
            crate::i18n::t!("mapper-status-held", "count" => *pending),
            normal,
        ),
        AreaSaveStatus::ConflictNeedsReview => (
            bootstrap_icons::EXCLAMATION_TRIANGLE,
            crate::i18n::t!("mapper-status-conflict"),
            error,
        ),
        AreaSaveStatus::CouldNotSave { .. } => (
            bootstrap_icons::EXCLAMATION_TRIANGLE,
            crate::i18n::t!("mapper-status-could-not-save"),
            error,
        ),
    };

    let content = row![
        text(codepoint)
            .font(fonts::BOOTSTRAP_ICONS)
            .size(13.0)
            .style(color),
        text(label).size(12).style(color),
    ]
    .spacing(4)
    .align_y(Vertical::Center);

    match status {
        AreaSaveStatus::ConflictNeedsReview | AreaSaveStatus::CouldNotSave { .. } => {
            container(content).padding([2, 6]).into()
        }
        AreaSaveStatus::Saving(_) => tooltip(
            container(content).padding([2, 6]),
            crate::i18n::ts!("mapper-pending-tip"),
            tooltip::Position::Top,
        )
        .into(),
        AreaSaveStatus::Saved => tooltip(
            button(content)
                .style(builtins::button::subtle)
                .padding([2, 6])
                .on_press(Message::SyncNowRequested),
            crate::i18n::ts!("mapper-sync-tip"),
            tooltip::Position::Top,
        )
        .into(),
        AreaSaveStatus::Offline(_) | AreaSaveStatus::Held(_) => tooltip(
            button(content)
                .style(builtins::button::subtle)
                .padding([2, 6])
                .on_press(Message::SyncNowRequested),
            crate::i18n::ts!("mapper-pending-tip"),
            tooltip::Position::Top,
        )
        .into(),
    }
}

/// What a stuck save waits on, across the top of the canvas: which copy to
/// keep after a conflict, or retrying or discarding writes the server
/// refused. `None` while nothing waits.
pub fn banner(window: &MapEditorWindow) -> Option<ThemedElement<'_, Message>> {
    let action = |label: String, message: Option<Message>| {
        button(text(label).size(12))
            .style(builtins::button::secondary)
            .padding([2, 8])
            .on_press_maybe(message)
    };
    let warning = text(bootstrap_icons::EXCLAMATION_TRIANGLE)
        .font(fonts::BOOTSTRAP_ICONS)
        .size(14.0)
        .style(error);
    let content = match save_status(window) {
        AreaSaveStatus::ConflictNeedsReview => row![
            warning,
            container(text(crate::i18n::t!("mapper-status-conflict")).size(13)).width(Length::Fill),
            action(
                crate::i18n::t!("mapper-save-keep-mine"),
                Some(Message::KeepMineRequested)
            ),
            action(
                crate::i18n::t!("mapper-save-keep-theirs"),
                Some(Message::KeepTheirsRequested)
            ),
        ],
        AreaSaveStatus::CouldNotSave { message, retryable } => row![
            warning,
            text(crate::i18n::t!("mapper-status-could-not-save")).size(13),
            container(text(parked_reason(window, message)).size(12).style(normal))
                .width(Length::Fill),
            action(
                crate::i18n::t!("action-retry"),
                retryable.then_some(Message::RetrySaveRequested)
            ),
            action(
                crate::i18n::t!("editor-discard"),
                Some(Message::DiscardFailedSaveRequested)
            ),
        ],
        _ => return None,
    };
    Some(
        container(content.spacing(10).align_y(Vertical::Center))
            .width(Length::Fill)
            .padding([6, 12])
            .style(builtins::container::modal_title_bar)
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::retry_clock;
    use chrono::TimeZone;
    use std::time::{Duration, Instant};

    #[test]
    fn the_next_retry_reads_as_a_wall_clock_time() {
        let now = Instant::now();
        let wall = chrono::Local
            .with_ymd_and_hms(2026, 10, 18, 12, 0, 0)
            .unwrap();
        assert_eq!(
            retry_clock(Some(now + Duration::from_secs(240)), now, wall).as_deref(),
            Some("12:04")
        );
        assert_eq!(retry_clock(None, now, wall), None);
        assert_eq!(
            retry_clock(Some(now), now + Duration::from_secs(5), wall).as_deref(),
            Some("12:00"),
            "a retry already due reads as now"
        );
    }
}
