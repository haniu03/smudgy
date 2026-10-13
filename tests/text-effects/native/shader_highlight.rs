//! Imported WGSL highlights use one native operation without extracting style runs.
use super::*;
use smudgy_session_model::{LineOperation, Style, VtSpan};

#[tokio::test]
async fn direct_shaders_preserve_mixed_styles_and_validate_the_whole_batch() {
    let _fixture_lock = SESSION_FIXTURE_LOCK.lock().await;
    let (_home, _root, params) = support::session_fixture(
        include_str!("shader_highlight.tsx"),
        &[(
            "plain.wgsl",
            "fn effect(p: vec2f) -> vec4f { return sampleText(p); }",
        )],
    );
    let mut events = Box::pin(spawn_with_package_provider(
        params,
        effects_package_provider(),
    ));
    let mut sender = None;
    let mut lines = Vec::new();
    let mut stored = None;
    let mut stored_batches = 0;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    'collect: loop {
        let event = tokio::time::timeout_at(deadline, events.next())
            .await
            .unwrap_or_else(|_| panic!("shader highlight transcript: {lines:?}"))
            .expect("session closed");
        match event.event {
            SessionEvent::RuntimeReady(tx) => sender = Some(tx),
            SessionEvent::UpdateBuffer(updates) => {
                for update in updates.iter() {
                    if let BufferUpdate::Append(line) = update {
                        match line.text.as_str() {
                            "SHADER_READY" => feed_cases(sender.as_ref().unwrap()),
                            "Old caféXYZ + caféXYZ" => stored = Some(line.clone()),
                            "SHADER_DONE" => break 'collect,
                            _ => {}
                        }
                        lines.push(line.clone());
                    }
                }
            }
            SessionEvent::PerformLineOperation { operation, .. } => {
                let LineOperation::HighlightShader { ranges, .. } = operation.as_ref() else {
                    panic!("expected a single shader operation");
                };
                assert_eq!(ranges.as_ref(), &[4..12, 15..23]);
                stored_batches += 1;
                stored = Some(operation.apply(stored.as_ref().expect("stored row")));
            }
            _ => {}
        }
    }
    sender.unwrap().send(RuntimeAction::Shutdown).unwrap();
    drop(events);
    join_fixture_runtime().await;
    assert_eq!(stored_batches, 1);
    assert_results(&lines, stored.as_ref().unwrap());
}

fn feed_cases(sender: &tokio::sync::mpsc::UnboundedSender<RuntimeAction>) {
    for prefix in ["Dir", "Old", "Idx", "Bad", "Obj"] {
        sender
            .send(RuntimeAction::HandleIncomingLine(highlight::source(prefix)))
            .unwrap();
    }
    let heavy = StyledLine::new(
        &format!("Heavy {}", "x".repeat(5000)),
        (0..5006)
            .map(|at| VtSpan {
                begin_pos: at,
                end_pos: at + 1,
                style: {
                    let mut style = Style::DEFAULT;
                    style.attributes.bold = at % 2 == 0;
                    style
                },
            })
            .collect(),
    );
    for line in [
        Arc::new(heavy),
        Arc::new(StyledLine::from_output_str("Seq foo")),
        Arc::new(StyledLine::from_output_str("edit-stored")),
        Arc::new(StyledLine::from_output_str("verify-shaders")),
    ] {
        sender
            .send(RuntimeAction::HandleIncomingLine(line))
            .unwrap();
    }
    sender.send(RuntimeAction::RequestRepaint).unwrap();
}

fn assert_results(lines: &[Arc<StyledLine>], stored: &StyledLine) {
    let find = |text: &str| {
        lines
            .iter()
            .find(|line| line.text == text)
            .unwrap_or_else(|| {
                panic!(
                    "missing {text}; transcript: {:?}",
                    lines
                        .iter()
                        .map(|line| line.text.chars().take(160).collect::<String>())
                        .collect::<Vec<_>>()
                )
            })
    };
    find("SHADER_ERRORS_CHECKED");
    find("SHADER_WIDGET_CHECKED");
    let direct = find("Dir caféXYZ + caféXYZ");
    for (line, prefix) in [(direct.as_ref(), "Dir"), (stored, "Old")] {
        let original = highlight::source(prefix);
        assert_eq!(line.text, original.text);
        assert_eq!(line.spans, original.spans);
        assert_eq!(line.links, original.links);
        assert_eq!(line.fonts, original.fonts);
        let effects = line.decorations.as_ref().unwrap();
        assert_eq!(effects.len(), 2);
        assert_eq!(effects[0].range, 4..12);
        assert_eq!(effects[1].range, 15..23);
        assert_ne!(effects[0].id, effects[1].id);
        assert!(Arc::ptr_eq(
            &effects[0].effect.shader,
            &effects[1].effect.shader
        ));
    }
    let default = &direct.decorations.as_ref().unwrap()[0].effect;
    assert_eq!((default.duration_ms, default.outset), (0, 32));
    assert_eq!(default.shader.scale.get().to_bits(), 1.0_f32.to_bits());
    assert_eq!(
        default.shader.capture_scale.get().to_bits(),
        1.0_f32.to_bits()
    );
    assert!(default.shader.animated);
    assert!(!default.shader.replace && !default.shader.hold && !default.shader.pane);
    let custom = &stored.decorations.as_ref().unwrap()[0].effect;
    assert_eq!((custom.duration_ms, custom.outset), (2000, 48));
    assert_eq!(custom.shader.scale.get().to_bits(), 2.0_f32.to_bits());
    assert_eq!(
        custom.shader.capture_scale.get().to_bits(),
        2.0_f32.to_bits()
    );
    assert_eq!(
        (custom.shader.fade_in_ms, custom.shader.fade_out_ms),
        (100, 200)
    );
    assert!(custom.shader.replace && custom.shader.hold && custom.shader.pane);
    assert!(!custom.shader.animated);
    assert_eq!(&custom.shader.uniforms[..4], &0.75_f32.to_le_bytes());
    let indexed = find("Idx caféXYZ + caféXYZ");
    assert_eq!(indexed.decorations.as_ref().unwrap()[0].range, 7..12);
    assert_eq!(
        find("Bad caféXYZ + caféXYZ").as_ref(),
        highlight::source("Bad").as_ref()
    );
    let objects = find("Obj caféXYZ + caféXYZ");
    assert!(objects.decorations.is_none());
    assert_eq!(objects.objects.as_ref().unwrap().len(), 1);
    let sequence = find("Seq caféXYZ");
    assert_eq!(sequence.decorations.as_ref().unwrap()[0].range, 4..12);
    assert_eq!(
        sequence.fonts.as_ref().unwrap()[0].options.font_size,
        Some(28)
    );
    let heavy = find(&format!("Heavy {}", "x".repeat(5000)));
    assert_eq!(heavy.spans.len(), 5006);
    assert_eq!(heavy.decorations.as_ref().unwrap()[0].range, 6..5006);
}

#[tokio::test]
async fn direct_shader_permission_does_not_grant_display_access() {
    use smudgy_core::models::shared_packages::{self, UpdateMode};
    let _fixture_lock = SESSION_FIXTURE_LOCK.lock().await;
    let (_home, _root, params) = support::session_fixture("", &[]);
    let specifier = "smudgy:@text-effects";
    shared_packages::install_package("InlineWidgets", specifier, UpdateMode::Auto, true).unwrap();
    let manifest = smudgy_script::PackageManifest::parse(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../packages/text-effects/smudgy.package.json"
    )))
    .unwrap();
    assert!(!manifest.permissions.smudgy.change_display);
    shared_packages::record_consent("InlineWidgets", specifier, &manifest.permissions).unwrap();
    let entry = r#"
import {buffer, echo} from "smudgy:core";
const shader = globalThis.__smudgy_compile_text_shader(
    "allowed.wgsl", "fn effect(p: vec2f) -> vec4f { return sampleText(p); }");
for (const attempt of [
    () => buffer.line(999999).highlight("text", shader),
    () => buffer.line(999999).highlightAt(0, 4, shader),
]) {
    try { attempt(); }
    catch (error) {
        if (String(error).includes("change-display")) { echo("DISPLAY_DENIED"); continue; }
        throw error;
    }
    throw Error("shader permission must not authorize display changes");
}
echo("DISPLAY_GATE_READY");
"#;
    let mut events = Box::pin(spawn_with_package_provider(
        params,
        effects_package_provider_with_entry(Some(entry), true),
    ));
    let mut sender = None;
    let mut lines = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    'collect: loop {
        let event = tokio::time::timeout_at(deadline, events.next())
            .await
            .unwrap_or_else(|_| panic!("display permission transcript: {lines:?}"))
            .expect("session closed");
        match event.event {
            SessionEvent::RuntimeReady(tx) => sender = Some(tx),
            SessionEvent::UpdateBuffer(updates) => {
                for update in updates.iter() {
                    if let BufferUpdate::Append(line) = update {
                        lines.push(line.text.clone());
                        if line.text == "DISPLAY_GATE_READY" {
                            break 'collect;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    assert_eq!(
        lines
            .iter()
            .filter(|line| *line == "DISPLAY_DENIED")
            .count(),
        2
    );
    sender.unwrap().send(RuntimeAction::Shutdown).unwrap();
    drop(events);
    join_fixture_runtime().await;
    shared_packages::uninstall_package("InlineWidgets", specifier).unwrap();
}
