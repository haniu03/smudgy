//! Where a pane comes from, as the Layout menu and tab tooltips describe it:
//! the session it belongs to and the code that created it.
//!
//! Panes are get-or-create within a namespace, so the namespace — not any
//! one script — is the creator: user scripts share one, and each package
//! has its own, named by its global package name.

use std::sync::Arc;

use smudgy_session_model::pane::{PaneDef, PaneNamespace};

/// The code a pane belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneCreator {
    /// The session's main pane: the session itself, created by no script.
    Session,
    /// A pane created by the user's own scripts.
    UserScripts,
    /// A pane created by the package of this name.
    Package(Arc<str>),
}

impl PaneCreator {
    /// The creator of a script pane's definition.
    #[must_use]
    pub fn of(def: &PaneDef) -> Self {
        if def.is_main {
            return Self::Session;
        }
        match &def.namespace {
            PaneNamespace::User => Self::UserScripts,
            PaneNamespace::Package(package) => Self::Package(Arc::clone(&package.name)),
        }
    }

    /// The creator as shown beside the pane: `@name` for a package, the
    /// localized "Your scripts" for the user's own. `None` for the main
    /// pane, which only its session describes.
    #[must_use]
    pub fn label(&self, text: impl Fn(&'static str) -> String) -> Option<String> {
        match self {
            Self::Session => None,
            Self::UserScripts => Some(text("pane-creator-user-scripts")),
            Self::Package(name) => Some(format!("@{name}")),
        }
    }
}

/// A pane tab's tooltip: its session, then its creator on a second line.
/// `None` for a main pane, whose tab label already names its session.
#[must_use]
pub fn tooltip_text(
    session: &str,
    creator: &PaneCreator,
    text: impl Fn(&'static str) -> String,
) -> Option<String> {
    creator
        .label(text)
        .map(|creator| format!("{session}\n{creator}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use smudgy_session_model::pane::{
        MAIN_PANE_KEY, PaneKey, PaneKind, PaneNameId, TitleBarPolicy,
    };

    fn def(namespace: PaneNamespace, is_main: bool) -> PaneDef {
        PaneDef {
            key: if is_main {
                MAIN_PANE_KEY
            } else {
                PaneKey::from_u32(7)
            },
            name_id: PaneNameId::from_u32(1),
            name: Arc::from("chat"),
            namespace,
            kind: PaneKind::Terminal,
            is_main,
            title_bar: TitleBarPolicy::Normal,
            hidden: false,
            font_size: None,
            input: None,
        }
    }

    fn english(id: &'static str) -> String {
        match id {
            "pane-creator-user-scripts" => "Your scripts".to_owned(),
            other => other.to_owned(),
        }
    }

    #[test]
    fn packages_read_as_their_global_name() {
        let creator = PaneCreator::of(&def(PaneNamespace::package("wkalata", "chat-tabs"), false));
        assert_eq!(creator.label(english).as_deref(), Some("@chat-tabs"));
        assert_eq!(
            tooltip_text("imm (Arctic)", &creator, english).as_deref(),
            Some("imm (Arctic)\n@chat-tabs")
        );
    }

    #[test]
    fn user_panes_read_as_your_scripts_and_main_tabs_carry_no_tooltip() {
        let user = PaneCreator::of(&def(PaneNamespace::User, false));
        assert_eq!(user.label(english).as_deref(), Some("Your scripts"));
        let main = PaneCreator::of(&def(PaneNamespace::User, true));
        assert_eq!(main, PaneCreator::Session);
        assert_eq!(tooltip_text("imm (Arctic)", &main, english), None);
    }
}
