use std::{ops::Range, sync::Arc};

use crate::{
    LinkSpan, Style, StyledLine, VtSpan,
    inline_content::{InlineContent, InlineDecoration, InlineFont, MAX_INLINE_DECORATIONS},
};

#[cfg(test)]
mod tests;

/// Ranges come from native matching: sorted, disjoint UTF-8 byte ranges.
pub(super) fn apply_shader(
    line: &Arc<StyledLine>,
    ranges: &[Range<usize>],
    effect: &InlineDecoration,
) -> Arc<StyledLine> {
    if ranges.is_empty() {
        return line.clone();
    }
    let mut result = (**line).clone();
    let mut effects: Vec<_> = line
        .decorations
        .iter()
        .flat_map(|effects| effects.iter())
        .filter(|effect| {
            let index = ranges.partition_point(|range| range.end <= effect.range.start);
            ranges
                .get(index)
                .is_none_or(|range| range.start >= effect.range.end)
        })
        .cloned()
        .collect();
    // All ranges replace overlapping effects, but only the newest bounded set
    // needs instances. The shader and packed uniforms remain shared.
    effects.extend(
        ranges
            .iter()
            .skip(ranges.len().saturating_sub(MAX_INLINE_DECORATIONS))
            .map(|range| {
                InlineDecoration::new(range.clone(), effect.effect.clone(), effect.owner.clone())
            }),
    );
    let excess = effects.len().saturating_sub(MAX_INLINE_DECORATIONS);
    effects.drain(..excess);
    result.decorations = Some(Arc::new(effects));
    Arc::new(result)
}

/// A validated callback result for one range. Native sharing proves which
/// presentation channels the callback left untouched; scripts cannot forge it.
#[derive(Debug, Clone)]
pub struct RichHighlight {
    range: Range<usize>,
    content: Arc<InlineContent>,
    keep_runs: bool,
    keep_fonts: bool,
}

impl RichHighlight {
    /// `original` must be the snapshot extracted from `range` on the target line.
    ///
    /// # Errors
    /// Rejects widgets and changes to the selected text.
    pub fn new(
        range: Range<usize>,
        original: &InlineContent,
        content: Arc<InlineContent>,
    ) -> Result<Self, &'static str> {
        if !content.objects.is_empty() {
            return Err("highlight callbacks must return text-only inline content");
        }
        let keep_runs = Arc::ptr_eq(&original.runs, &content.runs);
        if !keep_runs
            && !original
                .runs
                .iter()
                .flat_map(|run| run.text.bytes())
                .eq(content.runs.iter().flat_map(|run| run.text.bytes()))
        {
            return Err(
                "highlight callbacks must preserve the matched text; use replace to change it",
            );
        }
        Ok(Self {
            range,
            keep_runs,
            keep_fonts: Arc::ptr_eq(&original.fonts, &content.fonts),
            content,
        })
    }
}

/// Subtract sorted, disjoint edits from sorted coverage. A source interval may
/// span several edits, or overlap other source intervals (font overrides).
/// Unaffected entries move directly into the result without another clone.
fn retain_outside<T>(
    items: Vec<T>,
    edits: &[&RichHighlight],
    range_of: impl Fn(&T) -> Range<usize>,
    clipped: impl Fn(&T, Range<usize>) -> T,
) -> Vec<T> {
    let mut result = Vec::with_capacity(items.len());
    let mut first = 0;
    for item in items {
        let range = range_of(&item);
        while first < edits.len() && edits[first].range.end <= range.start {
            first += 1;
        }
        if first == edits.len() || edits[first].range.start >= range.end {
            result.push(item);
            continue;
        }
        let mut cursor = range.start;
        for edit in &edits[first..] {
            if edit.range.start >= range.end {
                break;
            }
            if cursor < edit.range.start {
                result.push(clipped(&item, cursor..edit.range.start));
            }
            cursor = cursor.max(edit.range.end);
        }
        if cursor < range.end {
            result.push(clipped(&item, cursor..range.end));
        }
    }
    result
}

pub(super) fn apply(line: &Arc<StyledLine>, highlights: &[RichHighlight]) -> Arc<StyledLine> {
    if highlights.is_empty() {
        return line.clone();
    }
    debug_assert!(
        highlights
            .windows(2)
            .all(|pair| pair[0].range.end <= pair[1].range.start)
    );
    // One line clone for the whole batch, including its text. Decoration-only
    // wrappers leave the original span/link structure and font Arc intact.
    let mut result = (**line).clone();
    let restyled: Vec<_> = highlights.iter().filter(|edit| !edit.keep_runs).collect();
    if !restyled.is_empty() {
        result.spans = retain_outside(
            result.spans,
            &restyled,
            |span| span.begin_pos..span.end_pos,
            |span, range| VtSpan {
                begin_pos: range.start,
                end_pos: range.end,
                style: span.style,
            },
        );
        result.links = retain_outside(
            result.links,
            &restyled,
            |link| link.begin_pos..link.end_pos,
            |link, range| LinkSpan {
                begin_pos: range.start,
                end_pos: range.end,
                ..link.clone()
            },
        );
        for edit in restyled {
            let index = line
                .spans
                .partition_point(|span| span.begin_pos <= edit.range.start);
            let base = index
                .checked_sub(1)
                .map_or(Style::DEFAULT, |i| line.spans[i].style);
            let mut cursor = edit.range.start;
            let fresh_links = result.links.len();
            for run in edit.content.runs.iter() {
                let end = cursor + run.text.len();
                if end == cursor {
                    continue;
                }
                result.spans.push(VtSpan {
                    begin_pos: cursor,
                    end_pos: end,
                    style: Style {
                        fg: run.fg.unwrap_or(base.fg),
                        bg: run.bg.unwrap_or(base.bg),
                        attributes: run.attributes.apply_to(base.attributes),
                    },
                });
                if let Some(link) = &run.link {
                    let merge = result.links.len() > fresh_links;
                    match result.links.last_mut() {
                        Some(previous)
                            if merge
                                && previous.end_pos == cursor
                                && previous.action == link.action
                                && previous.tooltip == link.tooltip
                                && previous.style == link.style =>
                        {
                            previous.end_pos = end
                        }
                        _ => result.links.push(LinkSpan {
                            begin_pos: cursor,
                            end_pos: end,
                            action: link.action.clone(),
                            tooltip: link.tooltip.clone(),
                            style: link.style.clone(),
                        }),
                    }
                }
                cursor = end;
            }
        }
        result.spans.sort_by_key(|span| span.begin_pos);
        result.links.sort_by_key(|link| link.begin_pos);
    }
    let refonted: Vec<_> = highlights.iter().filter(|edit| !edit.keep_fonts).collect();
    if !refonted.is_empty() {
        let mut fonts = retain_outside(
            result
                .fonts
                .take()
                .map_or_else(Vec::new, |fonts| (*fonts).clone()),
            &refonted,
            |font| font.range.clone(),
            |font, range| InlineFont {
                range,
                options: font.options.clone(),
            },
        );
        for edit in refonted {
            fonts.extend(
                edit.content
                    .fonts
                    .iter()
                    .map(|font| font.shifted(edit.range.start)),
            );
        }
        fonts.sort_by_key(|font| font.range.start);
        fonts.truncate(4096);
        result.fonts = (!fonts.is_empty()).then(|| Arc::new(fonts));
    }
    // Existing effects that overlap any match are replaced, including when the
    // callback returns its input unchanged. Disjoint effects retain identity/time.
    let mut effects: Vec<_> = result
        .decorations
        .iter()
        .flat_map(|effects| effects.iter())
        .filter(|effect| {
            let index = highlights.partition_point(|edit| edit.range.end <= effect.range.start);
            highlights
                .get(index)
                .is_none_or(|edit| edit.range.start >= effect.range.end)
        })
        .cloned()
        .collect();
    for edit in highlights {
        effects.extend(
            edit.content
                .decorations
                .iter()
                .map(|effect| effect.instantiate(edit.range.start)),
        );
        // Keep temporary storage bounded even for a line with many matches.
        let excess = effects.len().saturating_sub(MAX_INLINE_DECORATIONS);
        effects.drain(..excess);
    }
    result.decorations = (!effects.is_empty()).then(|| Arc::new(effects));
    Arc::new(result)
}
