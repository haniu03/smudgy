//! The editor toolbar, in two rows: the open map, with its name, Active
//! switch and actions; under it the editing controls, with the tools, the
//! level stepper, undo/redo and where new content goes. The map's save
//! status is in the footer (see [`super::save_status`]).

use iced::alignment::Vertical;
use iced::font::Weight;
use iced::widget::{button, column, container, row, rule, space, text, tooltip};
use iced::{Font, Length, Padding};
use smudgy_cloud::MapStorage;
use smudgy_cloud::clans::action;
use smudgy_map_widget::map_editor::Tool;

use crate::assets::{bootstrap_icons, fonts};
use crate::theme::Element as ThemedElement;
use crate::theme::builtins;
use crate::widgets::dropdown::Dropdown;

use super::{MapEditorWindow, Message, ScopeTarget};

const ICON_SIZE: f32 = 16.0;

fn icon(codepoint: &'static str) -> iced::widget::Text<'static, crate::Theme> {
    text(codepoint).font(fonts::BOOTSTRAP_ICONS).size(ICON_SIZE)
}

/// A square icon button, narrower than iced's default padding makes it, so
/// the editing row fits the canvas at the editor's default size.
fn icon_button(codepoint: &'static str) -> button::Button<'static, Message, crate::Theme> {
    button(icon(codepoint)).padding([5, 6])
}

fn tool_button(
    codepoint: &'static str,
    label: &'static str,
    tool: Tool,
    active_tool: Tool,
    enabled: bool,
) -> ThemedElement<'static, Message> {
    tooltip(
        icon_button(codepoint)
            .style(if tool == active_tool {
                builtins::button::list_item_selected
            } else {
                builtins::button::toolbar
            })
            .on_press_maybe(enabled.then_some(Message::ToolSelected(tool))),
        label,
        tooltip::Position::Bottom,
    )
    .into()
}

/// An icon-and-label toolbar button, as in the automations top bar.
fn action_button<'a>(
    codepoint: &'static str,
    label: String,
    message: Message,
    active: bool,
) -> button::Button<'a, Message, crate::Theme> {
    button(
        row![
            text(codepoint).font(fonts::BOOTSTRAP_ICONS).size(13.0),
            text(label).size(13.0),
        ]
        .spacing(7.0)
        .align_y(Vertical::Center),
    )
    .style(if active {
        builtins::button::toolbar_active
    } else {
        builtins::button::toolbar
    })
    .padding(Padding {
        top: 5.0,
        bottom: 5.0,
        left: 9.0,
        right: 9.0,
    })
    .on_press(message)
}

pub fn view(window: &MapEditorWindow) -> ThemedElement<'_, Message> {
    let mut rows = column![];
    if let Some(area_id) = window.editor.area_id() {
        rows = rows.push(map_row(window, area_id));
    }
    container(rows.push(edit_row(window)))
        .style(builtins::container::opaque)
        .width(Length::Fill)
        .into()
}

/// The open map's row: its name, then its Active switch and actions. A long
/// name is cut off at the right rather than crowding the actions out.
fn map_row(window: &MapEditorWindow, area_id: smudgy_cloud::AreaId) -> ThemedElement<'_, Message> {
    let name = window
        .mapper
        .get_current_atlas()
        .get_area(&area_id)
        .map(|area| area.get_name().to_string())
        .unwrap_or_default();
    let mut bar = row![
        container(
            text(name)
                .size(18)
                .font(Font {
                    weight: Weight::Semibold,
                    ..fonts::GEIST_VF
                })
                .wrapping(text::Wrapping::None)
        )
        .padding([0, 4])
        .width(Length::Fill)
        .clip(true),
        active_switch(window, area_id),
        space::horizontal().width(8.0),
    ]
    .align_y(Vertical::Center)
    .padding(4)
    .spacing(4);
    if window.can_share_active_area() && window.mapper.area_storage(&area_id) == MapStorage::Cloud {
        bar = bar.push(action_button(
            bootstrap_icons::SHARE,
            crate::i18n::t!("mapper-share"),
            Message::ShareDialogRequested,
            false,
        ));
    }
    if let Some(menu) = map_menu(window, area_id) {
        bar = bar.push(menu);
    }
    bar.into()
}

/// A thin rule between two groups of the editing row.
fn divider<'a>() -> ThemedElement<'a, Message> {
    container(rule::vertical(1))
        .height(18)
        .padding([0, 4])
        .into()
}

/// The editing row: the tools, the level stepper, undo/redo, and where new
/// content goes.
fn edit_row(window: &MapEditorWindow) -> ThemedElement<'_, Message> {
    let active_tool = window.editor.tool();
    // Rooms, labels and shapes go where "Add to" says; links still go into
    // the map.
    let can_edit = window.can_edit_active_area();
    let can_add = window.can_add_here();

    let tools = row![
        tool_button(
            bootstrap_icons::CURSOR,
            crate::i18n::ts!("mapper-tool-select"),
            Tool::Select,
            active_tool,
            true
        ),
        tool_button(
            bootstrap_icons::PLUS_SQUARE,
            crate::i18n::ts!("mapper-tool-add-room"),
            Tool::AddRoom,
            active_tool,
            can_add
        ),
        tool_button(
            bootstrap_icons::ARROW_REPEAT,
            crate::i18n::ts!("mapper-tool-link"),
            Tool::Link,
            active_tool,
            can_edit
        ),
        tool_button(
            bootstrap_icons::FONTS,
            crate::i18n::ts!("mapper-tool-add-label"),
            Tool::AddLabel,
            active_tool,
            can_add
        ),
        tool_button(
            bootstrap_icons::BOUNDING_BOX,
            crate::i18n::ts!("mapper-tool-add-shape"),
            Tool::AddShape,
            active_tool,
            can_add
        ),
    ]
    .spacing(2);

    let level = row![
        tooltip(
            icon_button(bootstrap_icons::CHEVRON_DOWN)
                .style(builtins::button::toolbar)
                .on_press(Message::LevelDown),
            crate::i18n::ts!("mapper-level-down"),
            tooltip::Position::Bottom,
        ),
        text(crate::i18n::t!("mapper-level", "level" => window.editor.level())).size(14),
        tooltip(
            icon_button(bootstrap_icons::CHEVRON_UP)
                .style(builtins::button::toolbar)
                .on_press(Message::LevelUp),
            crate::i18n::ts!("mapper-level-up"),
            tooltip::Position::Bottom,
        ),
    ]
    .spacing(2)
    .align_y(Vertical::Center);

    // Undo/redo replay mutations, so each entry is checked against the
    // places it writes (also enforced in the Hotkey::Undo/Redo handlers).
    let history = row![
        tooltip(
            icon_button(bootstrap_icons::ARROW_COUNTERCLOCKWISE)
                .style(builtins::button::toolbar)
                .on_press_maybe((window.can_undo() && window.may_undo()).then_some(Message::Undo)),
            crate::i18n::ts!("mapper-undo"),
            tooltip::Position::Bottom,
        ),
        tooltip(
            icon_button(bootstrap_icons::ARROW_CLOCKWISE)
                .style(builtins::button::toolbar)
                .on_press_maybe((window.can_redo() && window.may_redo()).then_some(Message::Redo)),
            crate::i18n::ts!("mapper-redo"),
            tooltip::Position::Bottom,
        ),
    ]
    .spacing(2);

    let mut bar = row![tools, divider(), level, divider(), history]
        .align_y(Vertical::Center)
        .padding(4)
        .spacing(4);
    if let Some(picker) = super::secrets::add_to_picker(window) {
        bar = bar.push(divider()).push(picker);
    }
    bar.into()
}

/// Whether the map is used to find your location: a switch showing its
/// state, the tooltip saying what that means.
fn active_switch(
    window: &MapEditorWindow,
    area_id: smudgy_cloud::AreaId,
) -> ThemedElement<'_, Message> {
    let enabled = window.mapper.is_area_enabled(&area_id);
    let (codepoint, label) = if enabled {
        (
            bootstrap_icons::TOGGLE_ON,
            crate::i18n::t!("inspector-active"),
        )
    } else {
        (
            bootstrap_icons::TOGGLE_OFF,
            crate::i18n::t!("inspector-inactive"),
        )
    };
    tooltip(
        button(
            row![
                text(codepoint).font(fonts::BOOTSTRAP_ICONS).size(ICON_SIZE),
                text(label).size(13.0),
            ]
            .spacing(6.0)
            .align_y(Vertical::Center),
        )
        .style(builtins::button::toolbar)
        .padding([3, 6])
        .on_press(Message::ToggleAreaEnabled(area_id)),
        container(text(crate::i18n::t!("inspector-active-help")).size(12))
            .padding(6.0)
            .style(builtins::container::tooltip),
        tooltip::Position::Bottom,
    )
    .into()
}

/// The ⋯ menu of the map's own actions; `None` when none applies.
fn map_menu(
    window: &MapEditorWindow,
    area_id: smudgy_cloud::AreaId,
) -> Option<ThemedElement<'_, Message>> {
    let storage = window.mapper.area_storage(&area_id);
    let cloud = storage == MapStorage::Cloud;
    let owned = window.area_owned(area_id);
    let atlas = window.mapper.get_current_atlas();
    let filed = atlas
        .get_area(&area_id)
        .is_some_and(|area| area.meta().atlas_id.is_some());

    // On a clan's map the map's own actions decide; on any other map, ownership.
    let may = |clan_action| window.may_manage_area(area_id, clan_action);
    let mut entries: Vec<(String, Message)> = Vec::new();
    if may(action::RENAME_AREA) {
        entries.push((
            crate::i18n::t!("mapper-menu-rename"),
            Message::RenameAreaStarted(area_id),
        ));
    }
    if cloud && owned {
        entries.push((
            crate::i18n::t!("mapper-duplicate"),
            Message::DuplicateAreaRequested,
        ));
    }
    if window.can_copy_active_area() {
        entries.push((
            crate::i18n::t!("mapper-copy-to-my-maps"),
            Message::CopyAreaRequested,
        ));
    }
    if may(action::REFILE_AREA) {
        let label = if storage == MapStorage::Session {
            crate::i18n::t!("mapper-menu-save")
        } else {
            crate::i18n::t!("mapper-menu-move-to-folder")
        };
        entries.push((label, Message::MoveAreaRequested(area_id)));
    }
    // A loose cloud map carries its own server checklist; a filed one is
    // scoped by its folder, and a clan's map by its clan.
    if cloud && !filed && window.area_clan(area_id).is_none() {
        entries.push((
            crate::i18n::t!("area-list-servers-action"),
            Message::ServersChecklistRequested(ScopeTarget::Area(area_id)),
        ));
    }
    // A clan's map is never transferred; it leaves the clan only as a copy.
    if cloud && owned && window.area_clan(area_id).is_none() {
        entries.push((
            crate::i18n::t!("mapper-transfer-action"),
            Message::TransferOwnershipRequested,
        ));
    }
    // A map someone put in a clan folder can be taken back out of the clan.
    if may(action::DELETE_AREA) {
        entries.push((
            crate::i18n::t!("mapper-menu-delete"),
            Message::DeleteAreaRequested(area_id),
        ));
    }
    if entries.is_empty() {
        return None;
    }

    let open = window.map_menu_open;
    let trigger = button(text("⋯").size(ICON_SIZE))
        .style(if open {
            builtins::button::toolbar_active
        } else {
            builtins::button::toolbar
        })
        .padding([3, 9])
        .on_press(Message::MapMenuToggled(!open));
    let menu = open.then(|| {
        let mut list = column![].spacing(2);
        for (label, message) in entries {
            list = list.push(
                button(text(label).size(12))
                    .width(Length::Fill)
                    .padding([6, 10])
                    .style(builtins::button::link)
                    .on_press(Message::MenuPicked(Box::new(message))),
            );
        }
        container(list)
            .width(200)
            .padding(6)
            .style(builtins::container::card)
            .into()
    });
    Some(Dropdown::new(trigger, menu, Message::MapMenuToggled(false)).into())
}

#[cfg(test)]
mod tests {
    use iced::Size;

    use super::super::headless::{layout, renderer, screenshot_if_asked};
    use super::super::links::fixture::{KEEP, area, maps, secret};

    use super::{edit_row, map_row};

    /// The canvas pane's width when the editor opens at iced's default
    /// 1024 px window: the map list takes 18% and the inspector 28% of the
    /// rest, each split giving up half the 4 px pane spacing.
    const DEFAULT_CANVAS_WIDTH: f32 = 601.0;

    /// The least of a map's name that stays visible beside its actions.
    const MIN_NAME_WIDTH: f32 = 100.0;

    /// The toolbar's widest case, a Secret chosen in "Add to" and the map
    /// holding Share and its ⋯ menu, fits the canvas at the editor's
    /// default size: the editing row whole, and the map's row with room
    /// left for its name.
    #[tokio::test]
    async fn both_rows_fit_the_canvas_at_the_default_window_size() {
        let mut window = super::super::test_window(maps().await, area(KEEP));
        window.secrets.add_to = Some((area(KEEP), secret()));
        screenshot_if_asked(&window, (1024, 768), "toolbar").await;
        let renderer = renderer().await;

        let edit = layout(
            edit_row(&window),
            &renderer,
            Size::new(f32::INFINITY, 200.0),
        );
        assert!(
            edit.size().width <= DEFAULT_CANVAS_WIDTH,
            "the editing row needs {} px",
            edit.size().width
        );

        let wide = 4000.0;
        let map = layout(
            map_row(&window, area(KEEP)),
            &renderer,
            Size::new(wide, 200.0),
        );
        assert_eq!(map.children().len(), 5, "name, Active, gap, Share, ⋯");
        // All of the row but the name, with the least of the name.
        let needed = wide - map.children()[0].bounds().width + MIN_NAME_WIDTH;
        assert!(
            needed <= DEFAULT_CANVAS_WIDTH,
            "the map's row needs {needed} px"
        );
    }
}
