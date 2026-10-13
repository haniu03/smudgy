//! Rich callbacks operate on a whole match across independent style/link/font runs.
use super::*;
use smudgy_session_model::inline_content::{InlineFont, InlineFontOptions};
use smudgy_session_model::{AnsiColor, Color, LinkAction, Style, StyledLink, VtSpan};

pub(super) fn source(prefix: &str) -> Arc<StyledLine> {
    let mut line = StyledLine::new(
        &format!("{prefix} caféXYZ + caféXYZ"),
        vec![
            VtSpan {
                begin_pos: 0,
                end_pos: 9,
                style: Style {
                    fg: Color::Ansi {
                        color: AnsiColor::Green,
                        bold: false,
                    },
                    ..Style::DEFAULT
                },
            },
            VtSpan {
                begin_pos: 9,
                end_pos: 23,
                style: Style {
                    fg: Color::Ansi {
                        color: AnsiColor::Blue,
                        bold: false,
                    },
                    ..Style::DEFAULT
                },
            },
        ],
    );
    line.relink(
        6,
        11,
        Some(StyledLink {
            action: LinkAction::Send("original link".into()),
            tooltip: None,
            style: None,
        }),
    );
    line.fonts = Some(Arc::new(vec![InlineFont {
        range: 7..12,
        options: InlineFontOptions {
            font_size: Some(24),
            font_face: Some("serif".into()),
            ..Default::default()
        },
    }]));
    Arc::new(line)
}

#[tokio::test]
async fn highlight_callbacks_preserve_rich_fragments_and_validate_before_writing() {
    let _fixture_lock = SESSION_FIXTURE_LOCK.lock().await;
    let (_home, _root, params) = support::session_fixture(include_str!("highlight.tsx"), &[]);
    let mut events = Box::pin(spawn_with_package_provider(
        params,
        effects_package_provider(),
    ));
    let mut tx = None;
    let mut current = None;
    let mut stored = None;
    let mut invalid = None;
    let mut checked_errors = false;
    let mut checked_mutation = false;
    let mut checked_sequence = false;
    let mut checked_widget = false;
    let mut checked_mixed = false;
    let mut stored_batches = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let event = tokio::time::timeout_at(deadline, events.next())
            .await
            .expect("highlight transcript deadline")
            .expect("session closed");
        match event.event {
            SessionEvent::RuntimeReady(sender) => tx = Some(sender),
            SessionEvent::UpdateBuffer(updates) => {
                for update in updates.iter() {
                    if let BufferUpdate::Append(line) = update {
                        match line.text.as_str() {
                            "HIGHLIGHT_READY" => feed_cases(tx.as_ref().unwrap()),
                            "Foo caféXYZ + caféXYZ" => current = Some(line.clone()),
                            "Old caféXYZ + caféXYZ" => stored = Some(line.clone()),
                            "Bad caféXYZ + caféXYZ" => invalid = Some(line.clone()),
                            "HIGHLIGHT_ERRORS_CHECKED" => checked_errors = true,
                            "HIGHLIGHT_MUTATION_CHECKED" => checked_mutation = true,
                            "HIGHLIGHT_WIDGET_CHECKED" => checked_widget = true,
                            "Obj caféXYZ + caféXYZ" => {
                                assert!(line.decorations.is_none());
                                assert_eq!(line.objects.as_ref().unwrap().len(), 1);
                            }
                            "Mut caféXYZ + caféXYZ" => assert!(
                                line.decorations.is_none(),
                                "outer highlight must not overwrite callback edits"
                            ),
                            "Seq caféXYZ" => {
                                assert_eq!(line.decorations.as_ref().unwrap()[0].range, 4..12);
                                assert_eq!(
                                    line.fonts.as_ref().unwrap()[0].options.font_size,
                                    Some(28)
                                );
                                checked_sequence = true;
                            }
                            "Mix caféXYZ + caféXYZ" => {
                                assert_mixed_highlight(line);
                                checked_mixed = true;
                            }
                            "HIGHLIGHT_DONE" => {
                                assert!(checked_errors);
                                assert!(checked_mutation);
                                assert!(checked_sequence);
                                assert!(checked_widget);
                                assert!(checked_mixed);
                                assert_eq!(
                                    stored_batches, 1,
                                    "both matches share one stored-line operation"
                                );
                                assert_rich_highlight(current.as_ref().unwrap());
                                assert_rich_highlight(stored.as_ref().unwrap());
                                assert_eq!(
                                    invalid.as_ref().unwrap().as_ref(),
                                    source("Bad").as_ref(),
                                    "failed transforms must not change the line"
                                );
                                drop(events);
                                join_fixture_runtime().await;
                                return;
                            }
                            _ => {}
                        }
                    }
                }
            }
            SessionEvent::PerformLineOperation { operation, .. } => {
                if let smudgy_session_model::LineOperation::HighlightRich { highlights } =
                    operation.as_ref()
                    && highlights.len() == 2
                {
                    stored_batches += 1;
                }
                stored = Some(operation.apply(stored.as_ref().expect("stored row")));
            }
            _ => {}
        }
    }
}

fn feed_cases(sender: &tokio::sync::mpsc::UnboundedSender<RuntimeAction>) {
    for line in [
        source("Foo"),
        source("Old"),
        source("Bad"),
        source("Mut"),
        source("Obj"),
        source("Mix"),
        Arc::new(StyledLine::from_output_str("Seq foo")),
        Arc::new(StyledLine::from_output_str("edit-stored")),
        Arc::new(StyledLine::from_output_str("verify-highlights")),
    ] {
        sender
            .send(RuntimeAction::HandleIncomingLine(line))
            .unwrap();
    }
    sender.send(RuntimeAction::RequestRepaint).unwrap();
}

fn assert_mixed_highlight(line: &StyledLine) {
    let effects = line.decorations.as_ref().unwrap();
    assert_eq!(effects.len(), 1);
    assert_eq!(effects[0].range, 4..12);
    let span = line.spans.iter().find(|span| span.begin_pos == 15).unwrap();
    assert!(matches!(
        span.style.fg,
        Color::Ansi {
            color: AnsiColor::Red,
            ..
        }
    ));
    assert!(span.style.attributes.bold);
    assert!(
        line.fonts
            .as_ref()
            .unwrap()
            .iter()
            .any(|font| font.range == (15..23) && font.options.font_size == Some(32))
    );
}

fn assert_rich_highlight(line: &StyledLine) {
    let effects = line.decorations.as_ref().unwrap();
    assert_eq!(effects.len(), 2);
    assert_eq!(
        effects[0].range,
        15..23,
        "one effect spans all runs of the second match"
    );
    assert_eq!(
        effects[1].range,
        7..12,
        "overlapping old effect replaced; Unicode range snapped"
    );
    assert_ne!(effects[0].id, effects[1].id);
    assert_eq!(effects[0].effect.duration_ms, 2000);
    assert_eq!(effects[1].effect.duration_ms, 1200);
    assert!(effects.iter().all(|effect| {
        effect
            .effect
            .shader
            .shader
            .label
            .ends_with("possession.wgsl")
    }));
    for (offset, color, bold) in [
        (4, AnsiColor::Red, true),
        (9, AnsiColor::Blue, false),
        (15, AnsiColor::Blue, false),
    ] {
        let span = line
            .spans
            .iter()
            .find(|span| span.begin_pos <= offset && offset < span.end_pos)
            .unwrap();
        assert!(matches!(span.style.fg, Color::Ansi { color: actual, .. } if actual == color));
        assert_eq!(span.style.attributes.bold, bold);
    }
    // Wrapping preserves each native link and its coverage across style boundaries.
    for offset in 6..11 {
        let coverage = line
            .links
            .iter()
            .find(|link| link.begin_pos <= offset && offset < link.end_pos)
            .unwrap();
        assert_eq!(coverage.action, LinkAction::Send("original link".into()));
    }
    for offset in 15..20 {
        let coverage = line
            .links
            .iter()
            .find(|link| link.begin_pos <= offset && offset < link.end_pos)
            .unwrap();
        assert!(
            matches!(coverage.action, LinkAction::Callback { .. }),
            "native callback identity survives extraction and reapplication"
        );
    }
    for offset in 7..12 {
        let font = line
            .fonts
            .as_ref()
            .unwrap()
            .iter()
            .find(|font| font.range.contains(&offset))
            .unwrap();
        assert_eq!(font.options.font_size, Some(24));
        assert_eq!(font.options.font_face.as_deref(), Some("serif"));
    }
}
