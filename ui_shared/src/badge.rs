//! Small count pills shown beside a control's label.

use iced::widget::{container, text};
use smudgy_theme::{Element, builtins};

/// What a count is for, which picks its fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadgeTone {
    /// Something waits on the user (pending offers): the accent fill.
    Accent,
    /// The count only informs (panes waiting in a menu): grey.
    Neutral,
}

/// A rounded pill holding `count`. Callers decide whether a zero shows.
#[must_use]
pub fn count<'a, Message: 'a>(count: usize, tone: BadgeTone) -> Element<'a, Message> {
    container(text(count.to_string()).size(11))
        .padding([0, 6])
        .style(match tone {
            BadgeTone::Accent => builtins::container::count_badge,
            BadgeTone::Neutral => builtins::container::count_badge_neutral,
        })
        .into()
}
