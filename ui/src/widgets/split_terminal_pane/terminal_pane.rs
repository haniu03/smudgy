use std::{
    cell::{Ref, RefCell},
    rc::Rc,
    sync::Arc,
};

use crate::terminal_buffer::{LinkClickEvent, SpanMetadata, TerminalBuffer, make_span};
use iced::{
    Background, Border, Event, Pixels, Point, Rectangle, Size,
    advanced::{
        self, Layout, Widget, clipboard,
        graphics::core::keyboard,
        layout, mouse,
        renderer::{self, Quad},
        text::{self, Paragraph},
        widget::{Tree, tree},
    },
    alignment,
    time::{Duration, Instant},
    touch,
    widget::text::LineHeight,
    window,
};
use smudgy_core::session::styled_line::{
    LinkAction, LinkDecoration, LinkMenu, LinkMenuItem, LinkTooltip, LinkTooltipCallback,
    LinkTooltipText,
};

mod spans;

use crate::terminal_buffer::selection::{BufferPosition, LineSelection, Selection};
use spans::Spans;

type Link = SpanMetadata;

/// 100 '0's shaped once per prefs generation to measure the monospace cell
/// advance for the column-based line-length clamp.
const ADVANCE_PROBE: &str = "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

fn draw_text_decoration<Renderer: advanced::Renderer>(
    renderer: &mut Renderer,
    region: Rectangle,
    y: f32,
    decoration: LinkDecoration,
    color: iced::Color,
    viewport: Rectangle,
) {
    let mut fill = |x: f32, y: f32, width: f32| {
        let rect = Rectangle {
            x,
            y,
            width: width.max(0.5),
            height: 1.0,
        };
        if let Some(bounds) = rect.intersection(&viewport) {
            renderer.fill_quad(
                Quad {
                    bounds,
                    ..Default::default()
                },
                color,
            );
        }
    };
    match decoration {
        LinkDecoration::None => {}
        LinkDecoration::Solid => fill(region.x, y, region.width),
        LinkDecoration::Double => {
            fill(region.x, y - 2.0, region.width);
            fill(region.x, y, region.width);
        }
        LinkDecoration::Dotted => {
            let mut x = region.x;
            while x < region.x + region.width {
                fill(x, y, 1.0_f32.min(region.x + region.width - x));
                x += 3.0;
            }
        }
        LinkDecoration::Dashed => {
            let mut x = region.x;
            while x < region.x + region.width {
                fill(x, y, 4.0_f32.min(region.x + region.width - x));
                x += 6.0;
            }
        }
        LinkDecoration::Wavy => {
            let mut x = region.x;
            let mut up = false;
            while x < region.x + region.width {
                fill(
                    x,
                    y + if up { -1.0 } else { 0.0 },
                    2.0_f32.min(region.x + region.width - x),
                );
                up = !up;
                x += 2.0;
            }
        }
    }
}

#[derive(Debug, Clone)]
struct ParagraphCache<P: text::Paragraph> {
    spans: Spans<Link>,
    paragraph: P,
    slow_blink_hidden: Option<P>,
    fast_blink_hidden: Option<P>,
    all_blink_hidden: Option<P>,
    blink_modes: u8,
    max_valid_width: f32,
    selection: LineSelection,
    /// The prefs generation this paragraph was shaped with; a mismatch is a
    /// cache miss (font/size/palette changes rebuild paragraphs).
    generation: u64,
    /// The effective font size this paragraph was shaped at — the per-pane
    /// override composes with the generation (an override change re-shapes
    /// without a prefs bump).
    font_size: f32,
}

const SLOW_BLINK: u8 = 1;
const FAST_BLINK: u8 = 2;
const SLOW_BLINK_HALF_PERIOD_MS: u128 = 500;
const FAST_BLINK_HALF_PERIOD_MS: u128 = 250;

impl<P: text::Paragraph> ParagraphCache<P> {
    fn displayed_paragraph(&self, slow_visible: bool, fast_visible: bool) -> &P {
        match (slow_visible, fast_visible) {
            (true, true) => &self.paragraph,
            (false, true) => self.slow_blink_hidden.as_ref().unwrap_or(&self.paragraph),
            (true, false) => self.fast_blink_hidden.as_ref().unwrap_or(&self.paragraph),
            (false, false) => self
                .all_blink_hidden
                .as_ref()
                .or(self.slow_blink_hidden.as_ref())
                .or(self.fast_blink_hidden.as_ref())
                .unwrap_or(&self.paragraph),
        }
    }
}

fn hidden_blink_spans(
    spans: &[iced::widget::text::Span<'static, Link>],
    hide_slow: bool,
    hide_fast: bool,
) -> Option<Vec<iced::widget::text::Span<'static, Link>>> {
    let mut changed = false;
    let hidden = spans
        .iter()
        .cloned()
        .map(|mut span| {
            let hide = span.link.is_some_and(|metadata| match metadata.blink {
                smudgy_core::session::styled_line::Blink::None => false,
                smudgy_core::session::styled_line::Blink::Slow => hide_slow,
                smudgy_core::session::styled_line::Blink::Fast => hide_fast,
            });
            if hide {
                changed = true;
                span.color = Some(iced::Color::TRANSPARENT);
            }
            span
        })
        .collect();
    changed.then_some(hidden)
}

/// The effective text metrics for a pane: its font override (line height by
/// the same ×1.25 rule the global preference derives with, `prefs.rs`) or
/// the preference values.
pub(super) fn effective_metrics(
    prefs: &crate::prefs::TerminalPrefs,
    font_override: Option<f32>,
) -> (f32, f32) {
    match font_override {
        Some(px) => (px, (px * 1.25).round()),
        None => (prefs.font_size, prefs.line_height),
    }
}

/// Render an actionable destination without letting control, zero-width, or
/// bidi-reordering characters conceal what will actually be opened or sent.
fn safe_link_target(target: &str) -> String {
    const MAX_CHARS: usize = 512;
    let mut rendered = String::with_capacity(target.len().min(MAX_CHARS));
    for (index, c) in target.chars().enumerate() {
        if index == MAX_CHARS {
            rendered.push('\u{2026}');
            break;
        }
        let suspicious = c.is_control()
            || matches!(
                c,
                '\u{061c}'
                    | '\u{200b}'..='\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2060}'..='\u{206f}'
                    | '\u{feff}'
            );
        if suspicious {
            use std::fmt::Write;
            write!(rendered, "\\u{{{:04X}}}", u32::from(c)).ok();
        } else {
            rendered.push(c);
        }
    }
    rendered
}

fn action_target(action: &LinkAction) -> Option<String> {
    match action.disclosed_target()? {
        LinkAction::Send(command) | LinkAction::OpenUrl(command) => Some(command.to_string()),
        LinkAction::ServerSend(command) => Some(format!("send:{command}")),
        LinkAction::Prompt(command) => Some(format!("prompt:{command}")),
        LinkAction::Callback { .. } | LinkAction::Configured { .. } => None,
    }
}

fn clipped_tooltip_text(text: &LinkTooltipText) -> LinkTooltipText {
    // Enough for a dense 60-column by 20-row item/stat block plus breathing
    // room, while still bounding paragraph shaping work from untrusted servers.
    const MAX_CHARS: usize = 4096;
    let mut chars = text.text.chars();
    let mut result: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_none() {
        return text.clone();
    }
    let cutoff = result.len();
    result.push('\u{2026}');
    let mut spans: Vec<_> = text
        .spans
        .iter()
        .filter_map(|span| {
            (span.begin_pos < cutoff).then_some(smudgy_core::session::styled_line::VtSpan {
                style: span.style,
                begin_pos: span.begin_pos,
                end_pos: span.end_pos.min(cutoff),
            })
        })
        .collect();
    if let Some(last) = spans.last_mut() {
        last.end_pos = result.len();
    }
    LinkTooltipText {
        text: Arc::from(result),
        spans: spans.into(),
    }
}

#[derive(Debug, Clone)]
struct LinkTooltipParagraphCache<P: text::Paragraph> {
    text: LinkTooltipText,
    spans: Rc<Vec<iced::widget::text::Span<'static, Link>>>,
    paragraph: P,
    generation: u64,
    content_width: f32,
}

fn draw_link_tooltip<Renderer>(
    renderer: &mut Renderer,
    prefs: &crate::prefs::TerminalPrefs,
    viewport: Rectangle,
    cursor: mouse::Cursor,
    action: &LinkAction,
    tooltip: &LinkTooltip,
    paragraph_cache: &RefCell<Option<LinkTooltipParagraphCache<Renderer::Paragraph>>>,
) where
    Renderer: text::Renderer<Font = iced::Font>,
    Renderer::Paragraph: iced::advanced::text::Paragraph<Font = iced::Font>,
{
    let Some(cursor) = cursor.position() else {
        return;
    };
    let Some((primary, secondary)) = tooltip.display_styled() else {
        return;
    };
    let target = action_target(action);
    let primary = if secondary.is_none() && target.as_deref() == Some(primary.text.as_ref()) {
        LinkTooltipText::plain(Arc::from(safe_link_target(primary.text.as_ref())))
    } else {
        clipped_tooltip_text(&primary)
    };
    let secondary = secondary.map(|target| safe_link_target(&target));

    let padding = 8.0;
    let gap = if secondary.is_some() { 3.0 } else { 0.0 };
    let max_width = (viewport.width - 2.0).min(520.0);
    if max_width < 2.0 * padding + 1.0 {
        return;
    }
    let content_bounds = Size::new(max_width - 2.0 * padding, f32::INFINITY);
    let make_plain_paragraph = |content: &str, size: f32| {
        Renderer::Paragraph::with_text(iced::advanced::text::Text {
            content,
            bounds: content_bounds,
            size: Pixels(size),
            font: prefs.font,
            line_height: LineHeight::Absolute(Pixels((size * 1.25).round())),
            align_x: text::Alignment::Left,
            align_y: alignment::Vertical::Top,
            shaping: text::Shaping::Advanced,
            wrapping: text::Wrapping::WordOrGlyph,
        })
    };
    let mut paragraph_cache = paragraph_cache.borrow_mut();
    let rebuild = paragraph_cache.as_ref().is_none_or(|cache| {
        cache.text != primary
            || cache.generation != prefs.generation
            || cache.content_width != content_bounds.width
    });
    if rebuild {
        let spans: Rc<Vec<iced::widget::text::Span<'static, Link>>> = Rc::new(
            primary
                .spans
                .iter()
                .map(|span| {
                    make_span(
                        &primary.text[span.begin_pos..span.end_pos],
                        span.style,
                        false,
                        None,
                        prefs,
                    )
                })
                .collect(),
        );
        let paragraph = Renderer::Paragraph::with_spans(iced::advanced::text::Text {
            content: spans.as_slice(),
            bounds: content_bounds,
            size: Pixels(13.0),
            font: prefs.font,
            line_height: LineHeight::Absolute(Pixels((13.0_f32 * 1.25).round())),
            align_x: text::Alignment::Left,
            align_y: alignment::Vertical::Top,
            shaping: text::Shaping::Advanced,
            wrapping: text::Wrapping::WordOrGlyph,
        });
        *paragraph_cache = Some(LinkTooltipParagraphCache {
            text: primary.clone(),
            spans,
            paragraph,
            generation: prefs.generation,
            content_width: content_bounds.width,
        });
    }
    let primary_cache = paragraph_cache
        .as_ref()
        .expect("tooltip paragraph cache was just populated");
    let primary_paragraph = &primary_cache.paragraph;
    let secondary_paragraph = secondary
        .as_deref()
        .map(|text| make_plain_paragraph(text, 11.0));
    let content_width = secondary_paragraph
        .as_ref()
        .map_or(primary_paragraph.min_width(), |secondary| {
            primary_paragraph.min_width().max(secondary.min_width())
        });
    let width = (content_width + 2.0 * padding).min(max_width);
    let height = primary_paragraph.min_height()
        + secondary_paragraph.as_ref().map_or(0.0, |p| p.min_height())
        + gap
        + 2.0 * padding;
    let text_primitive = |content: String, size: f32, height: f32| iced::advanced::text::Text {
        content,
        bounds: Size::new(width - 2.0 * padding, height),
        size: Pixels(size),
        font: prefs.font,
        line_height: LineHeight::Absolute(Pixels((size * 1.25).round())),
        align_x: text::Alignment::Left,
        align_y: alignment::Vertical::Top,
        shaping: text::Shaping::Advanced,
        wrapping: text::Wrapping::WordOrGlyph,
    };

    let right = viewport.x + viewport.width;
    let bottom = viewport.y + viewport.height;
    let x = (cursor.x + 12.0).min(right - width).max(viewport.x);
    let below = cursor.y + 18.0;
    let y = if below + height <= bottom {
        below
    } else {
        (cursor.y - height - 8.0).max(viewport.y)
    };
    let bounds = Rectangle::new(Point::new(x, y), Size::new(width, height));
    let foreground = prefs.palette.foreground;

    // iced batches quads and glyphs into primitive sublayers. Without a fresh
    // renderer layer, every terminal paragraph is composited after this card's
    // fill, which makes the scrollback show through it. Use owned text primitives
    // here too: fill_paragraph records only a weak reference, and these transient
    // measurement paragraphs do not live until the GPU preparation pass.
    renderer.start_layer(viewport);
    renderer.fill_quad(
        Quad {
            bounds,
            border: Border {
                color: iced::Color {
                    a: 0.28,
                    ..foreground
                },
                width: 1.0,
                radius: 4.0.into(),
            },
            ..Default::default()
        },
        Background::Color(iced::Color {
            a: 0.97,
            ..prefs.palette.background
        }),
    );
    let primary_at = Point::new(x + padding, y + padding);
    let primary_height = primary_paragraph.min_height();
    for (index, span) in primary_cache.spans.iter().enumerate() {
        let Some(highlight) = span.highlight else {
            continue;
        };
        for region in primary_paragraph.span_bounds(index) {
            let bounds = Rectangle {
                x: primary_at.x + region.x,
                y: primary_at.y + region.y,
                width: region.width,
                height: region.height,
            };
            renderer.fill_quad(
                Quad {
                    bounds,
                    border: highlight.border,
                    ..Default::default()
                },
                highlight.background,
            );
        }
    }
    renderer.fill_paragraph(primary_paragraph, primary_at, foreground, viewport);
    if let (Some(secondary), Some(secondary_paragraph)) = (secondary, secondary_paragraph) {
        let secondary_at = Point::new(x + padding, y + padding + primary_height + gap);
        renderer.fill_text(
            text_primitive(secondary, 11.0, secondary_paragraph.min_height()),
            secondary_at,
            iced::Color {
                a: foreground.a * 0.58,
                ..foreground
            },
            viewport,
        );
    }
    renderer.end_layer();
}

#[derive(Debug, Clone)]
struct LinkMenuPopup {
    menu: LinkMenu,
    anchor: Point,
}

struct LinkMenuGeometry {
    bounds: Rectangle,
    title: Option<Rectangle>,
    rows: Vec<Rectangle>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HoveredLinkTooltip {
    action: LinkAction,
    tooltip: LinkTooltip,
}

#[derive(Debug, Clone)]
enum LinkTooltipHover {
    Waiting {
        link: HoveredLinkTooltip,
        at: Instant,
    },
    Open(HoveredLinkTooltip),
}

impl LinkTooltipHover {
    fn link(&self) -> &HoveredLinkTooltip {
        match self {
            Self::Waiting { link, .. } | Self::Open(link) => link,
        }
    }

    fn is_open(&self) -> bool {
        matches!(self, Self::Open(_))
    }

    fn is_open_for(&self, action: &LinkAction, tooltip: &LinkTooltip) -> bool {
        matches!(
            self,
            Self::Open(link) if link.action == *action && link.tooltip == *tooltip
        )
    }
}

fn begin_link_tooltip_hover<Message>(
    link: HoveredLinkTooltip,
    delay: Duration,
    now: Instant,
    shell: &mut advanced::Shell<'_, Message>,
) -> LinkTooltipHover {
    if delay == Duration::ZERO {
        shell.request_redraw();
        LinkTooltipHover::Open(link)
    } else {
        shell.request_redraw_at(now + delay);
        LinkTooltipHover::Waiting { link, at: now }
    }
}

fn link_menu_geometry<Renderer>(
    popup: &LinkMenuPopup,
    prefs: &crate::prefs::TerminalPrefs,
    viewport: Rectangle,
) -> Option<LinkMenuGeometry>
where
    Renderer: text::Renderer<Font = iced::Font>,
    Renderer::Paragraph: iced::advanced::text::Paragraph<Font = iced::Font>,
{
    const PADDING: f32 = 4.0;
    const HORIZONTAL_PADDING: f32 = 10.0;
    const ACTION_HEIGHT: f32 = 27.0;
    const TITLE_HEIGHT: f32 = 25.0;
    const SEPARATOR_HEIGHT: f32 = 9.0;
    let max_width = (viewport.width - 2.0).min(420.0);
    if max_width < 2.0 * (PADDING + HORIZONTAL_PADDING) + 1.0 {
        return None;
    }
    let measure = |content: &str, size: f32| {
        Renderer::Paragraph::with_text(iced::advanced::text::Text {
            content,
            bounds: Size::new(f32::INFINITY, f32::INFINITY),
            size: Pixels(size),
            font: prefs.font,
            line_height: LineHeight::Absolute(Pixels((size * 1.25).round())),
            align_x: text::Alignment::Left,
            align_y: alignment::Vertical::Center,
            shaping: text::Shaping::Advanced,
            wrapping: text::Wrapping::None,
        })
        .min_width()
    };
    let title_width = popup
        .menu
        .title
        .as_deref()
        .map_or(0.0, |title| measure(title, 12.0));
    let item_width = popup
        .menu
        .items
        .iter()
        .filter_map(|item| match item {
            LinkMenuItem::Separator => None,
            LinkMenuItem::Action { label, .. } => Some(measure(label, 13.0)),
        })
        .fold(0.0, f32::max);
    let width = (title_width.max(item_width) + 2.0 * (PADDING + HORIZONTAL_PADDING))
        .max(120.0_f32.min(max_width))
        .min(max_width);
    let content_height = popup.menu.title.as_ref().map_or(0.0, |_| TITLE_HEIGHT)
        + popup
            .menu
            .items
            .iter()
            .map(|item| match item {
                LinkMenuItem::Separator => SEPARATOR_HEIGHT,
                LinkMenuItem::Action { .. } => ACTION_HEIGHT,
            })
            .sum::<f32>();
    let height = content_height + 2.0 * PADDING;
    let right = viewport.x + viewport.width;
    let bottom = viewport.y + viewport.height;
    let x = popup.anchor.x.min(right - width).max(viewport.x);
    let y = popup.anchor.y.min(bottom - height).max(viewport.y);
    let bounds = Rectangle::new(Point::new(x, y), Size::new(width, height));
    let mut top = y + PADDING;
    let title = popup.menu.title.as_ref().map(|_| {
        let bounds = Rectangle::new(
            Point::new(x + PADDING, top),
            Size::new(width - 2.0 * PADDING, TITLE_HEIGHT),
        );
        top += TITLE_HEIGHT;
        bounds
    });
    let rows = popup
        .menu
        .items
        .iter()
        .map(|item| {
            let row_height = match item {
                LinkMenuItem::Separator => SEPARATOR_HEIGHT,
                LinkMenuItem::Action { .. } => ACTION_HEIGHT,
            };
            let bounds = Rectangle::new(
                Point::new(x + PADDING, top),
                Size::new(width - 2.0 * PADDING, row_height),
            );
            top += row_height;
            bounds
        })
        .collect();
    Some(LinkMenuGeometry {
        bounds,
        title,
        rows,
    })
}

fn draw_link_menu<Renderer>(
    renderer: &mut Renderer,
    prefs: &crate::prefs::TerminalPrefs,
    viewport: Rectangle,
    cursor: mouse::Cursor,
    popup: &LinkMenuPopup,
) where
    Renderer: text::Renderer<Font = iced::Font>,
    Renderer::Paragraph: iced::advanced::text::Paragraph<Font = iced::Font>,
{
    let Some(geometry) = link_menu_geometry::<Renderer>(popup, prefs, viewport) else {
        return;
    };
    let foreground = prefs.palette.foreground;
    let make_text = |content: String, size: f32, bounds: Rectangle| iced::advanced::text::Text {
        content,
        bounds: bounds.size(),
        size: Pixels(size),
        font: prefs.font,
        line_height: LineHeight::Absolute(Pixels((size * 1.25).round())),
        align_x: text::Alignment::Left,
        align_y: alignment::Vertical::Center,
        shaping: text::Shaping::Advanced,
        wrapping: text::Wrapping::None,
    };

    renderer.start_layer(viewport);
    renderer.fill_quad(
        Quad {
            bounds: geometry.bounds,
            border: Border {
                color: iced::Color {
                    a: 0.3,
                    ..foreground
                },
                width: 1.0,
                radius: 4.0.into(),
            },
            ..Default::default()
        },
        Background::Color(iced::Color {
            a: 0.98,
            ..prefs.palette.background
        }),
    );
    if let (Some(title), Some(title_bounds)) = (&popup.menu.title, geometry.title) {
        let text_bounds = Rectangle {
            x: title_bounds.x + 10.0,
            width: title_bounds.width - 20.0,
            ..title_bounds
        };
        renderer.fill_text(
            make_text(title.to_string(), 12.0, text_bounds),
            Point::new(text_bounds.x, text_bounds.center_y()),
            iced::Color {
                a: foreground.a * 0.62,
                ..foreground
            },
            viewport,
        );
    }
    for (item, row) in popup.menu.items.iter().zip(geometry.rows) {
        match item {
            LinkMenuItem::Separator => {
                renderer.fill_quad(
                    Quad {
                        bounds: Rectangle::new(
                            Point::new(row.x + 8.0, row.center_y() - 0.5),
                            Size::new(row.width - 16.0, 1.0),
                        ),
                        ..Default::default()
                    },
                    Background::Color(iced::Color {
                        a: foreground.a * 0.2,
                        ..foreground
                    }),
                );
            }
            LinkMenuItem::Action { label, .. } => {
                if cursor.is_over(row) {
                    renderer.fill_quad(
                        Quad {
                            bounds: row,
                            border: Border {
                                radius: 3.0.into(),
                                ..Default::default()
                            },
                            ..Default::default()
                        },
                        Background::Color(iced::Color {
                            a: foreground.a * 0.12,
                            ..foreground
                        }),
                    );
                }
                let text_bounds = Rectangle {
                    x: row.x + 10.0,
                    width: row.width - 20.0,
                    ..row
                };
                renderer.fill_text(
                    make_text(label.to_string(), 13.0, text_bounds),
                    Point::new(text_bounds.x, text_bounds.center_y()),
                    foreground,
                    viewport,
                );
            }
        }
    }
    renderer.end_layer();
}

/// State specific to the TerminalPane widget instance.
#[derive(Debug, Clone)]
pub(super) struct State<P: text::Paragraph> {
    pub last_line_number: usize,
    cache: Vec<ParagraphCache<P>>,
    pub is_focused: bool,
    /// Measured `(prefs generation, effective font size, monospace cell
    /// advance)` — the font size composes because a per-pane override changes
    /// the cell without a prefs bump.
    pub advance: Option<(u64, f32, f32)>,
    /// Keyboard modifiers as of the last change event, reported with link clicks.
    pub modifiers: keyboard::Modifiers,
    /// The buffer cell the press landed on, kept while the pointer stays on it. A
    /// release on the same cell is a click (fires links); any divergence — a drag,
    /// or content scrolling under a stationary cursor — clears it. Per-pane state,
    /// NOT derived from the shared `Selection`: a sibling pane processes the same
    /// release first and flips `Selecting` → `Selected`, so selection state alone
    /// cannot tell this pane a click just ended on it.
    pub pressed_cell: Option<BufferPosition>,
    /// The terminal-owned OSC/script link context menu, anchored where it was
    /// opened. Actions are cloned with the scrollback so the popup remains
    /// valid even if new output arrives before a choice is clicked.
    menu_popup: Option<LinkMenuPopup>,
    /// Delay state for the OSC/script tooltip under the pointer. The link and
    /// tooltip values form the hover identity, so moving within one linked
    /// range does not restart the timer.
    link_tooltip_hover: Option<LinkTooltipHover>,
    /// Persistent rich paragraph for the open tooltip. iced's renderer keeps
    /// paragraph primitives by weak reference until GPU preparation, so this
    /// must outlive the draw call instead of being a transient local.
    link_tooltip_paragraph: RefCell<Option<LinkTooltipParagraphCache<P>>>,
    /// Common timebase and current visibility phases for SGR 5/6 text.
    blink_epoch: Instant,
    slow_blink_visible: bool,
    fast_blink_visible: bool,
}

impl<P: text::Paragraph> Default for State<P> {
    fn default() -> Self {
        Self {
            last_line_number: 0,
            cache: Vec::new(),
            is_focused: false,
            advance: None,
            modifiers: keyboard::Modifiers::default(),
            pressed_cell: None,
            menu_popup: None,
            link_tooltip_hover: None,
            link_tooltip_paragraph: RefCell::new(None),
            blink_epoch: Instant::now(),
            slow_blink_visible: true,
            fast_blink_visible: true,
        }
    }
}

impl<P: text::Paragraph> State<P> {
    pub(super) fn hit_test(&self, bounds: Rectangle, point: iced::Point) -> Option<BufferPosition> {
        let mut line_top = bounds.height;

        for (line, offset) in self.cache.iter().zip(0..) {
            let line_number = self.last_line_number - offset;
            let line_bottom = line_top;
            line_top -= line.paragraph.min_height();

            if point.y >= line_top && point.y < line_bottom {
                let point_in_paragraph = iced::Point::new(point.x, point.y - line_top);
                return match line.paragraph.hit_test(point_in_paragraph) {
                    Some(hit) => Some(BufferPosition {
                        line: line_number,
                        column: hit.cursor(),
                    }),
                    None => {
                        // The point is not in the paragraph, but it is to the left or right of it, let's snap to it
                        if point_in_paragraph.x < 0.0 {
                            Some(BufferPosition {
                                line: line_number,
                                column: 0,
                            })
                        } else {
                            // The point is to the right of the paragraph, but we need to figure out which line it is on
                            // Let's find the last span that is to the left of the point

                            (0..line.spans.spans().len())
                                .filter_map(|idx| {
                                    line.paragraph
                                        .span_bounds(idx)
                                        .iter()
                                        .filter(|span_bounds| {
                                            span_bounds.y <= point_in_paragraph.y
                                                && span_bounds.y + span_bounds.height
                                                    > point_in_paragraph.y
                                        })
                                        .reduce(|acc, item| if acc.x > item.x { acc } else { item })
                                        .map(|span_bounds| (*span_bounds, idx))
                                })
                                .reduce(|acc, item| if acc.0.x > item.0.x { acc } else { item })
                                .map(|(_, idx)| BufferPosition {
                                    line: line_number,
                                    column: line
                                        .spans
                                        .spans()
                                        .iter()
                                        .take(idx + 1)
                                        .fold(0, |acc, span| acc + span.text.len()),
                                })
                        }
                    }
                };
            }
        }
        None
    }
}

pub struct TerminalPane<'a> {
    terminal_buffer: Ref<'a, TerminalBuffer>,
    selection: Rc<RefCell<Selection>>,
    last_line_number: Option<usize>,
    /// Called with the action of a clicked link span. A plain callback rather than a
    /// shell message so the pane stays `Message`-agnostic (it is instantiated under
    /// several message types); the handler sends the resulting runtime action itself.
    on_link: Option<Rc<dyn Fn(LinkClickEvent)>>,
    /// Routes the one lazy first-hover request for script-authored tooltip copy.
    on_link_tooltip: Option<Rc<dyn Fn(LinkTooltipCallback)>>,
    /// Per-pane terminal font override (`docs/panes.md`); `None` follows the
    /// global preference.
    font_size: Option<f32>,
}

impl<'a> TerminalPane<'a> {
    pub fn new(buffer: Ref<'a, TerminalBuffer>, selection: Rc<RefCell<Selection>>) -> Self {
        log::debug!("TerminalPane::new() called");
        Self {
            terminal_buffer: buffer,
            selection,
            last_line_number: None,
            on_link: None,
            on_link_tooltip: None,
            font_size: None,
        }
    }

    pub fn last_line_number(mut self, last_line_number: usize) -> Self {
        self.last_line_number = Some(last_line_number);
        self
    }

    pub fn on_link(mut self, on_link: Option<Rc<dyn Fn(LinkClickEvent)>>) -> Self {
        self.on_link = on_link;
        self
    }

    pub fn on_link_tooltip(
        mut self,
        on_link_tooltip: Option<Rc<dyn Fn(LinkTooltipCallback)>>,
    ) -> Self {
        self.on_link_tooltip = on_link_tooltip;
        self
    }

    pub fn font_size(mut self, font_size: Option<f32>) -> Self {
        self.font_size = font_size;
        self
    }
}

impl<'a, Message, Theme, Renderer> Widget<Message, Theme, Renderer> for TerminalPane<'a>
where
    Renderer: text::Renderer<Font = iced::Font> + 'a,
    Renderer::Paragraph:
        iced::advanced::text::Paragraph<Font = iced::Font> + Clone + std::fmt::Debug + 'static,
    Theme: iced::widget::text::Catalog + 'a,
{
    fn size(&self) -> iced::Size<iced::Length> {
        iced::Size::new(iced::Length::Fill, iced::Length::Fill)
    }

    fn size_hint(&self) -> iced::Size<iced::Length> {
        iced::Size::new(iced::Length::Fill, iced::Length::Fill)
    }

    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State<Renderer::Paragraph>>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::<Renderer::Paragraph>::default())
    }

    fn layout(
        &mut self,
        tree: &mut Tree,
        _renderer: &Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        let state = tree.state.downcast_mut::<State<Renderer::Paragraph>>();
        let selection = self.selection.borrow();
        let prefs = crate::prefs::current();
        let (font_size, line_height) = effective_metrics(&prefs, self.font_size);

        // The measured width of one monospace cell at the current font/size,
        // measured once per (prefs generation, effective font size). It clamps
        // the wrap width when a maximum line length is configured, and the
        // parent split pane reads it to derive the character grid NAWS reports.
        let advance = match state.advance {
            Some((generation, probe_size, advance))
                if generation == prefs.generation && probe_size == font_size =>
            {
                advance
            }
            _ => {
                let probe = Renderer::Paragraph::with_text(iced::advanced::text::Text {
                    content: ADVANCE_PROBE,
                    bounds: iced::Size::new(f32::INFINITY, f32::INFINITY),
                    size: Pixels(font_size),
                    font: prefs.font,
                    line_height: LineHeight::Absolute(Pixels(line_height)),
                    align_x: text::Alignment::Left,
                    align_y: alignment::Vertical::Top,
                    shaping: text::Shaping::Advanced,
                    wrapping: text::Wrapping::None,
                });
                let advance = probe.min_width() / ADVANCE_PROBE.len() as f32;
                state.advance = Some((prefs.generation, font_size, advance));
                advance
            }
        };

        // When a maximum line length (in columns) is configured, clamp the
        // wrap width to `cols * advance`. Text stays left-aligned in the
        // full pane.
        let text_width = match prefs.line_length {
            Some(cols) => limits.max().width.min(f32::from(cols) * advance),
            None => limits.max().width,
        };
        let text_bounds = iced::Size::new(text_width, limits.max().height);

        let mut new_cache: Vec<ParagraphCache<Renderer::Paragraph>> =
            Vec::with_capacity(state.cache.len());

        let mut i = 0;

        let mut available_y = limits.max().height;

        state.last_line_number = self
            .last_line_number
            .unwrap_or(self.terminal_buffer.last_line_number());

        for (line_number, line) in self
            .terminal_buffer
            .iter_rev_with_line_number(self.last_line_number)
        {
            if available_y < 0.0 {
                break;
            }

            // look for a matching cached Paragraph in state.paragraphs[i] or state.paragraphs[i + 1],
            // advancing i by 1 if a match is found; entries shaped under an
            // older prefs generation — or a different effective font size —
            // are always misses
            if let Some(cache) = state.cache.get_mut(i)
                && cache.generation == prefs.generation
                && cache.font_size == font_size
            {
                let line_selection = selection.for_line(line_number);

                if cache.selection != line_selection {
                    match line_selection {
                        None => {
                            cache.spans.select_none();
                        }
                        Some((0, usize::MAX)) => {
                            cache.spans.select_all();
                        }
                        Some((from, to)) => {
                            cache.spans.select_range(from, to);
                        }
                    }
                } else if Rc::ptr_eq(&cache.spans.spans(), line.spans()) {
                    i += 1;

                    if text_bounds.width > cache.max_valid_width
                        || text_bounds.width < cache.paragraph.min_bounds().width
                    {
                        cache.paragraph.resize(text_bounds);
                        cache.max_valid_width = text_bounds.width;
                    }

                    new_cache.push(cache.clone());

                    available_y -= cache.paragraph.min_height();
                    continue;
                }
            }

            let line_selection = selection.for_line(line_number);
            let spans = Spans::with_selection(line.spans().clone(), line_selection);

            let spans_vec = spans.spans();
            let make_paragraph = |content: &[iced::widget::text::Span<'static, Link>]| {
                Renderer::Paragraph::with_spans(iced::advanced::text::Text {
                    content,
                    bounds: text_bounds,
                    size: Pixels(font_size),
                    font: prefs.font,
                    line_height: LineHeight::Absolute(Pixels(line_height)),
                    align_x: text::Alignment::Left,
                    align_y: alignment::Vertical::Top,
                    shaping: text::Shaping::Advanced,
                    wrapping: text::Wrapping::WordOrGlyph,
                })
            };
            let slow_hidden_spans = hidden_blink_spans(&spans_vec, true, false);
            let fast_hidden_spans = hidden_blink_spans(&spans_vec, false, true);
            let all_hidden_spans = if slow_hidden_spans.is_some() && fast_hidden_spans.is_some() {
                hidden_blink_spans(&spans_vec, true, true)
            } else {
                None
            };
            let blink_modes = (u8::from(slow_hidden_spans.is_some()) * SLOW_BLINK)
                | (u8::from(fast_hidden_spans.is_some()) * FAST_BLINK);
            let slow_blink_hidden = slow_hidden_spans.as_deref().map(&make_paragraph);
            let fast_blink_hidden = fast_hidden_spans.as_deref().map(&make_paragraph);
            let all_blink_hidden = all_hidden_spans.as_deref().map(&make_paragraph);
            let paragraph = make_paragraph(&spans_vec);

            available_y -= paragraph.min_height();

            new_cache.push(ParagraphCache {
                spans,
                paragraph,
                slow_blink_hidden,
                fast_blink_hidden,
                all_blink_hidden,
                blink_modes,
                max_valid_width: text_bounds.width,
                selection: line_selection,
                generation: prefs.generation,
                font_size,
            });
        }

        state.cache = new_cache;

        layout::atomic(limits, iced::Length::Fill, iced::Length::Fill)
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        _theme: &Theme,
        _style_defaults: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        let state = tree.state.downcast_ref::<State<Renderer::Paragraph>>();
        let prefs = crate::prefs::current();

        if let Some(clipped_viewport) = layout.bounds().intersection(viewport) {
            let mut y = layout.bounds().y + layout.bounds().height;
            for cache in state.cache.iter() {
                y -= cache.paragraph.min_height();

                // Span decorations: explicit background quads and link underlines —
                // the same geometry iced's rich_text widget draws (fill_paragraph
                // renders glyphs only). Undecorated spans (the overwhelmingly
                // common case) skip before any span_bounds work.
                for (span_idx, span) in cache.spans.spans().iter().enumerate() {
                    let metadata = span.link.unwrap_or_default();
                    if span.highlight.is_none()
                        && metadata.underline == LinkDecoration::None
                        && metadata.overline == LinkDecoration::None
                        && metadata.strikethrough == LinkDecoration::None
                    {
                        continue;
                    }
                    let regions = cache.paragraph.span_bounds(span_idx);
                    let blink_hidden = match metadata.blink {
                        smudgy_core::session::styled_line::Blink::None => false,
                        smudgy_core::session::styled_line::Blink::Slow => !state.slow_blink_visible,
                        smudgy_core::session::styled_line::Blink::Fast => !state.fast_blink_visible,
                    };

                    if let Some(highlight) = span.highlight {
                        for region in &regions {
                            let rect = Rectangle {
                                x: layout.bounds().x + region.x,
                                y: region.y + y,
                                width: region.width,
                                height: region.height,
                            };
                            if let Some(bounds) = rect.intersection(&clipped_viewport) {
                                renderer.fill_quad(
                                    Quad {
                                        bounds,
                                        border: highlight.border,
                                        ..Default::default()
                                    },
                                    highlight.background,
                                );
                            }
                        }
                    }

                    if !blink_hidden {
                        // Baseline placement per iced's rich_text: the underline
                        // sits at font size plus half the leading, nudged up by
                        // 8% of the font size.
                        let (font_size, line_height) = effective_metrics(&prefs, self.font_size);
                        let underline_y =
                            font_size + (line_height - font_size) / 2.0 - font_size * 0.08;
                        let strike_y = (line_height - font_size) / 2.0 + font_size * 0.55;
                        let overline_y = (line_height - font_size) / 2.0 + 1.0;
                        let color = metadata
                            .decoration_color
                            .or(span.color)
                            .unwrap_or(iced::Color::WHITE);
                        for region in &regions {
                            let region = Rectangle {
                                x: layout.bounds().x + region.x,
                                y: region.y + y,
                                width: region.width,
                                height: region.height,
                            };
                            draw_text_decoration(
                                renderer,
                                region,
                                region.y + underline_y,
                                metadata.underline,
                                color,
                                clipped_viewport,
                            );
                            draw_text_decoration(
                                renderer,
                                region,
                                region.y + overline_y,
                                metadata.overline,
                                color,
                                clipped_viewport,
                            );
                            draw_text_decoration(
                                renderer,
                                region,
                                region.y + strike_y,
                                metadata.strikethrough,
                                color,
                                clipped_viewport,
                            );
                        }
                    }
                }

                for selected_span_idx in cache.spans.selected().iter() {
                    let span_bounds_list = cache.paragraph.span_bounds(*selected_span_idx);

                    for span_bounds in span_bounds_list.iter() {
                        let span_rect = Rectangle {
                            x: layout.bounds().x + span_bounds.x,
                            y: span_bounds.y + y,
                            width: span_bounds.width,
                            height: span_bounds.height,
                        };
                        if let Some(bounds) = span_rect.intersection(&clipped_viewport) {
                            renderer.fill_quad(
                                Quad {
                                    bounds,
                                    ..Default::default()
                                },
                                Background::Color(prefs.palette.selection),
                            );
                        }
                    }
                }

                renderer.fill_paragraph(
                    cache.displayed_paragraph(state.slow_blink_visible, state.fast_blink_visible),
                    iced::Point::new(layout.bounds().x, y),
                    iced::Color::WHITE,
                    clipped_viewport,
                );
            }

            if let Some(popup) = &state.menu_popup {
                draw_link_menu(renderer, &prefs, clipped_viewport, cursor, popup);
            } else if let Some(position) = cursor.position_in(layout.bounds())
                && let Some(buffer_position) = state.hit_test(layout.bounds(), position)
                && let Some(action) = self
                    .terminal_buffer
                    .link_at(buffer_position.line, buffer_position.column)
                && let Some(tooltip) = self
                    .terminal_buffer
                    .link_tooltip_at(buffer_position.line, buffer_position.column)
                && state
                    .link_tooltip_hover
                    .as_ref()
                    .is_some_and(|hover| hover.is_open_for(&action, &tooltip))
            {
                draw_link_tooltip(
                    renderer,
                    &prefs,
                    clipped_viewport,
                    cursor,
                    &action,
                    &tooltip,
                    &state.link_tooltip_paragraph,
                );
            }
        }
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        _renderer: &Renderer,
    ) -> mouse::Interaction {
        if cursor.is_over(layout.bounds()) {
            // Pointer over a link span; text cursor elsewhere. The `has_links` guard
            // keeps linkless sessions (the common case) from paying the per-frame
            // hit test at all.
            if self.on_link.is_some() && self.terminal_buffer.has_links() {
                let state = tree.state.downcast_ref::<State<Renderer::Paragraph>>();
                if let Some(popup) = &state.menu_popup
                    && let Some(clipped_viewport) = layout.bounds().intersection(viewport)
                    && let Some(geometry) = link_menu_geometry::<Renderer>(
                        popup,
                        &crate::prefs::current(),
                        clipped_viewport,
                    )
                    && cursor.is_over(geometry.bounds)
                {
                    return mouse::Interaction::Pointer;
                }
                if let Some(position) = cursor
                    .position_in(layout.bounds())
                    .and_then(|position| state.hit_test(layout.bounds(), position))
                    && self
                        .terminal_buffer
                        .link_at(position.line, position.column)
                        .is_some_and(|action| action.is_interactive())
                {
                    return mouse::Interaction::Pointer;
                }
            }
            mouse::Interaction::Text
        } else {
            mouse::Interaction::Idle
        }
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &iced::Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        _renderer: &Renderer,
        clipboard: &mut dyn advanced::Clipboard,
        shell: &mut advanced::Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        let cursor_moved = matches!(event, Event::Mouse(mouse::Event::CursorMoved { .. }));
        if let Event::Window(window::Event::RedrawRequested(now)) = event {
            let state = tree.state.downcast_mut::<State<Renderer::Paragraph>>();
            let blink_modes = state
                .cache
                .iter()
                .fold(0, |modes, cache| modes | cache.blink_modes);
            if blink_modes != 0 {
                let elapsed_ms = now.saturating_duration_since(state.blink_epoch).as_millis();
                let mut next_ms = u128::MAX;
                if blink_modes & SLOW_BLINK != 0 {
                    state.slow_blink_visible =
                        (elapsed_ms / SLOW_BLINK_HALF_PERIOD_MS).is_multiple_of(2);
                    next_ms = next_ms
                        .min(SLOW_BLINK_HALF_PERIOD_MS - elapsed_ms % SLOW_BLINK_HALF_PERIOD_MS);
                }
                if blink_modes & FAST_BLINK != 0 {
                    state.fast_blink_visible =
                        (elapsed_ms / FAST_BLINK_HALF_PERIOD_MS).is_multiple_of(2);
                    next_ms = next_ms
                        .min(FAST_BLINK_HALF_PERIOD_MS - elapsed_ms % FAST_BLINK_HALF_PERIOD_MS);
                }
                shell.request_redraw_at(
                    *now + Duration::from_millis(u64::try_from(next_ms).unwrap_or(1)),
                );
            }
        }
        if matches!(
            event,
            Event::Mouse(_) | Event::Window(window::Event::RedrawRequested(_))
        ) {
            let state = tree.state.downcast_mut::<State<Renderer::Paragraph>>();
            let hovered = state
                .menu_popup
                .is_none()
                .then(|| cursor.position_in(layout.bounds()))
                .flatten()
                .and_then(|position| state.hit_test(layout.bounds(), position))
                .and_then(|position| {
                    let action = self
                        .terminal_buffer
                        .link_at(position.line, position.column)?;
                    let tooltip = self
                        .terminal_buffer
                        .link_tooltip_at(position.line, position.column)?;
                    Some(HoveredLinkTooltip { action, tooltip })
                });
            let now = Instant::now();
            let delay = Duration::from_millis(crate::prefs::current().link_tooltip_delay_ms);
            let previous = state.link_tooltip_hover.take();
            state.link_tooltip_hover = match (previous, hovered) {
                (None, None) => None,
                (Some(previous), None) => {
                    if previous.is_open() {
                        shell.request_redraw();
                    }
                    None
                }
                (None, Some(link)) => Some(begin_link_tooltip_hover(link, delay, now, shell)),
                (Some(previous), Some(link)) if previous.link() != &link => {
                    if previous.is_open() {
                        shell.request_redraw();
                    }
                    Some(begin_link_tooltip_hover(link, delay, now, shell))
                }
                (Some(LinkTooltipHover::Waiting { at, .. }), Some(link)) => {
                    let elapsed = at.elapsed();
                    if elapsed >= delay {
                        shell.request_redraw();
                        Some(LinkTooltipHover::Open(link))
                    } else {
                        shell.request_redraw_at(now + delay - elapsed);
                        Some(LinkTooltipHover::Waiting { link, at })
                    }
                }
                (Some(LinkTooltipHover::Open(_)), Some(link)) => {
                    if cursor_moved {
                        shell.request_redraw();
                    }
                    Some(LinkTooltipHover::Open(link))
                }
            };
        }

        if matches!(
            event,
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))
        ) {
            let state = tree.state.downcast_mut::<State<Renderer::Paragraph>>();
            if let Some(popup) = state.menu_popup.clone()
                && let Some(clipped_viewport) = layout.bounds().intersection(viewport)
                && let Some(geometry) = link_menu_geometry::<Renderer>(
                    &popup,
                    &crate::prefs::current(),
                    clipped_viewport,
                )
            {
                let chosen = cursor.position().and_then(|point| {
                    popup.menu.items.iter().zip(&geometry.rows).find_map(
                        |(item, bounds)| match item {
                            LinkMenuItem::Action { action, .. } if bounds.contains(point) => {
                                Some(action.clone())
                            }
                            _ => None,
                        },
                    )
                });
                let inside = cursor.is_over(geometry.bounds);
                state.menu_popup = None;
                shell.invalidate_layout();
                shell.request_redraw();
                if let Some(action) = chosen {
                    if let Some(on_link) = self.on_link.as_ref() {
                        on_link(LinkClickEvent {
                            action,
                            shift: state.modifiers.shift(),
                            ctrl: state.modifiers.control(),
                            alt: state.modifiers.alt(),
                        });
                    }
                    shell.capture_event();
                    return;
                }
                if inside {
                    shell.capture_event();
                    return;
                }
            }
        }

        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Right)) => {
                let state = tree.state.downcast_mut::<State<Renderer::Paragraph>>();
                let had_popup = state.menu_popup.is_some();
                let menu = self
                    .on_link
                    .as_ref()
                    .and_then(|_| cursor.position_in(layout.bounds()))
                    .and_then(|position| state.hit_test(layout.bounds(), position))
                    .and_then(|position| {
                        self.terminal_buffer.link_at(position.line, position.column)
                    })
                    .and_then(|action| action.menu().cloned());
                state.menu_popup =
                    menu.zip(cursor.position())
                        .map(|(menu, anchor)| LinkMenuPopup {
                            menu,
                            anchor: Point::new(anchor.x + 2.0, anchor.y + 2.0),
                        });
                if state.menu_popup.is_some() {
                    state.pressed_cell = None;
                    state.link_tooltip_hover = None;
                    shell.invalidate_layout();
                    shell.request_redraw();
                    shell.capture_event();
                } else if had_popup {
                    shell.invalidate_layout();
                    shell.request_redraw();
                }
            }
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))
            | Event::Touch(touch::Event::FingerPressed { .. }) => {
                let state = tree.state.downcast_mut::<State<Renderer::Paragraph>>();

                // Null-primary script menus are ordinary left-click menus. Open
                // them on mouse-down so the next frame can paint the popup without
                // waiting for a full click/release cycle. Touch keeps the existing
                // tap-on-release path below so a scroll gesture cannot open one.
                if matches!(
                    event,
                    Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))
                ) && let Some(anchor) = cursor.position()
                    && let Some(position) = cursor
                        .position_in(layout.bounds())
                        .and_then(|position| state.hit_test(layout.bounds(), position))
                    && let Some(action) =
                        self.terminal_buffer.link_at(position.line, position.column)
                    && action.opens_menu_on_left_click()
                    && let Some(menu) = action.menu().cloned()
                {
                    state.menu_popup = Some(LinkMenuPopup {
                        menu,
                        anchor: Point::new(anchor.x + 2.0, anchor.y + 2.0),
                    });
                    state.pressed_cell = None;
                    state.link_tooltip_hover = None;
                    state.is_focused = true;
                    shell.invalidate_layout();
                    shell.request_redraw();
                    // Keep the press uncaptured, like ordinary terminal clicks,
                    // so the parent can still focus this session's command input.
                    return;
                }

                let mut selection = self.selection.borrow_mut();

                if let Some(click_position) = cursor.position_in(layout.bounds()) {
                    if let Some(position) = state.hit_test(layout.bounds(), click_position) {
                        state.pressed_cell = Some(position.clone());
                        *selection = Selection::Selecting {
                            origin: position.clone(),
                            from: position.clone(),
                            to: position,
                        };
                        shell.invalidate_layout();
                    }
                    state.is_focused = true;
                    // We don't capture the event here because we want the click input to bubble up, so we can also use it to focus this session's input
                } else {
                    state.is_focused = false;
                }
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))
            | Event::Touch(touch::Event::FingerLifted { .. }) => {
                let state = tree.state.downcast_mut::<State<Renderer::Paragraph>>();

                // A click is a press and release resolving to the SAME buffer cell
                // (`pressed_cell` survives only while the pointer stays on it): a drag
                // ends elsewhere, and content scrolling under a stationary cursor
                // moves the release onto a different absolute line — neither fires.
                if let Some(pressed) = state.pressed_cell.take()
                    && let Some(on_link) = self.on_link.as_ref()
                    && self.terminal_buffer.has_links()
                    && let Some(position) = cursor
                        .position_in(layout.bounds())
                        .and_then(|position| state.hit_test(layout.bounds(), position))
                    && position == pressed
                    && let Some(action) =
                        self.terminal_buffer.link_at(position.line, position.column)
                {
                    if let Some(primary) = action.primary().cloned() {
                        on_link(LinkClickEvent {
                            action: primary,
                            shift: state.modifiers.shift(),
                            ctrl: state.modifiers.control(),
                            alt: state.modifiers.alt(),
                        });
                        // The handler may have staged UI state (the link-trust
                        // confirm dialog slot) rather than publishing a message;
                        // invalidate so it renders this frame, like the
                        // selection updates above.
                        shell.invalidate_layout();
                    } else if action.opens_menu_on_left_click()
                        && let Some(menu) = action.menu().cloned()
                        && let Some(anchor) = cursor.position()
                    {
                        state.menu_popup = Some(LinkMenuPopup {
                            menu,
                            anchor: Point::new(anchor.x + 2.0, anchor.y + 2.0),
                        });
                        state.link_tooltip_hover = None;
                        shell.invalidate_layout();
                        shell.request_redraw();
                    }
                }

                let mut selection = self.selection.borrow_mut();
                if let Selection::Selecting {
                    origin: _,
                    ref from,
                    ref to,
                } = *selection
                {
                    *selection = Selection::Selected {
                        from: from.clone(),
                        to: to.clone(),
                    };

                    shell.invalidate_layout();
                    // We don't capture the event here because we want the click input to bubble up, so we can also use it to focus this session's input
                }
            }
            Event::Mouse(mouse::Event::CursorMoved { position: _ }) => {
                let state = tree.state.downcast_mut::<State<Renderer::Paragraph>>();

                if state.menu_popup.is_some() {
                    shell.request_redraw();
                }

                if let Some(on_tooltip) = self.on_link_tooltip.as_ref()
                    && state.menu_popup.is_none()
                    && self.terminal_buffer.has_links()
                    && let Some(position) = cursor
                        .position_in(layout.bounds())
                        .and_then(|position| state.hit_test(layout.bounds(), position))
                    && let Some(tooltip) = self
                        .terminal_buffer
                        .link_tooltip_at(position.line, position.column)
                    && let Some(request) = tooltip.request()
                {
                    on_tooltip(request);
                    shell.request_redraw();
                }

                // The pointer left the pressed cell (or the pane): whatever ends this
                // press, it is a drag, not a click.
                if state.pressed_cell.is_some() {
                    let hit = cursor
                        .position_from(layout.position())
                        .and_then(|position| state.hit_test(layout.bounds(), position));
                    if hit.as_ref() != state.pressed_cell.as_ref() {
                        state.pressed_cell = None;
                    }
                }

                let mut selection = self.selection.borrow_mut();

                if let Selection::Selecting {
                    ref origin,
                    from: _,
                    to: _,
                } = *selection
                    && let Some(cursor_position) = cursor.position_from(layout.position())
                    && let Some(position) = state.hit_test(layout.bounds(), cursor_position)
                {
                    let (from, to) = if position.line < origin.line
                        || (position.line == origin.line && position.column < origin.column)
                    {
                        (position, origin.clone())
                    } else {
                        (origin.clone(), position)
                    };

                    *selection = Selection::Selecting {
                        origin: origin.clone(),
                        from,
                        to,
                    };

                    shell.invalidate_layout();
                    shell.request_redraw();
                    shell.capture_event();
                }
            }
            Event::Keyboard(keyboard::Event::ModifiersChanged(modifiers)) => {
                let state = tree.state.downcast_mut::<State<Renderer::Paragraph>>();
                state.modifiers = *modifiers;
            }
            Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) => {
                let state = tree.state.downcast_mut::<State<Renderer::Paragraph>>();
                // Key events carry modifiers too; syncing here heals a widget whose
                // state was created after the last ModifiersChanged (a fresh pane, a
                // rebuilt tree) while a modifier was already held.
                state.modifiers = *modifiers;

                if matches!(
                    key.as_ref(),
                    keyboard::Key::Named(keyboard::key::Named::Escape)
                ) && state.menu_popup.take().is_some()
                {
                    shell.invalidate_layout();
                    shell.capture_event();
                    return;
                }

                if state.is_focused {
                    match key.as_ref() {
                        keyboard::Key::Character("c") if modifiers.command() => {
                            let to_copy =
                                self.terminal_buffer.selected_text(&self.selection.borrow());

                            if !to_copy.is_empty() {
                                clipboard.write(clipboard::Kind::Standard, to_copy);
                            }

                            shell.capture_event();
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

pub fn terminal_pane<'a>(
    buffer: Ref<'a, TerminalBuffer>,
    selection: Rc<RefCell<Selection>>,
) -> TerminalPane<'a> {
    TerminalPane::new(buffer, selection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use smudgy_core::session::styled_line::Blink;

    fn blinking_span(blink: Blink) -> iced::widget::text::Span<'static, Link> {
        iced::widget::text::Span::new("blink")
            .color(iced::Color::WHITE)
            .link(SpanMetadata {
                blink,
                ..SpanMetadata::default()
            })
    }

    #[test]
    fn blink_variants_hide_only_the_requested_rates() {
        let spans = [blinking_span(Blink::Slow), blinking_span(Blink::Fast)];
        let slow = hidden_blink_spans(&spans, true, false).expect("slow variant");
        assert_eq!(slow[0].color, Some(iced::Color::TRANSPARENT));
        assert_eq!(slow[1].color, Some(iced::Color::WHITE));

        let fast = hidden_blink_spans(&spans, false, true).expect("fast variant");
        assert_eq!(fast[0].color, Some(iced::Color::WHITE));
        assert_eq!(fast[1].color, Some(iced::Color::TRANSPARENT));

        let all = hidden_blink_spans(&spans, true, true).expect("combined variant");
        assert!(
            all.iter()
                .all(|span| span.color == Some(iced::Color::TRANSPARENT))
        );
    }
}
