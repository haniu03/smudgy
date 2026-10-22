//! The map editor's status footer: the canvas's hints, or for a few
//! seconds the editor's latest notice in their place, so a notice never
//! pushes the canvas around, and at the right the open map's save status.
//! Hint wording comes from `MapEditor::legend_items`; this module is
//! presentation-only.

use iced::Length;
use iced::alignment::Vertical;
use iced::widget::{Row, button, container, row, space, text};
use smudgy_map_widget::map_editor::LegendItem;

use crate::theme::{Element as ThemedElement, builtins};

use super::Message;

const LEGEND_HEIGHT: f32 = 30.0;

/// The footer: a ready automatic route's Accept/Cancel bar, else the latest
/// notice, else the hints; then `status`, the open map's save status.
pub fn view<'a>(
    items: Vec<LegendItem>,
    notice: Option<String>,
    route_ready: bool,
    status: Option<ThemedElement<'a, Message>>,
) -> ThemedElement<'a, Message> {
    let mut content = Row::new().spacing(14).align_y(Vertical::Center);
    if route_ready {
        return footer(
            content
                .push(text(crate::i18n::t!("mapper-route-ready")).size(12))
                .push(space::horizontal())
                .push(
                    button(text(crate::i18n::t!("action-cancel")).size(11))
                        .style(builtins::button::secondary)
                        .padding([1, 8])
                        .on_press(Message::AutomaticRouteCancelled),
                )
                .push(
                    button(text(crate::i18n::t!("mapper-route-preview-accept")).size(11))
                        .style(builtins::button::primary)
                        .padding([1, 8])
                        .on_press(Message::AutomaticRouteAccepted),
                ),
            status,
        );
    }
    if let Some(notice) = notice {
        return footer(content.push(text(notice).size(12)), status);
    }
    for item in items {
        let action = crate::i18n::translate(item.action);
        let hint: ThemedElement<'static, Message> = if item.key.is_empty() {
            text(action).size(12).into()
        } else {
            let key = if item.key.starts_with("legend-") {
                crate::i18n::translate(item.key)
            } else {
                item.key.to_string()
            };
            row![
                container(text(key).size(11))
                    .padding([1, 5])
                    .style(builtins::container::tooltip),
                text(action).size(12),
            ]
            .spacing(5)
            .align_y(Vertical::Center)
            .into()
        };
        content = content.push(hint);
    }

    footer(content, status)
}

fn footer<'a>(
    content: Row<'static, Message, crate::Theme>,
    status: Option<ThemedElement<'a, Message>>,
) -> ThemedElement<'a, Message> {
    // A Fill child is laid out after the others, so the status keeps its
    // width and the hints are cut off at its left edge instead.
    let mut bar = row![container(content).width(Length::Fill).clip(true)]
        .spacing(14)
        .align_y(Vertical::Center);
    if let Some(status) = status {
        bar = bar.push(status);
    }
    container(bar)
        .width(Length::Fill)
        .height(Length::Fixed(LEGEND_HEIGHT))
        .padding([4, 10])
        .style(builtins::container::pane_title_bar)
        .into()
}
