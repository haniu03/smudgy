use iced::Background;
use iced::widget::text::Span;
use selection::Selection;
use std::borrow::Cow;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use crate::prefs::TerminalPrefs;
use smudgy_core::session::runtime::line_operation::LineOperation;
use smudgy_core::session::styled_line::{
    Blink, Color, LinkAction, LinkColor, LinkDecoration, LinkSpan, LinkStyle, LinkTextStyle,
    LinkTooltip, Style, StyledLine, Underline,
};
use std::collections::{HashSet, VecDeque};
use std::num::NonZeroUsize;
use unicode_segmentation::UnicodeSegmentation;

#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SpanMetadata {
    pub blink: Blink,
    pub underline: LinkDecoration,
    pub overline: LinkDecoration,
    pub strikethrough: LinkDecoration,
    pub decoration_color: Option<iced::Color>,
}

type Link = SpanMetadata;

pub mod selection;

/// A click on a link span, as delivered to the pane's `on_link` handler.
#[derive(Debug, Clone)]
pub struct LinkClickEvent {
    pub action: LinkAction,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
}

/// The chip fill behind a link: a nearly-transparent wash of the text's own
/// foreground. The alpha matches the Markdown widget's link chip, so a link whose
/// foreground is the Markdown link color renders identically to a Markdown link.
const LINK_WASH_ALPHA: f32 = 0.14;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinkRenderStyle {
    pub authored: bool,
    pub style: LinkTextStyle,
    pub spoiler_concealed: bool,
    pub hidden: bool,
}

impl LinkRenderStyle {
    fn base(link: &LinkSpan) -> Self {
        Self {
            authored: link.style.is_some(),
            style: link
                .style
                .as_ref()
                .map_or_else(LinkTextStyle::default, |style| style.base.clone()),
            spoiler_concealed: false,
            hidden: false,
        }
    }
}

/// Bidirectional byte-offset mapping between the immutable source line and the
/// text actually shaped by the renderer. Most lines are identity-mapped;
/// concealed spoilers need a real map because one grapheme becomes one space.
#[derive(Debug, Clone, Default)]
pub(crate) enum RenderedOffsets {
    #[default]
    Identity,
    Mapped {
        source: Rc<[usize]>,
        rendered: Rc<[usize]>,
    },
}

impl RenderedOffsets {
    fn map(offset: usize, from: &[usize], to: &[usize]) -> usize {
        if offset == usize::MAX {
            return usize::MAX;
        }
        match from.binary_search(&offset) {
            Ok(index) => to[index],
            Err(0) => 0,
            Err(index) if index == from.len() => *to.last().unwrap_or(&0),
            Err(index) => {
                let from_start = from[index - 1];
                let from_end = from[index];
                let to_start = to[index - 1];
                let to_end = to[index];
                if from_end - from_start == to_end - to_start {
                    to_start + offset - from_start
                } else {
                    // Selection/link offsets should land on grapheme boundaries.
                    // If an external edit leaves one inside a concealed cluster,
                    // snap to its beginning rather than exposing partial text.
                    to_start
                }
            }
        }
    }

    pub(crate) fn source_to_rendered(&self, offset: usize) -> usize {
        match self {
            Self::Identity => offset,
            Self::Mapped { source, rendered } => Self::map(offset, source, rendered),
        }
    }

    pub(crate) fn rendered_to_source(&self, offset: usize) -> usize {
        match self {
            Self::Identity => offset,
            Self::Mapped { source, rendered } => Self::map(offset, rendered, source),
        }
    }

    pub(crate) fn map_selection(
        &self,
        selection: Option<(usize, usize)>,
    ) -> Option<(usize, usize)> {
        selection.map(|(from, to)| (self.source_to_rendered(from), self.source_to_rendered(to)))
    }
}

#[derive(Debug)]
pub(crate) struct RenderedSpans {
    pub(crate) spans: Rc<Vec<Span<'static, Link>>>,
    pub(crate) offsets: RenderedOffsets,
}

#[derive(Debug)]
struct RenderedOffsetsBuilder {
    source: Vec<usize>,
    rendered: Vec<usize>,
    source_end: usize,
    rendered_end: usize,
}

impl Default for RenderedOffsetsBuilder {
    fn default() -> Self {
        Self {
            source: vec![0],
            rendered: vec![0],
            source_end: 0,
            rendered_end: 0,
        }
    }
}

impl RenderedOffsetsBuilder {
    fn push(&mut self, source: &str, rendered: &str) {
        let mut rendered_graphemes = rendered.graphemes(true);
        for source_grapheme in source.graphemes(true) {
            let rendered_grapheme = rendered_graphemes
                .next()
                .expect("rendered terminal text preserves grapheme count");
            self.source_end += source_grapheme.len();
            self.rendered_end += rendered_grapheme.len();
            self.source.push(self.source_end);
            self.rendered.push(self.rendered_end);
        }
        debug_assert!(rendered_graphemes.next().is_none());
    }

    fn finish(self) -> RenderedOffsets {
        if self.source == self.rendered {
            RenderedOffsets::Identity
        } else {
            RenderedOffsets::Mapped {
                source: self.source.into(),
                rendered: self.rendered.into(),
            }
        }
    }
}

struct RenderedSpansBuilder<'a> {
    spans: Vec<Span<'static, Link>>,
    offsets: RenderedOffsetsBuilder,
    prefs: &'a TerminalPrefs,
    line_hidden: bool,
}

impl<'a> RenderedSpansBuilder<'a> {
    fn new(capacity: usize, prefs: &'a TerminalPrefs, line_hidden: bool) -> Self {
        Self {
            spans: Vec::with_capacity(capacity),
            offsets: RenderedOffsetsBuilder::default(),
            prefs,
            line_hidden,
        }
    }

    fn push(
        &mut self,
        text: &str,
        style: Style,
        linked: bool,
        link_style: Option<&LinkRenderStyle>,
    ) {
        let span = make_resolved_span(
            text,
            style,
            linked,
            link_style,
            self.line_hidden,
            self.prefs,
        );
        self.offsets.push(text, span.text.as_ref());
        self.spans.push(span);
    }

    fn finish(self) -> RenderedSpans {
        RenderedSpans {
            spans: Rc::new(self.spans),
            offsets: self.offsets.finish(),
        }
    }
}

/// One renderable segment: underlined over the foreground wash when linked (unless
/// the span sets an explicit background, which wins — the underline stays).
/// "Explicit" is judged by the resolved color model: `bg: "default"` normalizes to
/// `DefaultBackground` at the op boundary and so still washes, while a background
/// literally painted the theme's background color counts as explicit and doesn't.
#[inline]
pub(crate) fn make_span(
    text: &str,
    style: Style,
    linked: bool,
    link_style: Option<&LinkStyle>,
    prefs: &TerminalPrefs,
) -> Span<'static, Link> {
    let resolved = link_style.map(|style| LinkRenderStyle {
        authored: true,
        style: style.base.clone(),
        spoiler_concealed: false,
        hidden: false,
    });
    make_resolved_span(text, style, linked, resolved.as_ref(), false, prefs)
}

#[inline]
fn make_resolved_span(
    text: &str,
    style: Style,
    linked: bool,
    link_style: Option<&LinkRenderStyle>,
    line_hidden: bool,
    prefs: &TerminalPrefs,
) -> Span<'static, Link> {
    let mut attributes = style.attributes;
    let authored = link_style.map(|style| &style.style);
    let sgr_bold = attributes.bold;
    let authored_bold = authored.and_then(|style| style.bold);
    // OSC-authored bold is literal styling. The preference only controls how
    // an SGR bold attribute is presented, and an authored `bold: false`
    // suppresses both of that SGR attribute's visual effects.
    let bold_weight =
        authored_bold.unwrap_or_else(|| sgr_bold && prefs.bold_mode.uses_bold_weight());
    let bold_brightness =
        sgr_bold && authored_bold != Some(false) && prefs.bold_mode.uses_bright_palette();
    if let Some(value) = authored.and_then(|style| style.italic) {
        attributes.italic = value;
    }
    let logical_fg = if bold_brightness {
        match style.fg {
            Color::Ansi { color, bold: false } => Color::Ansi { color, bold: true },
            Color::DefaultForeground { bold: false } => Color::DefaultForeground { bold: true },
            other => other,
        }
    } else {
        style.fg
    };
    let terminal_color = |color| match color {
        Color::DefaultBackground => prefs.palette.background,
        other => prefs.resolve(other),
    };
    let authored_color = |color: LinkColor| {
        iced::Color::from_rgba8(
            color.red,
            color.green,
            color.blue,
            f32::from(color.alpha) / 255.0,
        )
    };
    let logical_fg = authored
        .and_then(|style| style.foreground)
        .map_or_else(|| terminal_color(logical_fg), authored_color);
    let logical_bg = authored
        .and_then(|style| style.background)
        .map(authored_color)
        .or_else(|| (style.bg != Color::DefaultBackground).then(|| terminal_color(style.bg)));
    let (mut fg, mut background) = if attributes.reverse {
        (
            logical_bg.unwrap_or(prefs.palette.background),
            Some(logical_fg),
        )
    } else {
        (logical_fg, logical_bg)
    };
    if attributes.faint {
        fg.a *= 0.5;
    }
    let mut font = prefs.font;
    if bold_weight {
        font.weight = iced::font::Weight::Bold;
    }
    if attributes.italic {
        font.style = iced::font::Style::Italic;
    }
    let sgr_underline = match attributes.underline {
        Underline::None => LinkDecoration::None,
        Underline::Single => LinkDecoration::Solid,
        Underline::Double => LinkDecoration::Double,
    };
    let mut underline = authored
        .and_then(|style| style.underline)
        .unwrap_or(sgr_underline);
    if linked
        && !link_style.is_some_and(|style| style.authored)
        && underline == LinkDecoration::None
    {
        underline = LinkDecoration::Solid;
    }
    let overline = authored
        .and_then(|style| style.overline)
        .unwrap_or(LinkDecoration::None);
    let strikethrough =
        authored
            .and_then(|style| style.strikethrough)
            .unwrap_or(if attributes.crossed_out {
                LinkDecoration::Solid
            } else {
                LinkDecoration::None
            });
    let decoration_color = authored
        .and_then(|style| style.decoration_color)
        .map(authored_color);
    let hidden = line_hidden || link_style.is_some_and(|style| style.hidden);
    let spoiler_concealed = link_style.is_some_and(|style| style.spoiler_concealed);
    if spoiler_concealed {
        underline = LinkDecoration::None;
    }
    if hidden {
        fg = iced::Color::TRANSPARENT;
        background = None;
        underline = LinkDecoration::None;
    }
    let overline = if hidden || spoiler_concealed {
        LinkDecoration::None
    } else {
        overline
    };
    let strikethrough = if hidden || spoiler_concealed {
        LinkDecoration::None
    } else {
        strikethrough
    };
    let decoration_color = (!hidden && !spoiler_concealed)
        .then_some(decoration_color)
        .flatten();
    // Color emoji glyphs do not necessarily honor a span foreground, so
    // painting foreground and background alike cannot reliably conceal them.
    // Shape one ordinary space per grapheme instead; reveal re-bakes the
    // original text, while the offset map keeps hit-testing and selection tied
    // to the immutable source line.
    let rendered_text = if spoiler_concealed {
        text.graphemes(true).map(|_| ' ').collect()
    } else {
        text.to_string()
    };
    let mut span = Span::<'static, Link>::new(Cow::Owned(rendered_text))
        .color(fg)
        .font(font)
        .underline(underline != LinkDecoration::None)
        .strikethrough(strikethrough != LinkDecoration::None);
    // Only a meaningful background sets the span highlight: the widget draws a
    // quad per highlighted span region, so the (overwhelmingly common) default
    // background must stay decoration-free rather than painting a quad of the
    // pane's own color under every span.
    if linked
        && !link_style.is_some_and(|style| style.authored)
        && background.is_none()
        && !hidden
        && !spoiler_concealed
    {
        span = span.background(Background::Color(iced::Color {
            a: LINK_WASH_ALPHA,
            ..fg
        }));
    } else if let Some(bg) = background {
        span = span.background(Background::Color(bg));
    }
    let metadata = SpanMetadata {
        blink: attributes.blink,
        underline,
        overline,
        strikethrough,
        decoration_color,
    };
    if metadata == SpanMetadata::default() {
        span
    } else {
        span.link(metadata)
    }
}

/// Bakes a styled line's semantic colors into renderable spans using the
/// given palette. Style spans are split at link boundaries so linked ranges get
/// the link affordance without disturbing the line's own colors.
#[inline]
fn to_spans(styled_line: &Arc<StyledLine>, prefs: &TerminalPrefs) -> Rc<Vec<Span<'static, Link>>> {
    to_spans_with(styled_line, prefs, false, LinkRenderStyle::base).spans
}

fn to_spans_with(
    styled_line: &Arc<StyledLine>,
    prefs: &TerminalPrefs,
    line_hidden: bool,
    resolve: impl Fn(&LinkSpan) -> LinkRenderStyle,
) -> RenderedSpans {
    let mut rendered = RenderedSpansBuilder::new(styled_line.spans.len(), prefs, line_hidden);
    for span_info in &styled_line.spans {
        let (begin, end) = (span_info.begin_pos, span_info.end_pos);
        if styled_line.links.is_empty() || begin == end {
            rendered.push(&styled_line.text[begin..end], span_info.style, false, None);
            continue;
        }
        // Links are sorted and non-overlapping; walk the ones intersecting this span,
        // alternating plain and linked segments.
        let mut cursor = begin;
        for link in &styled_line.links {
            if link.end_pos <= cursor {
                continue;
            }
            if link.begin_pos >= end {
                break;
            }
            let linked_begin = link.begin_pos.max(cursor);
            if linked_begin > cursor {
                rendered.push(
                    &styled_line.text[cursor..linked_begin],
                    span_info.style,
                    false,
                    None,
                );
            }
            let linked_end = link.end_pos.min(end);
            let resolved = resolve(link);
            rendered.push(
                &styled_line.text[linked_begin..linked_end],
                span_info.style,
                true,
                Some(&resolved),
            );
            cursor = linked_end;
        }
        if cursor < end {
            rendered.push(&styled_line.text[cursor..end], span_info.style, false, None);
        }
    }
    rendered.finish()
}

/// Clamp a byte offset to `text`'s length and snap it down to the nearest char
/// boundary, yielding an offset that is always safe to slice `text` at.
#[inline]
fn clamp_to_char_boundary(text: &str, mut col: usize) -> usize {
    if col >= text.len() {
        return text.len();
    }
    while col > 0 && !text.is_char_boundary(col) {
        col -= 1;
    }
    col
}

#[inline]
fn strip_possessive_suffix(word: &str) -> &str {
    if let Some(stripped) = word.strip_suffix("'s") {
        stripped
    } else if let Some(stripped) = word.strip_suffix("'S") {
        stripped
    } else if let Some(stripped) = word.strip_suffix("’s") {
        stripped
    } else if let Some(stripped) = word.strip_suffix("’S") {
        stripped
    } else {
        word
    }
}

impl AsRef<[Span<'static, SpanMetadata>]> for BufferLine {
    fn as_ref(&self) -> &[Span<'static, SpanMetadata>] {
        self.spans().as_slice()
    }
}

#[derive(Debug, Clone)]
pub struct BufferLine {
    pub styled_line: Arc<StyledLine>,
    /// Renderable spans, baked from `styled_line` on first access. Lazy so a
    /// line that scrolls through the buffer unseen (a burst larger than the
    /// window, scrollback eviction) never pays `to_spans` at all; only lines
    /// the pane actually lays out are baked. Cleared — not eagerly rebaked —
    /// on palette changes and line edits.
    spans: std::cell::OnceCell<Rc<Vec<Span<'static, SpanMetadata>>>>,
}

impl PartialEq for BufferLine {
    fn eq(&self, other: &Self) -> bool {
        self.styled_line == other.styled_line
    }
}

impl From<Arc<StyledLine>> for BufferLine {
    fn from(styled_line: Arc<StyledLine>) -> Self {
        Self {
            spans: std::cell::OnceCell::new(),
            styled_line,
        }
    }
}

impl BufferLine {
    /// The line's renderable spans, baking them against the current palette on
    /// first access. The returned `Rc` is pointer-stable until the spans are
    /// invalidated (palette change, line edit) — the pane's paragraph cache
    /// keys on that identity.
    pub fn spans(&self) -> &Rc<Vec<Span<'static, SpanMetadata>>> {
        self.spans.get_or_init(|| {
            let prefs = crate::prefs::current();
            to_spans(&self.styled_line, &prefs)
        })
    }

    pub(crate) fn spans_with_link_state(
        &self,
        prefs: &TerminalPrefs,
        line_hidden: bool,
        resolve: impl Fn(&LinkSpan) -> LinkRenderStyle,
    ) -> RenderedSpans {
        to_spans_with(&self.styled_line, prefs, line_hidden, resolve)
    }

    pub(crate) fn rendered_spans(&self) -> RenderedSpans {
        RenderedSpans {
            spans: self.spans().clone(),
            offsets: RenderedOffsets::Identity,
        }
    }

    /// Drop the baked spans so the next access re-bakes them (and downstream
    /// paragraph caches, keyed on the `Rc` identity, naturally miss).
    fn invalidate_spans(&mut self) {
        self.spans.take();
    }
}

#[derive(Debug)]
pub struct TerminalBuffer {
    lines: VecDeque<BufferLine>,
    max_lines: NonZeroUsize,
    line_terminated: bool,
    last_line_number: usize,
    /// The prefs generation the lines' spans were baked with; see
    /// [`Self::refresh_styles`].
    span_generation: u64,
    /// How many held lines carry link spans, maintained at every structural
    /// mutation — so the per-frame hover path can skip hit testing entirely on
    /// the (overwhelmingly common) linkless buffer via [`Self::has_links`].
    lines_with_links: usize,
    /// Bumped whenever keyboard focus returns to this pane's command editor.
    /// Terminal widget instances observe the epoch and drop their independent
    /// link-navigation focus before processing further keyboard input.
    link_navigation_reset_epoch: u64,
    visibility_input_epoch: u64,
    visibility_prompt_epoch: u64,
    visibility_output_epoch: u64,
    visibility_last_output: Option<Instant>,
}

impl Default for TerminalBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalBuffer {
    /// Creates a new, empty `TerminalBuffer` with a default line limit (e.g., 10,000 lines).
    /// The internal buffer is pre-allocated to this default limit.
    pub fn new() -> Self {
        const DEFAULT_MAX_LINES: usize = 10_000;
        let max_lines =
            NonZeroUsize::new(DEFAULT_MAX_LINES).expect("Default max lines is non-zero");
        Self::new_with_max_lines(max_lines)
    }

    /// Creates a new `TerminalBuffer` with a specified maximum number of lines.
    ///
    /// # Arguments
    ///
    /// * `max_lines`: The maximum number of lines the buffer can hold. Must be non-zero.
    ///   The internal `VecDeque` will be initialized with this capacity.
    pub fn new_with_max_lines(max_lines: NonZeroUsize) -> Self {
        Self {
            lines: VecDeque::with_capacity(max_lines.get()),
            max_lines,
            line_terminated: false,
            last_line_number: 0,
            span_generation: crate::prefs::current().generation,
            lines_with_links: 0,
            link_navigation_reset_epoch: 0,
            visibility_input_epoch: 0,
            visibility_prompt_epoch: 0,
            visibility_output_epoch: 0,
            visibility_last_output: None,
        }
    }

    pub fn note_visibility_input(&mut self) {
        self.visibility_input_epoch = self.visibility_input_epoch.wrapping_add(1);
    }

    pub fn note_command_input_focus(&mut self) {
        self.link_navigation_reset_epoch = self.link_navigation_reset_epoch.wrapping_add(1);
    }

    pub(crate) fn link_navigation_reset_epoch(&self) -> u64 {
        self.link_navigation_reset_epoch
    }

    pub fn note_visibility_prompt(&mut self) {
        self.visibility_prompt_epoch = self.visibility_prompt_epoch.wrapping_add(1);
    }

    pub fn note_visibility_output(&mut self) {
        self.visibility_output_epoch = self.visibility_output_epoch.wrapping_add(1);
        self.visibility_last_output = Some(Instant::now());
    }

    pub(crate) fn visibility_epochs(&self) -> (u64, u64, u64, Option<Instant>) {
        (
            self.visibility_input_epoch,
            self.visibility_prompt_epoch,
            self.visibility_output_epoch,
            self.visibility_last_output,
        )
    }

    /// Whether any held line carries a link span. O(1); the per-frame hover
    /// path uses it to skip hit testing on linkless buffers.
    pub fn has_links(&self) -> bool {
        self.lines_with_links > 0
    }

    /// Account for `line` entering the buffer (call beside every push).
    fn note_added(&mut self, line: &BufferLine) {
        if !line.styled_line.links.is_empty() {
            self.lines_with_links += 1;
        }
    }

    /// Account for `line` leaving the buffer (call on every pop).
    fn note_removed(&mut self, line: &BufferLine) {
        if !line.styled_line.links.is_empty() {
            self.lines_with_links -= 1;
        }
    }

    /// Pop the oldest line, keeping the link accounting straight.
    fn evict_front(&mut self) {
        if let Some(line) = self.lines.pop_front() {
            self.note_removed(&line);
        }
    }

    /// Changes the scrollback limit, trimming the oldest lines if the buffer
    /// already exceeds it.
    pub fn set_max_lines(&mut self, max_lines: NonZeroUsize) {
        self.max_lines = max_lines;
        while self.lines.len() > max_lines.get() {
            self.evict_front();
        }
    }

    /// Invalidates every line's baked spans if the preferences changed since
    /// they were built (palette swaps, etc.), so visible lines re-bake against
    /// the new palette on their next layout — and never-shown scrollback pays
    /// nothing. Dropping the span `Rc`s naturally invalidates downstream
    /// paragraph caches. Cheap one-off per settings change; a no-op otherwise.
    pub fn refresh_styles(&mut self) {
        let prefs = crate::prefs::current();
        if prefs.generation == self.span_generation {
            return;
        }

        for line in &mut self.lines {
            line.invalidate_spans();
        }

        self.span_generation = prefs.generation;
    }

    pub fn commit_current_line(&mut self) {
        self.line_terminated = true;
    }

    pub fn extend_line(&mut self, line_in: Arc<StyledLine>) {
        if self.line_terminated {
            self.last_line_number += 1;
            self.line_terminated = false;

            while self.lines.len() > (self.max_lines.get() - 1) {
                self.evict_front();
            }

            let line: BufferLine = line_in.into();
            self.note_added(&line);
            self.lines.push_back(line);
        } else {
            match self.lines.pop_back() {
                Some(line) => {
                    self.note_removed(&line);
                    let joined: BufferLine = Arc::new(line.styled_line.append(&line_in)).into();
                    self.note_added(&joined);
                    self.lines.push_back(joined);
                }
                None => {
                    self.last_line_number += 1;
                    let line: BufferLine = line_in.into();
                    self.note_added(&line);
                    self.lines.push_back(line);
                }
            }
        }
    }

    /// Adds a line to the buffer.
    /// If the buffer is at its `max_lines` capacity, the oldest line is removed.
    // Buffer-manipulation helper; exercised by tests and kept as part of the
    // buffer's coherent line API (the live path uses `extend_line`).
    #[allow(dead_code)]
    pub fn push_line(&mut self, line: Arc<StyledLine>) {
        self.last_line_number += 1;

        let limit = self.max_lines.get();

        // Remove oldest lines if the buffer is at or would exceed the limit.
        // We want lines.len() to be at most limit - 1 before push_back,
        // so that after push_back, lines.len() is at most limit.
        while self.lines.len() >= limit {
            self.evict_front();
        }
        let line: BufferLine = line.into();
        self.note_added(&line);
        self.lines.push_back(line);
        self.line_terminated = true;
    }

    /// Returns a reverse iterator over the lines in the buffer.
    /// This allows iterating from the most recently added line to the oldest.
    // Part of the buffer's iteration API; kept alongside `iter_rev_with_offset`.
    #[allow(dead_code)]
    pub fn iter_rev(
        &self,
    ) -> impl DoubleEndedIterator<Item = &BufferLine> + ExactSizeIterator<Item = &BufferLine> {
        self.lines.iter().rev()
    }

    pub fn iter_rev_with_line_number(
        &self,
        last_line_number: Option<usize>,
    ) -> impl Iterator<Item = (usize, &BufferLine)> {
        let buffer_last_line_number = self.last_line_number;
        let to_skip = buffer_last_line_number - last_line_number.unwrap_or(buffer_last_line_number);
        self.lines
            .iter()
            .rev()
            .skip(to_skip)
            .zip(to_skip..)
            .map(move |(line, i)| (buffer_last_line_number - i, line))
    }

    /// Returns an iterator over the lines in the buffer, starting from an offset from the end and iterating in reverse.
    ///
    /// # Arguments
    ///
    /// * `offset`: The number of lines to skip from the end before starting reverse iteration.
    ///   An offset of 0 is equivalent to `iter_rev()`.
    // Part of the buffer's iteration API; kept for scrollback-offset rendering.
    #[allow(dead_code)]
    pub fn iter_rev_with_offset(
        &self,
        offset: usize,
    ) -> impl DoubleEndedIterator<Item = &BufferLine> + ExactSizeIterator<Item = &BufferLine> {
        self.lines.iter().rev().skip(offset)
    }

    /// Returns the current number of lines in the buffer.
    pub fn len(&self) -> usize {
        self.lines.len()
    }

    /// Returns `true` if the buffer contains no lines.
    // Kept as the conventional companion to `len()`.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    pub fn last_line_number(&self) -> usize {
        self.last_line_number
    }

    pub fn selected_text(&self, selection: &Selection) -> String {
        match selection {
            Selection::None => String::new(),
            Selection::Selecting { from, to, .. } | Selection::Selected { from, to } => {
                let offset = self.last_line_number - self.lines.len();

                // Selection line numbers are absolute and outlive the buffer:
                // a `clear()` (clear_lines) or scrollback eviction can leave a
                // stale selection pointing at lines that are no longer held.
                // Clamp to the live range `(offset, last_line_number]` and bail
                // when nothing overlaps, so the subtraction below never
                // underflows and `self.lines[i]` never indexes out of bounds.
                if self.lines.is_empty() || to.line <= offset || from.line > self.last_line_number {
                    return String::new();
                }
                let first_line = from.line.max(offset + 1);
                let last_line = to.line.min(self.last_line_number);
                let start_line_index = first_line - offset - 1;
                let to_line_index = last_line - offset - 1;
                // Only honor the selection's own column bounds on the lines
                // that survived the clamp; a clamped-in edge starts/ends whole.
                let use_from_column = first_line == from.line;
                let use_to_column = last_line == to.line;

                (start_line_index..=to_line_index)
                    .map(|i| {
                        let line = &self.lines[i];
                        let text = line.styled_line.text.as_str();
                        let start_column = if i == start_line_index && use_from_column {
                            from.column
                        } else {
                            0
                        };
                        let end_column = if i == to_line_index && use_to_column {
                            to.column
                        } else {
                            text.len()
                        };

                        // Selection columns are byte offsets into the rendered line; clamp
                        // to the text and snap to char boundaries so copy can never slice
                        // past the end or mid-codepoint (either of which panics).
                        let start_column = clamp_to_char_boundary(text, start_column);
                        let end_column = clamp_to_char_boundary(text, end_column).max(start_column);

                        &text[start_column..end_column]
                    })
                    .collect::<Vec<&str>>()
                    .join("\n")
            }
        }
    }

    /// Finds the most recent word matching the given prefix.
    /// Tokens are broken apart using any non-alphanumeric delimiter (e.g., `:`, `/`,
    /// `]`, etc.) while preserving useful in-word punctuation like apostrophes and
    /// hyphens. If the user types a delimiter in the prefix, the full token (including
    /// the delimiter and the segment that follows) is matched. Trailing punctuation is
    /// stripped automatically so words like `guard:Awful,` stay searchable. Possessive
    /// endings (`'s`) are removed unless the prefix itself contains an apostrophe.
    ///
    /// # Arguments
    /// * `prefix` - The prefix to match against (case-insensitive)
    /// * `skip_words_in` - Optional set of words to ignore in the search (exact match)
    /// * `skip_words_folded` - Borrowed sets of lowercase-folded words to
    ///   ignore case-insensitively (candidates are folded before the check):
    ///   the completion blacklist and the offered-registered-suggestion
    ///   filter, passed as the caller already holds them — no per-call union
    ///   set is materialized
    /// * `n_recent_lines` - Number of recent lines to search through
    ///
    /// # Returns
    /// * `Option<String>` - The matching word if found, or None otherwise
    pub fn find_recent_word_by_prefix(
        &self,
        prefix: &str,
        skip_words_in: Option<&HashSet<String>>,
        skip_words_folded: &[&HashSet<String>],
        n_recent_lines: usize,
    ) -> Option<String> {
        let lowercase_prefix = prefix.to_lowercase();
        let is_internal_punctuation =
            |c: char| matches!(c, '\'' | '’' | '-' | '‐' | '‑' | '‒' | '–' | '—' | '_');
        let is_segment_delimiter = |c: char| !c.is_alphanumeric() && !is_internal_punctuation(c);
        let prefix_contains_delimiter = prefix.chars().any(is_segment_delimiter);
        let prefix_contains_apostrophe = prefix.chars().any(|c| matches!(c, '\'' | '’'));

        let consider_candidate = |candidate: &str| -> Option<String> {
            let candidate_for_match = if prefix_contains_apostrophe {
                candidate
            } else {
                strip_possessive_suffix(candidate)
            };

            if candidate_for_match.is_empty() {
                return None;
            }

            if let Some(history) = skip_words_in
                && history.contains(candidate_for_match)
            {
                return None;
            }

            let folded_candidate = candidate_for_match.to_lowercase();
            if skip_words_folded
                .iter()
                .any(|folded| folded.contains(&folded_candidate))
            {
                return None;
            }

            if folded_candidate.starts_with(&lowercase_prefix) {
                return Some(candidate_for_match.to_string());
            }

            None
        };

        self.lines
            .iter()
            .rev()
            .take(n_recent_lines)
            .find_map(|line| {
                // Split line by whitespace to get words
                for raw_word in line.styled_line.text.split_whitespace() {
                    // Clean the word by trimming non-alphanumeric chars from start/end
                    let word = raw_word.trim_matches(|c: char| !c.is_alphanumeric());

                    // Skip empty words
                    if word.is_empty() {
                        continue;
                    }

                    if prefix_contains_delimiter {
                        if let Some(result) = consider_candidate(word) {
                            return Some(result);
                        }
                        continue;
                    }

                    let mut segment_start: Option<usize> = None;

                    for (idx, ch) in word.char_indices() {
                        if is_segment_delimiter(ch) {
                            if let Some(start) = segment_start.take()
                                && start != idx
                                && let Some(result) = consider_candidate(&word[start..idx])
                            {
                                return Some(result);
                            }
                        } else if segment_start.is_none() {
                            segment_start = Some(idx);
                        }
                    }

                    if let Some(start) = segment_start
                        && let Some(result) = consider_candidate(&word[start..])
                    {
                        return Some(result);
                    }
                }
                None
            })
    }

    /// The link action under byte `column` of absolute line `line_number`, if any.
    /// Backs the pane's hover cursor and click dispatch.
    pub fn link_at(&self, line_number: usize, column: usize) -> Option<LinkAction> {
        self.link_span_at(line_number, column)
            .map(|link| link.action)
    }

    pub(crate) fn link_span_at(&self, line_number: usize, column: usize) -> Option<LinkSpan> {
        let offset = self.last_line_number - self.lines.len();
        if line_number <= offset || line_number > self.last_line_number {
            return None;
        }
        let line = self.lines.get(line_number - offset - 1)?;
        line.styled_line
            .links
            .iter()
            .find(|link| link.begin_pos <= column && column < link.end_pos)
            .cloned()
    }

    pub(crate) fn all_link_spans(&self) -> Vec<(usize, LinkSpan)> {
        let offset = self.last_line_number - self.lines.len();
        self.lines
            .iter()
            .enumerate()
            .flat_map(|(index, line)| {
                let line_number = offset + index + 1;
                line.styled_line
                    .links
                    .iter()
                    .cloned()
                    .map(move |link| (line_number, link))
            })
            .collect()
    }

    /// The tooltip metadata under byte `column` of absolute line `line_number`.
    /// Kept separate from click lookup so hover can resolve lazy script copy
    /// without manufacturing a click event.
    pub fn link_tooltip_at(&self, line_number: usize, column: usize) -> Option<LinkTooltip> {
        let offset = self.last_line_number - self.lines.len();
        if line_number <= offset || line_number > self.last_line_number {
            return None;
        }
        let line = self.lines.get(line_number - offset - 1)?;
        line.styled_line
            .links
            .iter()
            .find(|link| link.begin_pos <= column && column < link.end_pos)
            .and_then(|link| link.tooltip.clone())
    }

    pub fn perform_line_operation(&mut self, line_number: usize, operation: LineOperation) {
        let offset = self.last_line_number - self.lines.len();
        // A line older than the buffer holds (scrolled out, or dropped by
        // `clear_lines`) has no index here; without this guard the subtraction
        // below underflows.
        if line_number <= offset {
            return;
        }
        let line_number = line_number - offset - 1;
        if let Some(line) = self.lines.get_mut(line_number) {
            let had_links = !line.styled_line.links.is_empty();
            line.styled_line = operation.apply(&line.styled_line);
            line.invalidate_spans();
            // An edit can add or drop a line's links; keep the O(1) count true.
            let has_links = !line.styled_line.links.is_empty();
            if has_links && !had_links {
                self.lines_with_links += 1;
            } else if !has_links && had_links {
                self.lines_with_links -= 1;
            }
        }
    }

    /// Drop the unterminated tail line (core's `RetractOpenLine`): the line's
    /// text is being routed elsewhere. Rolls the line number back so the next
    /// line takes the retracted one's number — exactly the accounting core
    /// keeps (`emitted_line_count` never counted the open line). A no-op when
    /// no line is open.
    pub fn retract_open_line(&mut self) {
        if !self.line_terminated
            && let Some(line) = self.lines.pop_back()
        {
            self.note_removed(&line);
            self.last_line_number -= 1;
            self.line_terminated = true;
        }
    }

    /// Clear the scrollback (`pane.clear()`), keeping the line numbering —
    /// numbers keep increasing across a clear so core/UI parity is untouched.
    pub fn clear_lines(&mut self) {
        self.lines.clear();
        self.lines_with_links = 0;
        self.line_terminated = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use smudgy_core::session::connection::vt_processor::AnsiColor;
    use smudgy_core::session::styled_line::{Blink, StyledLine, TextAttributes, Underline, VtSpan};
    use std::num::NonZeroUsize; // Assuming VtSpan is needed for StyledLine::new

    // Helper to create Arc<StyledLine> for tests
    fn sl(s: &str) -> Arc<StyledLine> {
        Arc::new(StyledLine::new(s, Vec::<VtSpan>::new()))
    }

    #[test]
    fn test_new_buffer_initial_state() {
        let buffer = TerminalBuffer::new();
        assert_eq!(buffer.len(), 0);
        assert!(buffer.is_empty());
        assert_eq!(buffer.last_line_number, 0);
        assert_eq!(buffer.max_lines.get(), 10_000); // Default max lines
        assert!(!buffer.line_terminated); // Initial state before any line commit or push
    }

    #[test]
    fn test_new_with_max_lines_initial_state() {
        let max_lines = NonZeroUsize::new(50).unwrap();
        let buffer = TerminalBuffer::new_with_max_lines(max_lines);
        assert_eq!(buffer.len(), 0);
        assert!(buffer.is_empty());
        assert_eq!(buffer.last_line_number, 0);
        assert_eq!(buffer.max_lines, max_lines);
        assert!(!buffer.line_terminated);
    }

    #[test]
    fn test_push_line_increments_current_line_number() {
        let mut buffer = TerminalBuffer::new_with_max_lines(NonZeroUsize::new(3).unwrap());
        assert_eq!(buffer.last_line_number, 0);

        buffer.push_line(sl("line 1"));
        assert_eq!(buffer.len(), 1);
        assert_eq!(buffer.last_line_number, 1);
        assert!(buffer.line_terminated);

        buffer.push_line(sl("line 2"));
        assert_eq!(buffer.len(), 2);
        assert_eq!(buffer.last_line_number, 2);
        assert!(buffer.line_terminated);
    }

    #[test]
    fn test_extend_line_increments_current_line_number() {
        let mut buffer = TerminalBuffer::new_with_max_lines(NonZeroUsize::new(3).unwrap());

        // Case 1: Extending when line_terminated is true
        buffer.commit_current_line(); // Make line_terminated true
        assert!(buffer.line_terminated);
        buffer.extend_line(sl("line 1 part 1"));
        assert_eq!(buffer.len(), 1);
        assert_eq!(buffer.last_line_number, 1); // Incremented
        assert!(!buffer.line_terminated); // Becomes false after extend

        // Case 2: Extending when line_terminated is false (continuing a line)
        // The current logic in extend_line when line_terminated is false and buffer not empty
        // pops and re-pushes the existing last line, ignoring the input.
        // So, current_line_number should not change.
        let previous_line_number = buffer.last_line_number;
        buffer.extend_line(sl("line 1 part 2 - ignored"));
        assert_eq!(buffer.len(), 1);
        assert_eq!(buffer.last_line_number, previous_line_number); // Not incremented
        assert!(!buffer.line_terminated);

        // Reset for next test part
        let mut buffer2 = TerminalBuffer::new_with_max_lines(NonZeroUsize::new(3).unwrap());

        // Case 3: Extending when line_terminated is false but buffer is empty (first line)
        assert!(!buffer2.line_terminated);
        assert!(buffer2.is_empty());
        buffer2.extend_line(sl("first line segment"));
        assert_eq!(buffer2.len(), 1);
        assert_eq!(buffer2.last_line_number, 1); // Incremented
        assert!(!buffer2.line_terminated);
    }

    #[test]
    fn selected_text_survives_clear_and_scrollback_eviction() {
        use super::selection::{BufferPosition, Selection};
        let mut buffer = TerminalBuffer::new_with_max_lines(NonZeroUsize::new(10).unwrap());
        buffer.push_line(sl("alpha"));
        buffer.push_line(sl("bravo"));
        let selection = Selection::Selected {
            from: BufferPosition { line: 1, column: 0 },
            to: BufferPosition { line: 2, column: 5 },
        };
        assert_eq!(buffer.selected_text(&selection), "alpha\nbravo");

        // A script `mainPane.clear()` empties the buffer but keeps line
        // numbering; the stale selection must clamp away, never panic
        // (it used to underflow in debug / index out of bounds in release).
        buffer.clear_lines();
        assert_eq!(buffer.selected_text(&selection), "");

        // Fresh content after the clear: the stale low line numbers stay
        // clamped out, so no wrong row is ever read.
        buffer.push_line(sl("charlie"));
        assert_eq!(buffer.selected_text(&selection), "");

        // A selection that straddles the live/evicted boundary keeps only the
        // surviving tail, starting whole (the clamped-in edge drops its column).
        let straddling = Selection::Selected {
            from: BufferPosition { line: 2, column: 2 },
            to: BufferPosition { line: 3, column: 7 },
        };
        assert_eq!(buffer.selected_text(&straddling), "charlie");
    }

    #[test]
    fn test_buffer_wrapping_and_current_line_number() {
        let mut buffer = TerminalBuffer::new_with_max_lines(NonZeroUsize::new(2).unwrap());
        buffer.push_line(sl("1"));
        buffer.push_line(sl("2"));
        assert_eq!(buffer.len(), 2);
        assert_eq!(buffer.last_line_number, 2);

        buffer.push_line(sl("3")); // Wraps, "1" is popped
        assert_eq!(buffer.len(), 2);
        assert_eq!(buffer.last_line_number, 3);
        assert_eq!(buffer.lines[0].styled_line.text, "2");
        assert_eq!(buffer.lines[1].styled_line.text, "3");

        buffer.push_line(sl("4")); // Wraps, "2" is popped
        assert_eq!(buffer.len(), 2);
        assert_eq!(buffer.last_line_number, 4);
        assert_eq!(buffer.lines[0].styled_line.text, "3");
        assert_eq!(buffer.lines[1].styled_line.text, "4");
    }

    #[test]
    fn test_iter_rev_with_line_number_empty() {
        let buffer = TerminalBuffer::new();
        assert_eq!(buffer.iter_rev_with_line_number(None).count(), 0);
    }

    #[test]
    fn test_iter_rev_with_line_number_no_wrap() {
        let mut buffer = TerminalBuffer::new_with_max_lines(NonZeroUsize::new(5).unwrap());
        buffer.push_line(sl("L1")); // cln=1
        buffer.push_line(sl("L2")); // cln=2
        buffer.push_line(sl("L3")); // cln=3. Lines: [L1,L2,L3]

        // iter().rev(): L3, L2, L1
        // enumerate(): (0,L3), (1,L2), (2,L1)
        // map |(i,line)| (cln - i, line) where cln = 3
        // (3-0, L3) -> (3,L3)
        // (3-1, L2) -> (2,L2)
        // (3-2, L1) -> (1,L1)
        let mut iter = buffer.iter_rev_with_line_number(None);
        assert_eq!(
            iter.next().map(|(n, l)| (n, l.styled_line.text.as_str())),
            Some((3, "L3"))
        );
        assert_eq!(
            iter.next().map(|(n, l)| (n, l.styled_line.text.as_str())),
            Some((2, "L2"))
        );
        assert_eq!(
            iter.next().map(|(n, l)| (n, l.styled_line.text.as_str())),
            Some((1, "L1"))
        );
        assert_eq!(iter.next(), None);
    }

    #[test]
    fn test_iter_rev_with_line_number_with_wrap() {
        let mut buffer = TerminalBuffer::new_with_max_lines(NonZeroUsize::new(2).unwrap());
        buffer.push_line(sl("L1")); // cln=1
        buffer.push_line(sl("L2")); // cln=2. Buffer: [L1,L2]
        buffer.push_line(sl("L3")); // cln=3. Buffer: [L2,L3]

        // cln = 3. Lines in buffer (reversed): L3, L2
        // enumerate: (0, L3), (1, L2)
        // map |(i,line)| (cln - i, line)
        // (3-0, L3) -> (3, L3)
        // (3-1, L2) -> (2, L2)
        let mut iter = buffer.iter_rev_with_line_number(None);
        assert_eq!(
            iter.next().map(|(n, l)| (n, l.styled_line.text.as_str())),
            Some((3, "L3"))
        );
        assert_eq!(
            iter.next().map(|(n, l)| (n, l.styled_line.text.as_str())),
            Some((2, "L2"))
        );
        assert_eq!(iter.next(), None);
    }

    fn linked_line(text: &str, begin: usize, end: usize) -> Arc<StyledLine> {
        use smudgy_core::session::styled_line::{LinkSpan, VtSpan};
        let style = Style {
            fg: Color::Rgb {
                r: 200,
                g: 10,
                b: 10,
            },
            bg: Color::DefaultBackground,
            ..Style::DEFAULT
        };
        let mut line = StyledLine::new(
            text,
            vec![VtSpan {
                style,
                begin_pos: 0,
                end_pos: text.len(),
            }],
        );
        line.links.push(LinkSpan {
            begin_pos: begin,
            end_pos: end,
            action: LinkAction::Send(Arc::from("north")),
            tooltip: None,
            style: None,
        });
        Arc::new(line)
    }

    #[test]
    fn sgr_bold_modes_preserve_the_regular_font_and_choose_weight_and_color() {
        use smudgy_core::models::settings::TerminalBoldMode;

        let mut prefs = (*crate::prefs::current()).clone();
        let regular_font = prefs.font;
        let style = Style {
            fg: Color::Ansi {
                color: AnsiColor::Red,
                bold: false,
            },
            attributes: TextAttributes {
                bold: true,
                ..TextAttributes::DEFAULT
            },
            ..Style::DEFAULT
        };

        prefs.bold_mode = TerminalBoldMode::Bold;
        let bold = make_span("bold", style, false, None, &prefs);
        assert_eq!(
            bold.font,
            Some(iced::Font {
                weight: iced::font::Weight::Bold,
                ..regular_font
            })
        );
        assert_eq!(
            bold.color,
            Some(prefs.resolve(Color::Ansi {
                color: AnsiColor::Red,
                bold: false,
            }))
        );

        prefs.bold_mode = TerminalBoldMode::Bright;
        let bright = make_span("bold", style, false, None, &prefs);
        assert_eq!(bright.font, Some(regular_font));
        assert_eq!(
            bright.color,
            Some(prefs.resolve(Color::Ansi {
                color: AnsiColor::Red,
                bold: true,
            }))
        );

        prefs.bold_mode = TerminalBoldMode::BoldAndBright;
        let both = make_span("bold", style, false, None, &prefs);
        assert_eq!(
            both.font,
            Some(iced::Font {
                weight: iced::font::Weight::Bold,
                ..regular_font
            })
        );
        assert_eq!(both.color, bright.color);

        prefs.bold_mode = TerminalBoldMode::Bold;
        let explicit_bright = make_span(
            "bright",
            Style {
                fg: Color::Ansi {
                    color: AnsiColor::Red,
                    bold: true,
                },
                ..style
            },
            false,
            None,
            &prefs,
        );
        assert_eq!(explicit_bright.color, bright.color);
    }

    #[test]
    fn make_span_renders_sgr_attributes_and_reverse_colors() {
        let prefs = crate::prefs::current();
        let style = Style {
            fg: Color::Rgb {
                r: 10,
                g: 20,
                b: 30,
            },
            bg: Color::Rgb {
                r: 40,
                g: 50,
                b: 60,
            },
            attributes: TextAttributes {
                faint: true,
                italic: true,
                underline: Underline::Double,
                blink: Blink::Fast,
                crossed_out: true,
                reverse: true,
                ..TextAttributes::DEFAULT
            },
        };
        let span = make_span("styled", style, false, None, &prefs);
        let mut reversed_fg = prefs.resolve(style.bg);
        reversed_fg.a *= 0.5;
        assert_eq!(span.color, Some(reversed_fg));
        assert_eq!(
            span.highlight.map(|highlight| highlight.background),
            Some(Background::Color(prefs.resolve(style.fg)))
        );
        assert_eq!(
            span.font.map(|font| font.style),
            Some(iced::font::Style::Italic)
        );
        assert!(span.underline);
        assert!(span.strikethrough);
        assert_eq!(
            span.link,
            Some(SpanMetadata {
                blink: Blink::Fast,
                underline: LinkDecoration::Double,
                strikethrough: LinkDecoration::Solid,
                ..SpanMetadata::default()
            })
        );
    }

    #[test]
    fn to_spans_splits_at_link_boundaries_with_chip() {
        let line = linked_line("go north now", 3, 8);
        let prefs = crate::prefs::current();
        let spans = to_spans(&line, &prefs);

        assert_eq!(spans.len(), 3);
        assert_eq!(spans[0].text, "go ");
        assert_eq!(spans[1].text, "north");
        assert_eq!(spans[2].text, " now");

        // Only the linked segment is underlined, over a wash of its own foreground;
        // the segments around it keep the plain background.
        assert!(!spans[0].underline && !spans[2].underline);
        assert!(spans[1].underline);
        let fg = prefs.resolve(Color::Rgb {
            r: 200,
            g: 10,
            b: 10,
        });
        assert_eq!(
            spans[1].highlight.map(|h| h.background),
            Some(Background::Color(iced::Color {
                a: LINK_WASH_ALPHA,
                ..fg
            }))
        );
        assert_ne!(
            spans[0].highlight.map(|h| h.background),
            spans[1].highlight.map(|h| h.background)
        );
    }

    #[test]
    fn authored_osc_style_suppresses_fallback_link_affordance() {
        let prefs = crate::prefs::current();
        let authored = LinkStyle::default();
        let span = make_span("link", Style::DEFAULT, true, Some(&authored), &prefs);
        assert!(
            !span.underline,
            "an empty authored style is not auto-underlined"
        );
        assert!(
            span.highlight.is_none(),
            "an authored style gets no fallback wash"
        );
    }

    #[test]
    fn protocol_concealment_suppresses_every_visual_affordance() {
        let prefs = crate::prefs::current();
        let resolved = LinkRenderStyle {
            authored: false,
            style: LinkTextStyle::default(),
            spoiler_concealed: false,
            hidden: true,
        };
        let span = make_resolved_span(
            "hidden",
            Style::DEFAULT,
            true,
            Some(&resolved),
            false,
            &prefs,
        );
        assert_eq!(span.color, Some(iced::Color::TRANSPARENT));
        assert!(span.highlight.is_none());
        assert!(!span.underline);
        assert!(!span.strikethrough);
    }

    #[test]
    fn concealed_spoiler_replaces_each_grapheme_with_a_space() {
        let prefs = crate::prefs::current();
        let resolved = LinkRenderStyle {
            authored: false,
            style: LinkTextStyle::default(),
            spoiler_concealed: true,
            hidden: false,
        };
        let span = make_resolved_span(
            "🔮💀🗝️",
            Style::DEFAULT,
            true,
            Some(&resolved),
            false,
            &prefs,
        );
        assert_eq!(span.text, "   ");
        assert!(span.highlight.is_none());
        assert!(!span.underline);
    }

    #[test]
    fn concealed_spoiler_offsets_map_back_to_the_source_line() {
        let prefs = crate::prefs::current();
        let line = linked_line("A🗝️B", 1, 8);
        let rendered = to_spans_with(&line, &prefs, false, |_| LinkRenderStyle {
            authored: false,
            style: LinkTextStyle::default(),
            spoiler_concealed: true,
            hidden: false,
        });
        let text: String = rendered
            .spans
            .iter()
            .flat_map(|span| span.text.chars())
            .collect();

        assert_eq!(text, "A B");
        assert_eq!(rendered.offsets.source_to_rendered(1), 1);
        assert_eq!(rendered.offsets.source_to_rendered(8), 2);
        assert_eq!(rendered.offsets.rendered_to_source(1), 1);
        assert_eq!(rendered.offsets.rendered_to_source(2), 8);
        assert_eq!(rendered.offsets.rendered_to_source(3), 9);
    }

    #[test]
    fn authored_osc_false_values_override_active_sgr_attributes() {
        use smudgy_core::session::styled_line::{LinkTextStyle, TextAttributes};

        let prefs = crate::prefs::current();
        let authored = LinkStyle {
            base: LinkTextStyle {
                bold: Some(false),
                italic: Some(false),
                underline: Some(LinkDecoration::None),
                strikethrough: Some(LinkDecoration::None),
                ..LinkTextStyle::default()
            },
            ..LinkStyle::default()
        };
        let span = make_span(
            "link",
            Style {
                attributes: TextAttributes {
                    bold: true,
                    italic: true,
                    underline: Underline::Single,
                    crossed_out: true,
                    ..TextAttributes::DEFAULT
                },
                ..Style::DEFAULT
            },
            true,
            Some(&authored),
            &prefs,
        );
        assert_ne!(
            span.font.map(|font| font.weight),
            Some(iced::font::Weight::Bold)
        );
        assert_ne!(
            span.font.map(|font| font.style),
            Some(iced::font::Style::Italic)
        );
        assert!(!span.underline);
        assert!(!span.strikethrough);
    }

    #[test]
    fn to_spans_keeps_explicit_background_under_a_link() {
        use smudgy_core::session::styled_line::{LinkSpan, VtSpan};
        let style = Style {
            fg: Color::Rgb {
                r: 200,
                g: 10,
                b: 10,
            },
            bg: Color::Rgb { r: 1, g: 2, b: 3 },
            ..Style::DEFAULT
        };
        let mut line = StyledLine::new(
            "north",
            vec![VtSpan {
                style,
                begin_pos: 0,
                end_pos: 5,
            }],
        );
        line.links.push(LinkSpan {
            begin_pos: 0,
            end_pos: 5,
            action: LinkAction::Send(Arc::from("north")),
            tooltip: None,
            style: None,
        });
        let prefs = crate::prefs::current();
        let spans = to_spans(&Arc::new(line), &prefs);
        assert_eq!(spans.len(), 1);
        // The author's background wins over the wash; the underline stays.
        assert!(spans[0].underline);
        assert_eq!(
            spans[0].highlight.map(|h| h.background),
            Some(Background::Color(prefs.resolve(Color::Rgb {
                r: 1,
                g: 2,
                b: 3
            })))
        );
    }

    #[test]
    fn link_at_resolves_by_absolute_line_and_column() {
        let mut buffer = TerminalBuffer::new_with_max_lines(NonZeroUsize::new(10).unwrap());
        buffer.push_line(sl("plain"));
        buffer.push_line(linked_line("go north now", 3, 8));

        // Inside the link.
        assert_eq!(
            buffer.link_at(2, 5),
            Some(LinkAction::Send(Arc::from("north")))
        );
        // Boundary semantics: begin inclusive, end exclusive.
        assert_eq!(
            buffer.link_at(2, 3),
            Some(LinkAction::Send(Arc::from("north")))
        );
        assert_eq!(buffer.link_at(2, 8), None);
        // Off-link text, another line, and out-of-window numbers all miss.
        assert_eq!(buffer.link_at(2, 0), None);
        assert_eq!(buffer.link_at(1, 5), None);
        assert_eq!(buffer.link_at(0, 5), None);
        assert_eq!(buffer.link_at(99, 5), None);
    }

    #[test]
    fn find_recent_word_logic() {
        let mut buffer = TerminalBuffer::new_with_max_lines(NonZeroUsize::new(10).unwrap());
        buffer.push_line(sl("hello world"));
        buffer.push_line(sl("test another one"));
        buffer.push_line(sl("prefix_found here"));
        buffer.push_line(sl("try prefix_again"));

        // Test basic prefix matching
        assert_eq!(
            buffer.find_recent_word_by_prefix("pref", None, &[], 4),
            Some("prefix_again".to_string())
        );
        assert_eq!(
            buffer.find_recent_word_by_prefix("pref", None, &[], 2),
            Some("prefix_again".to_string())
        ); // Only search last 2 lines
        assert_eq!(
            buffer.find_recent_word_by_prefix("anot", None, &[], 4),
            Some("another".to_string())
        );

        // Test case-insensitivity
        assert_eq!(
            buffer.find_recent_word_by_prefix("PREFIX", None, &[], 4),
            Some("prefix_again".to_string())
        );

        // Test not found
        assert_eq!(
            buffer.find_recent_word_by_prefix("nonexistent", None, &[], 4),
            None
        );

        // Test with skip_words
        let mut skip_set = HashSet::new();
        skip_set.insert("prefix_again".to_string());
        assert_eq!(
            buffer.find_recent_word_by_prefix("pref", Some(&skip_set), &[], 4),
            Some("prefix_found".to_string())
        );

        skip_set.insert("prefix_found".to_string());
        assert_eq!(
            buffer.find_recent_word_by_prefix("pref", Some(&skip_set), &[], 4),
            None
        ); // All "pref" words skipped

        // Test n_recent_lines
        assert_eq!(
            buffer.find_recent_word_by_prefix("hello", None, &[], 1),
            None
        ); // "hello" is not in the last line
        assert_eq!(
            buffer.find_recent_word_by_prefix("hello", None, &[], 4),
            Some("hello".to_string())
        ); // "hello" is in the last 4 lines
    }

    #[test]
    fn find_recent_word_handles_colon_segments() {
        let mut buffer = TerminalBuffer::new_with_max_lines(NonZeroUsize::new(10).unwrap());
        buffer.push_line(sl(
            "[SC:Order] [Rr'Kar:Awful] guard:Awful Mem:2 T:40 Exits:N(S)W>",
        ));
        buffer.push_line(sl("An alert militia guard misses Zurek with his slash."));

        assert_eq!(
            buffer.find_recent_word_by_prefix("sc", None, &[], 5),
            Some("SC".to_string())
        );
        assert_eq!(
            buffer.find_recent_word_by_prefix("sc:", None, &[], 5),
            Some("SC:Order".to_string())
        );
        assert_eq!(
            buffer.find_recent_word_by_prefix("rr", None, &[], 5),
            Some("Rr'Kar".to_string())
        );
        assert_eq!(
            buffer.find_recent_word_by_prefix("gu", None, &[], 5),
            Some("guard".to_string())
        );
        assert_eq!(
            buffer.find_recent_word_by_prefix("guard:", None, &[], 5),
            Some("guard:Awful".to_string())
        );

        buffer.push_line(sl("Half-orc's strike leaves a scratch-!"));
        assert_eq!(
            buffer.find_recent_word_by_prefix("half", None, &[], 5),
            Some("Half-orc".to_string())
        );
        assert_eq!(
            buffer.find_recent_word_by_prefix("half-orc'", None, &[], 5),
            Some("Half-orc's".to_string())
        );
        assert_eq!(
            buffer.find_recent_word_by_prefix("scr", None, &[], 5),
            Some("scratch".to_string())
        );
    }
}
