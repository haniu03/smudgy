use super::*;
use crate::{
    Color, LineOperation, LinkAction, StyledLink,
    inline_content::{InlineDecoration, InlineFontOptions, InlineOwner, TextEffect},
    text_shader::{Shader, ShaderEffect},
};

fn source() -> Arc<StyledLine> {
    let mut line = StyledLine::new_with_raw(
        "aébcdefgh",
        vec![
            VtSpan {
                begin_pos: 0,
                end_pos: 4,
                style: Style::DEFAULT,
            },
            VtSpan {
                begin_pos: 4,
                end_pos: 10,
                style: Style {
                    fg: Color::Rgb {
                        r: 20,
                        g: 80,
                        b: 40,
                    },
                    ..Style::DEFAULT
                },
            },
        ],
        Some(b"original wire bytes"),
    );
    line.relink(
        0,
        10,
        Some(StyledLink {
            action: LinkAction::Send("look".into()),
            tooltip: None,
            style: None,
        }),
    );
    line.fonts = Some(Arc::new(vec![InlineFont {
        range: 0..10,
        options: InlineFontOptions {
            font_size: Some(24),
            ..Default::default()
        },
    }]));
    Arc::new(line)
}

fn decoration(range: Range<usize>) -> InlineDecoration {
    InlineDecoration::new(
        range,
        TextEffect {
            shader: Arc::new(ShaderEffect {
                pane: false,
                scale: Default::default(),
                capture_scale: Default::default(),
                fade_in_ms: 0,
                fade_out_ms: 0,
                replace: false,
                hold: false,
                animated: true,
                shader: Shader::compile(
                    "identity.wgsl",
                    "fn effect(p: vec2f) -> vec4f { return sampleText(p); }",
                )
                .unwrap(),
                uniforms: vec![0; 16].into(),
            }),
            duration_ms: 2000,
            outset: 24,
        },
        InlineOwner::default(),
    )
}

fn assert_coverage(actual: &StyledLine, expected: &StyledLine) {
    assert_eq!(actual.text, expected.text);
    assert_eq!(actual.raw(), expected.raw());
    for at in 0..actual.text.len() {
        let style = |line: &StyledLine| {
            line.spans
                .iter()
                .find(|span| span.begin_pos <= at && at < span.end_pos)
                .map(|span| span.style)
        };
        let link = |line: &StyledLine| {
            line.links
                .iter()
                .find(|link| link.begin_pos <= at && at < link.end_pos)
                .map(|link| {
                    (
                        link.action.clone(),
                        link.tooltip.clone(),
                        link.style.clone(),
                    )
                })
        };
        let fonts = |line: &StyledLine| {
            line.fonts
                .iter()
                .flat_map(|fonts| fonts.iter())
                .filter(|font| font.range.contains(&at))
                .map(|font| font.options.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(style(actual), style(expected), "style at {at}");
        assert_eq!(link(actual), link(expected), "link at {at}");
        assert_eq!(fonts(actual), fonts(expected), "font at {at}");
    }
    assert!(
        actual
            .spans
            .windows(2)
            .all(|pair| pair[0].end_pos <= pair[1].begin_pos)
    );
    assert!(
        actual
            .links
            .windows(2)
            .all(|pair| pair[0].end_pos <= pair[1].begin_pos)
    );
}

#[test]
fn wrappers_preserve_span_link_and_font_structure_and_replace_overlapping_effects() {
    let mut line = source();
    let old = decoration(0..1);
    Arc::make_mut(&mut line).decorations = Some(Arc::new(vec![old.clone(), decoration(1..5)]));
    let highlights = [1..5, 7..10]
        .into_iter()
        .map(|range| {
            let original = InlineContent::from_line_range(&line, range.clone()).unwrap();
            let mut wrapped = original.clone();
            wrapped.decorations = Arc::new(vec![decoration(0..range.len())]);
            RichHighlight::new(range, &original, Arc::new(wrapped)).unwrap()
        })
        .collect();
    let operation = LineOperation::HighlightRich {
        highlights: Arc::new(highlights),
    };
    assert!(operation.preserves_text_before(usize::MAX));
    let result = operation.apply(&line);
    assert_eq!(result.text, line.text);
    assert_eq!(result.spans, line.spans);
    assert_eq!(result.links, line.links);
    assert!(Arc::ptr_eq(
        result.fonts.as_ref().unwrap(),
        line.fonts.as_ref().unwrap()
    ));
    let effects = result.decorations.as_ref().unwrap();
    assert_eq!(effects.len(), 3);
    assert_eq!(effects[0], old);
    assert_eq!(effects[1].range, 1..5);
    assert_eq!(effects[2].range, 7..10);
    assert_ne!(effects[1].id, effects[2].id);
}

#[test]
fn changed_styles_links_and_fonts_match_splices_across_unicode_boundaries() {
    let line = source();
    let boundaries: Vec<_> = line
        .text
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(line.text.len()))
        .collect();
    for (index, &begin) in boundaries.iter().enumerate() {
        for &end in &boundaries[index + 1..] {
            let original = InlineContent::from_line_range(&line, begin..end).unwrap();
            let mut changed = original.clone();
            for run in Arc::make_mut(&mut changed.runs) {
                run.fg = None; // Unset channels inherit the style at the match start.
                run.attributes.bold = Some(true);
                run.link = None;
            }
            changed.fonts = Arc::new(vec![InlineFont {
                range: 0..end - begin,
                options: InlineFontOptions {
                    font_size: Some(32),
                    ..Default::default()
                },
            }]);
            let changed = Arc::new(changed);
            let expected = LineOperation::SpliceRich {
                begin,
                end,
                content: changed.clone(),
            }
            .apply(&line);
            let result = apply(
                &line,
                &[RichHighlight::new(begin..end, &original, changed).unwrap()],
            );
            assert_coverage(&result, &expected);
        }
    }
}

#[test]
fn mixed_batch_matches_sequential_splices_including_adjacent_ranges() {
    let line = source();
    let mut expected = line.clone();
    let mut highlights = Vec::new();
    for (index, range) in [1..5, 5..7, 8..10].into_iter().enumerate() {
        let original = InlineContent::from_line_range(&line, range.clone()).unwrap();
        let mut changed = original.clone();
        if index == 0 {
            for run in Arc::make_mut(&mut changed.runs) {
                run.bg = Some(Color::Rgb { r: 80, g: 0, b: 0 });
                run.link = None;
            }
        } else if index == 2 {
            changed.fonts = Arc::default();
        }
        let changed = Arc::new(changed);
        expected = LineOperation::SpliceRich {
            begin: range.start,
            end: range.end,
            content: changed.clone(),
        }
        .apply(&expected);
        highlights.push(RichHighlight::new(range, &original, changed).unwrap());
    }
    assert_coverage(&apply(&line, &highlights), &expected);
}

#[test]
fn unchanged_return_clears_effects_and_changed_text_is_rejected() {
    let mut line = source();
    Arc::make_mut(&mut line).decorations = Some(Arc::new(vec![decoration(1..5)]));
    let original = InlineContent::from_line_range(&line, 1..5).unwrap();
    let unchanged = RichHighlight::new(1..5, &original, Arc::new(original.clone())).unwrap();
    let result = apply(&line, &[unchanged]);
    assert!(result.decorations.is_none());
    assert_coverage(&result, &line);
    let mut changed = original.clone();
    Arc::make_mut(&mut changed.runs)[0].text = "bad".into();
    assert!(RichHighlight::new(1..5, &original, Arc::new(changed)).is_err());
}

#[test]
fn direct_shader_shares_settings_and_preserves_source_metadata() {
    let mut line = source();
    let old = decoration(0..1);
    Arc::make_mut(&mut line).decorations = Some(Arc::new(vec![old.clone(), decoration(1..5)]));
    let effect = Arc::new(decoration(0..0));
    let operation = LineOperation::HighlightShader {
        ranges: Arc::new(vec![1..5, 7..10]),
        effect: effect.clone(),
    };
    assert!(operation.preserves_text_before(usize::MAX));
    let result = operation.apply(&line);
    assert_eq!(result.text, line.text);
    assert_eq!(result.raw(), line.raw());
    assert_eq!(result.spans, line.spans);
    assert_eq!(result.links, line.links);
    assert!(Arc::ptr_eq(
        result.fonts.as_ref().unwrap(),
        line.fonts.as_ref().unwrap()
    ));
    let effects = result.decorations.as_ref().unwrap();
    assert_eq!(effects.len(), 3);
    assert_eq!(effects[0], old);
    assert_eq!(effects[1].range, 1..5);
    assert_eq!(effects[2].range, 7..10);
    assert_ne!(effects[1].id, effects[2].id);
    for actual in &effects[1..] {
        assert!(Arc::ptr_eq(&actual.effect.shader, &effect.effect.shader));
    }
    assert!(Arc::ptr_eq(&apply_shader(&line, &[], &effect), &line));
}

#[test]
fn direct_shader_retains_only_the_newest_bounded_instances() {
    let mut line = Arc::new(StyledLine::from_output_str(&"x".repeat(100)));
    Arc::make_mut(&mut line).decorations = Some(Arc::new(vec![decoration(0..1)]));
    let ranges: Vec<_> = (0..100).map(|at| at..at + 1).collect();
    let result = apply_shader(&line, &ranges, &decoration(0..0));
    let effects = result.decorations.as_ref().unwrap();
    assert_eq!(effects.len(), MAX_INLINE_DECORATIONS);
    assert_eq!(effects[0].range.start, 100 - MAX_INLINE_DECORATIONS);
    assert_eq!(effects.last().unwrap().range, 99..100);
    assert!(effects.windows(2).all(|pair| pair[0].id != pair[1].id));
}
