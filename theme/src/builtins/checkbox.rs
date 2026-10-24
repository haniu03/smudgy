use crate::Theme;
use iced::widget::checkbox;
use iced::{Background, Border};

pub type StyleFn<'a, Theme> = Box<dyn Fn(&Theme, checkbox::Status) -> checkbox::Style + 'a>;

impl checkbox::Catalog for Theme {
    type Class<'a> = StyleFn<'a, Theme>;

    fn default<'a>() -> Self::Class<'a> {
        Box::new(default)
    }

    fn style(&self, class: &Self::Class<'_>, status: checkbox::Status) -> checkbox::Style {
        class(self, status)
    }
}

#[must_use]
pub fn default(theme: &Theme, status: checkbox::Status) -> checkbox::Style {
    let (is_checked, is_hovered, disabled) = match status {
        checkbox::Status::Active { is_checked } => (is_checked, false, false),
        checkbox::Status::Hovered { is_checked } => (is_checked, true, false),
        checkbox::Status::Disabled { is_checked } => (is_checked, false, true),
    };
    let alpha = if disabled { 0.45 } else { 1.0 };

    let background = if is_checked {
        theme.styles.general.accent
    } else {
        theme.styles.general.container_background
    };

    let border_color = if is_hovered {
        theme.styles.general.accent
    } else {
        theme.styles.general.border
    };

    checkbox::Style {
        background: Background::Color(background.scale_alpha(alpha)),
        icon_color: theme.styles.text.normal.scale_alpha(alpha),
        border: Border {
            color: border_color.scale_alpha(alpha),
            width: 1.0,
            radius: 2.0.into(),
        },
        text_color: Some(theme.styles.text.normal.scale_alpha(alpha)),
    }
}
