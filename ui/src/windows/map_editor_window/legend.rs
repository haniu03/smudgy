//! Reusable map-editor status footer. Behavior wording comes from
//! `MapEditor::legend_items`; this module is deliberately presentation-only.

use iced::Length;
use iced::alignment::Vertical;
use iced::widget::{Row, container, row, text};
use smudgy_map_widget::map_editor::LegendItem;

use crate::theme::{Element as ThemedElement, builtins};

use super::Message;

const LEGEND_HEIGHT: f32 = 30.0;

pub fn view(items: Vec<LegendItem>) -> ThemedElement<'static, Message> {
    let mut content = Row::new().spacing(14).align_y(Vertical::Center);
    for item in items {
        let hint: ThemedElement<'static, Message> = if item.key.is_empty() {
            text(item.action).size(12).into()
        } else {
            row![
                container(text(item.key).size(11))
                    .padding([1, 5])
                    .style(builtins::container::tooltip),
                text(item.action).size(12),
            ]
            .spacing(5)
            .align_y(Vertical::Center)
            .into()
        };
        content = content.push(hint);
    }

    container(content)
        .width(Length::Fill)
        .height(Length::Fixed(LEGEND_HEIGHT))
        .padding([4, 10])
        .style(builtins::container::pane_title_bar)
        .into()
}
