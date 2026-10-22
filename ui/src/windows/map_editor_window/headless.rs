//! Headless rendering for the editor's layout tests: a tiny-skia renderer
//! with the bundled fonts, element layout at a given size, and screenshots
//! of the whole editor for looking at a layout by eye.

use iced::advanced::{
    Layout,
    layout::{Limits, Node},
    renderer::{Headless, Style},
    widget::Tree,
};
use iced::{Rectangle, Size, mouse};

use crate::assets::fonts;
use crate::theme::Element as ThemedElement;

use super::{MapEditorWindow, Message};

/// The variable naming the directory [`screenshot_if_asked`] saves into.
pub const SCREENSHOTS: &str = "SMUDGY_EDITOR_SCREENSHOTS";

pub async fn renderer() -> iced::Renderer {
    {
        let mut font_system = iced_graphics::text::font_system().write().unwrap();
        font_system.load_font(fonts::GEIST_VF_BYTES.into());
        font_system.load_font(fonts::BOOTSTRAP_ICONS_BYTES.into());
    }
    <iced::Renderer as Headless>::new(fonts::GEIST_VF, 16.0.into(), Some("tiny-skia"))
        .await
        .unwrap()
}

/// `element` laid out within `max`.
pub fn layout(
    mut element: ThemedElement<'_, Message>,
    renderer: &iced::Renderer,
    max: Size,
) -> Node {
    let mut tree = Tree::new(element.as_widget());
    element
        .as_widget_mut()
        .layout(&mut tree, renderer, &Limits::new(Size::ZERO, max))
}

/// With [`SCREENSHOTS`] set, saves the whole editor drawn at `width` ×
/// `height` there as `<name>-<width>.png`.
pub async fn screenshot_if_asked(
    window: &MapEditorWindow,
    (width, height): (u32, u32),
    name: &str,
) {
    let Some(dir) = std::env::var_os(SCREENSHOTS) else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    let size = Size::new(width as f32, height as f32);
    let mut renderer = renderer().await;
    let mut element = window.view();
    let mut tree = Tree::new(element.as_widget());
    let node = element
        .as_widget_mut()
        .layout(&mut tree, &renderer, &Limits::new(Size::ZERO, size));
    let theme = smudgy_theme::smudgy();
    element.as_widget().draw(
        &tree,
        &mut renderer,
        &theme,
        &Style {
            text_color: theme.styles.text.normal,
        },
        Layout::new(&node),
        mouse::Cursor::Unavailable,
        &Rectangle::with_size(size),
    );
    std::fs::create_dir_all(&dir).unwrap();
    image::save_buffer(
        dir.join(format!("{name}-{width}.png")),
        &renderer.screenshot(
            Size::new(width, height),
            1.0,
            theme.styles.general.background,
        ),
        width,
        height,
        image::ColorType::Rgba8,
    )
    .unwrap();
}
