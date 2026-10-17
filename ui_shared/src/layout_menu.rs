//! The toolbar's Layout menu: the panes hidden in this window, the saved
//! layouts for the active session's server, and the layout actions.
//!
//! Hidden panes are not a separate state: a pane is listed here exactly
//! while its definition is hidden, whether the user hid it or a script did
//! (or created it hidden). Showing one from the menu is the same toggle as
//! the tab's hide control. The saved-layout rows apply on click; saving,
//! managing, and resetting open the named-layout dialog at the matching
//! stage.
//!
//! The menu describes, it does not decide: hosts gather the rows (each
//! knows its own sessions and layout store) and handle every [`Message`]
//! but nothing here touches storage.

use iced::alignment::Horizontal;
use iced::widget::{button, column, container, row, rule, scrollable, text};
use iced::{Alignment, Length, Padding};
use smudgy_session_model::pane::PaneRef;
use smudgy_theme::{Element, builtins};

use crate::assets::GEIST;
use crate::badge::{self, BadgeTone};
use crate::dropdown::Dropdown;
use crate::layouts_view::Labels;
use crate::pane_provenance::PaneCreator;

/// The menu's fixed width; long names wrap rather than widen it.
const MENU_WIDTH: f32 = 300.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    /// The toolbar button: open or close the menu.
    Toggle,
    /// Open the menu, expanding a collapsed toolbar first (the
    /// everything-hidden view's way to pick panes one by one).
    Open,
    /// A press outside the open menu, or Escape.
    Dismiss,
    /// Show one hidden pane.
    Show(PaneRef),
    /// Show every hidden pane in this window.
    ShowAll,
    /// Apply the named saved layout.
    Apply(String),
    /// Save the current arrangement under a new name.
    SaveAs,
    /// Open the saved-layout manager.
    Manage,
    /// Reset the active session's pane layout (after confirmation).
    Reset,
}

/// One hidden pane, as its row describes it.
#[derive(Debug, Clone)]
pub struct HiddenPane {
    pub pane: PaneRef,
    /// The pane's display name. Main panes show as "Main" instead: their
    /// session heading already names them.
    pub name: String,
    pub creator: PaneCreator,
}

/// The hidden panes of one session, under its heading.
#[derive(Debug, Clone)]
pub struct HiddenSession {
    pub label: String,
    pub panes: Vec<HiddenPane>,
}

/// The saved layouts the menu lists. Browser storage answers
/// asynchronously; the native store answers before the menu first draws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SavedLayouts {
    Loading,
    Listed(Vec<String>),
    Failed(String),
}

/// What an open menu shows.
pub struct Contents<'a> {
    pub hidden: &'a [HiddenSession],
    /// The active session's server, which scopes the saved layouts.
    pub server: &'a str,
    pub saved: &'a SavedLayouts,
}

/// Group hidden panes under their sessions, keeping the order panes are
/// given in and the order sessions first appear.
#[must_use]
pub fn group_by_session(
    panes: impl IntoIterator<Item = (String, HiddenPane)>,
) -> Vec<HiddenSession> {
    let mut sessions: Vec<HiddenSession> = Vec::new();
    for (label, pane) in panes {
        match sessions
            .iter_mut()
            .find(|session| session.panes[0].pane.session_id == pane.pane.session_id)
        {
            Some(session) => session.panes.push(pane),
            None => sessions.push(HiddenSession {
                label,
                panes: vec![pane],
            }),
        }
    }
    sessions
}

/// The toolbar's Layout button, with a grey count of the hidden panes, and
/// the menu floating beneath it while `open` is `Some`.
pub fn view<'a, L: Labels>(
    hidden_count: usize,
    open: Option<Contents<'_>>,
    labels: &L,
) -> Element<'a, Message> {
    let mut label = row![text(labels.text("toolbar-layout")).font(GEIST).size(14)]
        .spacing(6)
        .align_y(Alignment::Center);
    if hidden_count > 0 {
        label = label.push(badge::count(hidden_count, BadgeTone::Neutral));
    }
    let anchor = button(label)
        .style(if open.is_some() {
            builtins::button::toolbar_active
        } else {
            builtins::button::toolbar
        })
        .padding([4, 10])
        .on_press(Message::Toggle);
    let menu = open.map(|contents| menu(contents, labels));
    Dropdown::new(anchor, menu, Message::Dismiss).into()
}

/// What a window shows when every pane in it is hidden: `cat` (the CRT cat
/// of the no-sessions view), a reminder that the sessions still run, and
/// the two ways back — every pane at once, or one by one from the menu.
pub fn everything_hidden<'a>(
    cat: Element<'a, Message>,
    label: impl Fn(&'static str) -> String,
) -> Element<'a, Message> {
    container(
        column![
            cat,
            text(label("layout-hidden-heading")).size(22),
            text(label("layout-hidden-subtext")).style(builtins::text::muted),
            button(text(label("layout-hidden-show-all")).font(GEIST))
                .style(builtins::button::primary)
                .padding([10, 22])
                .on_press(Message::ShowAll),
            button(text(label("layout-hidden-choose")).size(13))
                .style(builtins::button::link)
                .padding([4, 10])
                .on_press(Message::Open),
        ]
        .spacing(16)
        .align_x(Horizontal::Center),
    )
    .center(Length::Fill)
    .into()
}

fn menu<'a, L: Labels>(contents: Contents<'_>, labels: &L) -> Element<'a, Message> {
    let mut list = column![].spacing(2);

    let hidden_total: usize = contents
        .hidden
        .iter()
        .map(|session| session.panes.len())
        .sum();
    if hidden_total > 0 {
        list = list.push(heading(labels.text("layout-menu-hidden")));
        for session in contents.hidden {
            list = list.push(
                container(
                    text(session.label.clone())
                        .size(12)
                        .style(builtins::text::muted),
                )
                .padding([4, 10]),
            );
            for pane in &session.panes {
                list = list.push(hidden_row(pane, labels));
            }
        }
        if hidden_total > 1 {
            list = list.push(item(labels.text("layout-menu-show-all"), Message::ShowAll));
        }
        list = list.push(divider());
    }

    list = list.push(heading(
        labels.format("layout-menu-saved", &[("server", contents.server)]),
    ));
    list = match contents.saved {
        SavedLayouts::Loading => list.push(note(labels.text("layout-menu-loading"), false)),
        SavedLayouts::Failed(error) => list.push(note(error.clone(), true)),
        SavedLayouts::Listed(names) if names.is_empty() => {
            list.push(note(labels.text("layout-menu-saved-empty"), false))
        }
        SavedLayouts::Listed(names) => names.iter().fold(list, |list, name| {
            list.push(item(name.clone(), Message::Apply(name.clone())))
        }),
    };
    list = list
        .push(divider())
        .push(item(labels.text("layout-menu-save-as"), Message::SaveAs))
        .push(item(labels.text("layout-menu-manage"), Message::Manage))
        .push(item(labels.text("layout-menu-reset"), Message::Reset));

    // A long menu scrolls inside the window (the dropdown caps its height);
    // the scrollbar keeps a gutter of its own beside the rows.
    let list = scrollable(list)
        .direction(scrollable::Direction::Vertical(
            scrollable::Scrollbar::new()
                .width(4)
                .scroller_width(4)
                .spacing(4),
        ))
        .height(Length::Shrink);
    container(list)
        .width(MENU_WIDTH)
        .padding(6)
        .style(builtins::container::card)
        .into()
}

fn hidden_row<'a, L: Labels>(pane: &HiddenPane, labels: &L) -> Element<'a, Message> {
    let name = match pane.creator {
        PaneCreator::Session => labels.text("layout-menu-main"),
        _ => pane.name.clone(),
    };
    let mut line = row![text(name).font(GEIST).size(13).width(Length::Fill)]
        .spacing(8)
        .align_y(Alignment::Center);
    if let Some(creator) = pane.creator.label(|id| labels.text(id)) {
        line = line.push(text(creator).size(11).style(builtins::text::muted));
    }
    button(line)
        .width(Length::Fill)
        .padding([5, 10])
        .style(builtins::button::list_item)
        .on_press(Message::Show(pane.pane))
        .into()
}

fn item<'a>(label: String, message: Message) -> Element<'a, Message> {
    button(text(label).font(GEIST).size(13))
        .width(Length::Fill)
        .padding([5, 10])
        .style(builtins::button::list_item)
        .on_press(message)
        .into()
}

fn heading<'a>(label: String) -> Element<'a, Message> {
    container(text(label).size(11).style(builtins::text::muted))
        .padding(Padding {
            top: 6.0,
            right: 10.0,
            bottom: 2.0,
            left: 10.0,
        })
        .into()
}

fn note<'a>(label: String, error: bool) -> Element<'a, Message> {
    container(text(label).size(12).style(if error {
        builtins::text::danger
    } else {
        builtins::text::muted
    }))
    .padding([4, 10])
    .into()
}

fn divider<'a>() -> Element<'a, Message> {
    container(rule::horizontal(1).style(builtins::rule::default))
        .padding([4, 0])
        .into()
}
