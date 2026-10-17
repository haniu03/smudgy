//! Portable application controls from Smudgy's disappearing main toolbar.

use iced::alignment::Vertical;
use iced::widget::{Row, button, svg, text};
use iced::{Color, Length};
use smudgy_theme::{Element, Theme, builtins};

use crate::assets::{BARS_3_BYTES, GEIST};
use crate::layout_menu;

const TITLE_COLOR: Color = Color::from_rgb8(92, 92, 92);
const TOOLBAR_HEIGHT: f32 = 42.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    ToggleExpand,
    Connect,
    LayoutMenu(layout_menu::Message),
    Settings,
}

fn icon_style(_: &Theme, _: svg::Status) -> svg::Style {
    svg::Style {
        color: Some(TITLE_COLOR),
    }
}

fn menu_button() -> Element<'static, Message> {
    button(
        svg(svg::Handle::from_memory(BARS_3_BYTES))
            .width(16)
            .height(16)
            .style(icon_style),
    )
    .style(builtins::button::link)
    .padding([4, 8])
    .on_press(Message::ToggleExpand)
    .into()
}

fn toolbar_button(label: String, message: Message) -> Element<'static, Message> {
    button(text(label).font(GEIST).size(14))
        .style(builtins::button::toolbar)
        .padding([4, 10])
        .on_press(message)
        .into()
}

/// `label` resolves the host's localized text for a catalog id;
/// `layout_menu` is the Layout button and its menu, shown beside the
/// session items; `on_menu_bounds` mirrors the hamburger's bounds (where
/// hidden panes fly while the toolbar is collapsed).
#[must_use]
pub fn view<'a>(
    expanded: bool,
    has_session: bool,
    label: &impl Fn(&'static str) -> String,
    layout_menu: Element<'a, Message>,
    on_menu_bounds: impl Fn(iced::Rectangle) + 'a,
) -> Element<'a, Message> {
    let mut items: Vec<Element<'a, Message>> =
        vec![crate::bounds_probe::BoundsProbe::new(menu_button(), on_menu_bounds).into()];
    if expanded {
        items.push(toolbar_button(label("toolbar-connect"), Message::Connect));
        if has_session {
            items.push(layout_menu);
        }
        items.push(toolbar_button(label("toolbar-settings"), Message::Settings));
    } else {
        items.push(
            text("Smudgy")
                .font(GEIST)
                .size(14)
                .color(TITLE_COLOR)
                .into(),
        );
    }
    items.push(iced::widget::Space::new().width(Length::Fill).into());

    Row::with_children(items)
        .padding(5)
        .spacing(if expanded { 4 } else { 10 })
        .width(Length::Fill)
        .height(TOOLBAR_HEIGHT)
        .align_y(Vertical::Center)
        .into()
}
