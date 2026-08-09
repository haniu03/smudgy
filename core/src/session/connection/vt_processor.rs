use std::sync::Arc;

use tokio::sync::mpsc::UnboundedSender;
use vtparse::{CsiParam, VTActor, VTParser};

use crate::session::{
    runtime::RuntimeAction,
    styled_line::{
        LinkAction, LinkColor, LinkDecoration, LinkMenu, LinkMenuItem, LinkSpan, LinkStyle,
        LinkTextStyle, LinkTooltip, LinkTooltipText, Style, StyledLine, VtSpan,
    },
};

mod sgr;
pub use sgr::{AnsiColor, Color};
// Expose the SGR interpreter to the `smudgy_bench` crate without widening the normal public
// API: `mod sgr` stays private; the function becomes reachable only under the feature.
#[cfg(feature = "bench-api")]
pub use sgr::process as sgr_process;

/// The most bytes an OSC 8 URI may carry; longer links are ignored (the text
/// still displays, unlinked).
const MAX_OSC8_URI_LEN: usize = 4096;

struct TooltipAnsiActor {
    text: String,
    spans: Vec<VtSpan>,
    style: Style,
    span_start: usize,
    pending_cr: bool,
}

impl Default for TooltipAnsiActor {
    fn default() -> Self {
        Self {
            text: String::new(),
            spans: Vec::new(),
            style: Style::default(),
            span_start: 0,
            pending_cr: false,
        }
    }
}

impl TooltipAnsiActor {
    fn close_span(&mut self) {
        if self.text.len() > self.span_start {
            self.spans.push(VtSpan {
                style: self.style,
                begin_pos: self.span_start,
                end_pos: self.text.len(),
            });
            self.span_start = self.text.len();
        }
    }

    fn set_style(&mut self, style: Style) {
        if style != self.style {
            self.close_span();
            self.style = style;
        }
    }

    fn push(&mut self, c: char) {
        if std::mem::take(&mut self.pending_cr) {
            self.text.push('\n');
        }
        self.text.push(c);
    }

    fn finish(mut self) -> Option<LinkTooltipText> {
        if self.pending_cr {
            self.text.push('\n');
        }
        self.close_span();

        let begin = self.text.len() - self.text.trim_start().len();
        let end = self.text.trim_end().len();
        if begin >= end {
            return None;
        }
        let text: Arc<str> = Arc::from(&self.text[begin..end]);
        let spans: Vec<_> = self
            .spans
            .into_iter()
            .filter_map(|span| {
                let span_begin = span.begin_pos.max(begin);
                let span_end = span.end_pos.min(end);
                (span_begin < span_end).then_some(VtSpan {
                    style: span.style,
                    begin_pos: span_begin - begin,
                    end_pos: span_end - begin,
                })
            })
            .collect();
        Some(LinkTooltipText {
            text,
            spans: spans.into(),
        })
    }
}

impl VTActor for TooltipAnsiActor {
    fn print(&mut self, c: char) {
        self.push(c);
    }

    fn execute_c0_or_c1(&mut self, control: u8) {
        match control {
            b'\r' => {
                if self.pending_cr {
                    self.text.push('\n');
                }
                self.pending_cr = true;
            }
            b'\n' => {
                self.pending_cr = false;
                self.text.push('\n');
            }
            _ => self.push(' '),
        }
    }

    fn dcs_hook(
        &mut self,
        _byte: u8,
        _params: &[i64],
        _intermediates: &[u8],
        _ignored_excess_intermediates: bool,
    ) {
    }

    fn dcs_put(&mut self, _byte: u8) {}

    fn dcs_unhook(&mut self) {}

    fn esc_dispatch(
        &mut self,
        _params: &[i64],
        _intermediates: &[u8],
        _ignored_excess_intermediates: bool,
        _byte: u8,
    ) {
    }

    fn csi_dispatch(&mut self, params: &[CsiParam], _parameters_truncated: bool, byte: u8) {
        if byte == b'm' {
            self.set_style(sgr::process(self.style, params));
        }
    }

    fn osc_dispatch(&mut self, _params: &[&[u8]]) {}

    fn apc_dispatch(&mut self, _data: Vec<u8>) {}
}

/// Parse authored tooltip copy as a safe SGR-only ANSI document. SGR updates
/// become semantic color spans; every other terminal sequence is discarded.
#[must_use]
pub fn parse_link_tooltip_text(text: &str) -> Option<LinkTooltipText> {
    let mut parser = VTParser::new();
    let mut actor = TooltipAnsiActor::default();
    for &byte in text.as_bytes() {
        parser.parse_byte(byte, &mut actor);
    }
    actor.finish()
}

/// Map an OSC 8 URI to its click action. The scheme allowlist is the trust
/// boundary: `http`/`https` open the browser (behind the per-server confirm),
/// a `send:` URI sends its percent-decoded command (same gate), and anything
/// else — `file:`, `javascript:`, unknown schemes — yields no link at all.
#[derive(Debug)]
struct ParsedLink {
    action: LinkAction,
    tooltip: LinkTooltip,
    style: Option<LinkStyle>,
}

#[derive(Default)]
struct Osc8Config {
    tooltip: Option<LinkTooltipText>,
    disabled: bool,
    menu: Option<LinkMenu>,
    style: Option<LinkStyle>,
}

fn link_color(value: &serde_json::Value) -> Option<LinkColor> {
    let canonical = smudgy_cloud::canonicalize_css_color(value.as_str()?.trim())?;
    let hex = canonical.strip_prefix('#')?;
    let byte = |start| u8::from_str_radix(hex.get(start..start + 2)?, 16).ok();
    Some(LinkColor {
        red: byte(0)?,
        green: byte(2)?,
        blue: byte(4)?,
        alpha: if hex.len() == 8 { byte(6)? } else { u8::MAX },
    })
}

fn link_decoration(value: &serde_json::Value) -> Option<LinkDecoration> {
    if let Some(enabled) = value.as_bool() {
        return Some(if enabled {
            LinkDecoration::Solid
        } else {
            LinkDecoration::None
        });
    }
    match value.as_str()?.to_ascii_lowercase().as_str() {
        "none" | "false" => Some(LinkDecoration::None),
        "solid" | "single" | "true" => Some(LinkDecoration::Solid),
        "double" => Some(LinkDecoration::Double),
        "dotted" => Some(LinkDecoration::Dotted),
        "dashed" => Some(LinkDecoration::Dashed),
        "wavy" => Some(LinkDecoration::Wavy),
        _ => None,
    }
}

fn style_field<'a>(
    style: &'a serde_json::Map<String, serde_json::Value>,
    full: &str,
    compact: &str,
) -> Option<&'a serde_json::Value> {
    style.get(full).or_else(|| style.get(compact))
}

fn parse_link_style(value: &serde_json::Value) -> Option<LinkStyle> {
    let style = value.as_object()?;
    Some(LinkStyle {
        base: LinkTextStyle {
            foreground: style_field(style, "color", "c").and_then(link_color),
            background: style_field(style, "bg", "bg").and_then(link_color),
            bold: style_field(style, "bold", "b").and_then(serde_json::Value::as_bool),
            italic: style_field(style, "italic", "i").and_then(serde_json::Value::as_bool),
            underline: style_field(style, "underline", "u").and_then(link_decoration),
            overline: style_field(style, "overline", "o").and_then(link_decoration),
            strikethrough: style_field(style, "strikethrough", "st").and_then(link_decoration),
            decoration_color: style_field(style, "text-decoration-color", "tdc")
                .and_then(link_color),
        },
    })
}

/// Extract the first valid Mudlet-compatible `config` tooltip and remove all
/// literal `config` query fields from the actionable target. Smudgy advertises
/// `OSC_HYPERLINKS_TOOLTIP`, so the extension specification reserves this key;
/// an ordinary URL can retain one by percent-encoding the key itself.
fn osc8_config(uri: &str) -> (String, Osc8Config) {
    let (before_fragment, fragment) = uri
        .split_once('#')
        .map_or((uri, None), |(head, tail)| (head, Some(tail)));
    let Some((base, query)) = before_fragment.split_once('?') else {
        return (uri.to_string(), Osc8Config::default());
    };
    if !query.split('&').any(|field| field.starts_with("config=")) {
        return (uri.to_string(), Osc8Config::default());
    }
    let config = query.split('&').find_map(|field| {
        let encoded = field.strip_prefix("config=")?;
        let decoded = percent_decode(encoded);
        serde_json::from_str::<serde_json::Value>(&decoded).ok()
    });

    let kept: Vec<_> = query
        .split('&')
        .filter(|field| !field.starts_with("config="))
        .collect();
    let mut target = String::with_capacity(uri.len());
    target.push_str(base);
    if !kept.is_empty() {
        target.push('?');
        target.push_str(&kept.join("&"));
    }
    if let Some(fragment) = fragment {
        target.push('#');
        target.push_str(fragment);
    }
    let Some(config) = config else {
        return (target, Osc8Config::default());
    };
    let tooltip = config
        .get("tooltip")
        .or_else(|| config.get("t"))
        .and_then(serde_json::Value::as_str)
        .and_then(parse_link_tooltip_text);
    let disabled = config
        .get("disabled")
        .or_else(|| config.get("d"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let title = config
        .get("title")
        .or_else(|| config.get("ti"))
        .and_then(menu_title);
    let menu = config
        .get("menu")
        .or_else(|| config.get("m"))
        .and_then(|menu| parse_menu(menu, title));
    let style = config
        .get("style")
        .or_else(|| config.get("s"))
        .and_then(parse_link_style);
    (
        target,
        Osc8Config {
            tooltip,
            disabled,
            menu,
            style,
        },
    )
}

fn menu_title(value: &serde_json::Value) -> Option<Arc<str>> {
    value
        .as_str()
        .or_else(|| value.get("text").and_then(serde_json::Value::as_str))
        .and_then(sanitize_single_line_text)
}

fn parse_menu(value: &serde_json::Value, title: Option<Arc<str>>) -> Option<LinkMenu> {
    let mut items = Vec::new();
    for value in value.as_array()? {
        if value.as_str() == Some("-") {
            items.push(LinkMenuItem::Separator);
            continue;
        }
        let Some((label, uri)) = value.as_object().and_then(|item| {
            item.iter()
                .find_map(|(label, uri)| uri.as_str().map(|uri| (label, uri)))
        }) else {
            continue;
        };
        let Some(label) = sanitize_single_line_text(label) else {
            continue;
        };
        let Some(action) = server_action_for_uri(uri) else {
            continue;
        };
        items.push(LinkMenuItem::Action { label, action });
    }
    (!items.is_empty()).then(|| LinkMenu {
        title,
        items: items.into(),
    })
}

/// Menu chrome stays one-line even though tooltip prose may be multiline.
fn sanitize_single_line_text(text: &str) -> Option<Arc<str>> {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| Arc::from(cleaned))
}

fn starts_with_ascii_case_insensitive(value: &str, prefix: &str) -> bool {
    value.len() >= prefix.len()
        && value.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn server_action_for_uri(uri: &str) -> Option<LinkAction> {
    if starts_with_ascii_case_insensitive(uri, "http://")
        || starts_with_ascii_case_insensitive(uri, "https://")
        || starts_with_ascii_case_insensitive(uri, "ftp://")
    {
        return Some(LinkAction::OpenUrl(Arc::from(uri)));
    }
    if starts_with_ascii_case_insensitive(uri, "send:") {
        return Some(LinkAction::ServerSend(Arc::from(percent_decode(&uri[5..]))));
    }
    if starts_with_ascii_case_insensitive(uri, "prompt:") {
        return Some(LinkAction::Prompt(Arc::from(percent_decode(&uri[7..]))));
    }
    None
}

fn action_display_target(action: &LinkAction) -> Option<Arc<str>> {
    match action.disclosed_target()? {
        LinkAction::OpenUrl(url) => Some(url.clone()),
        LinkAction::ServerSend(command) => Some(Arc::from(format!("send:{command}"))),
        LinkAction::Prompt(command) => Some(Arc::from(format!("prompt:{command}"))),
        LinkAction::Send(command) => Some(command.clone()),
        LinkAction::Callback { .. } | LinkAction::Configured { .. } => None,
    }
}

fn link_action_for_uri(uri: &str) -> Option<ParsedLink> {
    if uri.len() > MAX_OSC8_URI_LEN {
        log::debug!("OSC 8 URI over {MAX_OSC8_URI_LEN} bytes ignored");
        return None;
    }
    let (target, config) = osc8_config(uri);
    let Some(primary) = server_action_for_uri(&target) else {
        log::debug!("OSC 8 URI with unsupported scheme ignored");
        return None;
    };
    let display_target = action_display_target(&primary);
    let tooltip = if let Some(text) = config.tooltip {
        LinkTooltip::styled_text(text, display_target.clone())
    } else if config.menu.is_some() && !config.disabled {
        LinkTooltip::text(Arc::from("Right-click for menu"), display_target.clone())
    } else {
        LinkTooltip::text(display_target.clone()?, None)
    };
    let action = if config.disabled || config.menu.is_some() {
        LinkAction::Configured {
            primary: Some(Box::new(primary)),
            disabled: config.disabled,
            primary_enabled: true,
            menu: config.menu,
            menu_on_left_click: false,
        }
    } else {
        primary
    };
    Some(ParsedLink {
        action,
        tooltip,
        style: config.style,
    })
}

/// Decode `%XX` escapes (RFC 3986); anything malformed passes through
/// verbatim. `+` is not space — that is form encoding, not URI encoding.
fn percent_decode(s: &str) -> String {
    fn hex_pair(bytes: &[u8]) -> Option<u8> {
        let hi = (*bytes.first()? as char).to_digit(16)?;
        let lo = (*bytes.get(1)? as char).to_digit(16)?;
        u8::try_from(hi * 16 + lo).ok()
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(byte) = bytes.get(i + 1..).and_then(hex_pair)
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug)]
pub struct VtProcessor {
    cursor_style: Style,
    buf: String,
    buf_raw: Vec<u8>,
    span_info: Vec<VtSpan>,
    /// Completed link ranges of the pending line (closed OSC 8 links).
    link_info: Vec<LinkSpan>,
    /// The active OSC 8 link, applied to every character until `ESC]8;;`.
    /// Like the cursor style, it survives line commits (a multi-line link)
    /// and carriage-return overprints.
    cursor_link: Option<ParsedLink>,
    /// Where in `buf` the active link's current range began.
    link_open_pos: usize,
    /// A bare `\r` arrived: the next printable character overwrites the open
    /// line (carriage-return overprint — progress bars, spinners) instead of
    /// appending to it. Holds `buf_raw`'s length at the `\r`, so the restart
    /// can drop exactly the superseded frame's raw bytes while keeping any
    /// that arrived after it (escape sequences, the new frame's first char —
    /// the connection pushes raw bytes before the parser sees them). `\n`
    /// clears it, so CRLF stays an ordinary commit. Persists across reads
    /// like the rest of the parse state.
    pending_cr: Option<usize>,
    session_runtime_tx: UnboundedSender<RuntimeAction>,
    /// Whether any trigger currently carries a raw pattern — the only consumer
    /// of `StyledLine::raw`. Owned by the trigger manager on the session thread
    /// and read here from the socket runtime; `None` (tests, benches) means
    /// always capture.
    raw_wanted: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// The `raw_wanted` value latched for the lines being accumulated: it FALLS
    /// at line boundaries but RISES only at read-batch boundaries, so an emitted
    /// line's raw form is always complete-or-absent — never a torn suffix — even
    /// though the flag flips concurrently with an in-flight parse run (see
    /// [`Self::refresh_capture_raw`]).
    capture_raw: bool,
}

const INPUT_BUFFER_CAPACITY: usize = 1024;

impl VtProcessor {
    #[must_use]
    pub fn new(session_runtime_tx: UnboundedSender<RuntimeAction>) -> Self {
        VtProcessor {
            cursor_style: Style::default(),
            buf: String::with_capacity(INPUT_BUFFER_CAPACITY),
            buf_raw: Vec::with_capacity(INPUT_BUFFER_CAPACITY),
            span_info: Vec::new(),
            link_info: Vec::new(),
            cursor_link: None,
            link_open_pos: 0,
            pending_cr: None,
            session_runtime_tx,
            raw_wanted: None,
            capture_raw: true,
        }
    }

    /// Ties raw capture to the given flag (the trigger manager's "any raw
    /// pattern exists" bit). A drop takes effect at the next line boundary; a
    /// rise waits for the next read-batch boundary.
    pub fn set_raw_wanted_flag(&mut self, flag: Arc<std::sync::atomic::AtomicBool>) {
        self.capture_raw = flag.load(std::sync::atomic::Ordering::Relaxed);
        self.raw_wanted = Some(flag);
    }

    /// Fall-only re-latch of `capture_raw`, called where the line buffers empty
    /// mid-run (line commit, prompt commit). The reader parses on the socket
    /// runtime while the trigger manager flips the flag from the session
    /// thread, and `TelnetBridge::on_data` hoists its per-byte raw push behind
    /// [`Self::capture_raw`] once per run: a mid-run FALL is safe under either
    /// hoisted branch (the push re-checks per byte, and a fallen commit
    /// attaches nothing), but a mid-run RISE would attach a torn raw suffix
    /// pushed only from the flip onward. Rises therefore wait for the batch
    /// boundary ([`Self::notify_end_of_buffer`]), where no run is in flight
    /// and the buffers are empty.
    fn refresh_capture_raw(&mut self) {
        if let Some(flag) = &self.raw_wanted {
            self.capture_raw = self.capture_raw && flag.load(std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// Whether raw bytes are currently being captured. The byte loop hoists
    /// its per-byte push behind this — sound across threads because the value
    /// can only fall mid-run (rises are deferred to batch boundaries), and a
    /// fall is safe under either hoisted branch.
    #[must_use]
    pub fn capture_raw(&self) -> bool {
        self.capture_raw
    }

    /// Close the active link's current range into `link_info` (empty ranges
    /// are dropped). `keep_active` retains the link across the boundary — a
    /// line commit inside a still-open link — while an explicit `ESC]8;;`
    /// ends it.
    fn close_link_range(&mut self, keep_active: bool) {
        if let Some(link) = &self.cursor_link {
            if self.buf.len() > self.link_open_pos {
                self.link_info.push(LinkSpan {
                    begin_pos: self.link_open_pos,
                    end_pos: self.buf.len(),
                    action: link.action.clone(),
                    tooltip: Some(link.tooltip.clone()),
                    style: link.style.clone(),
                });
            }
            if !keep_active {
                self.cursor_link = None;
            }
        }
        self.link_open_pos = self.buf.len();
    }

    /// Begin a link at the current buffer position, closing any open one (a
    /// second open without a close replaces it from that point).
    fn open_link(&mut self, link: ParsedLink) {
        self.close_link_range(false);
        self.cursor_link = Some(link);
        self.link_open_pos = self.buf.len();
    }

    /// A carriage-return overprint: discard the open frame — the local pending
    /// bytes, and (via [`RuntimeAction::RetractIncomingPartialLine`]) any
    /// prefix already flushed upstream as a partial — so the text after the
    /// `\r` replaces it. Raw bytes that arrived after the `\r` (up to and
    /// including the character triggering the restart) belong to the new
    /// frame and are kept. The cursor style survives, as on a real terminal.
    fn restart_open_line(&mut self, raw_mark: usize) {
        self.buf.clear();
        self.span_info.clear();
        // An active link survives the overprint like the cursor style does;
        // ranges already banked for the superseded frame are discarded.
        self.link_info.clear();
        self.link_open_pos = 0;
        self.buf_raw.drain(..raw_mark.min(self.buf_raw.len()));
        self.session_runtime_tx
            .send(RuntimeAction::RetractIncomingPartialLine)
            .unwrap();
    }

    fn change_style(&mut self, new_style: Style) {
        self.span_info.push(VtSpan {
            begin_pos: match self.span_info.last() {
                Some(span_info) => span_info.end_pos,
                None => 0,
            },
            end_pos: self.buf.len(),
            style: self.cursor_style,
        });

        self.cursor_style = new_style;
    }

    pub fn consume_into_pending_line(&mut self) -> StyledLine {
        self.change_style(self.cursor_style);
        // A link still open at the boundary contributes its range so far and
        // stays active: its next range begins at 0 on the next line.
        self.close_link_range(true);
        let mut line = StyledLine::new_with_raw(
            &self.buf,
            self.span_info.drain(..).collect(),
            self.capture_raw.then_some(self.buf_raw.as_slice()),
        );
        line.links = self.link_info.drain(..).collect();
        self.link_open_pos = 0;
        line
    }

    /// Notifies that the end of a read batch of incoming data has been reached — the
    /// connection reader calls this once per socket wake (up to its byte budget), not once
    /// per read chunk.
    ///
    /// This finalizes any pending partial line and sends it, then requests a repaint.
    /// Sends are best-effort: the session runtime can tear down while the reader is
    /// mid-batch on the socket runtime, and the connection task then exits via its
    /// disconnect signal.
    pub fn notify_end_of_buffer(&mut self) {
        let pending_line = Arc::new(self.consume_into_pending_line());
        if !self.buf.is_empty() {
            self.session_runtime_tx
                .send(RuntimeAction::HandleIncomingPartialLine(pending_line))
                .ok();
            self.buf.clear();
            self.buf_raw.clear();
            self.buf.shrink_to(INPUT_BUFFER_CAPACITY);
            self.buf_raw.shrink_to(INPUT_BUFFER_CAPACITY);
            // The frame a pending `\r` marked was just flushed upstream as a
            // partial; the restart's retraction covers it, and no local raw
            // bytes remain to drop.
            if self.pending_cr.is_some() {
                self.pending_cr = Some(0);
            }
        }
        self.session_runtime_tx
            .send(RuntimeAction::RequestRepaint)
            .ok();
        // The batch boundary is the one place capture may RISE: no parse run is
        // in flight (the reader calls this between batches) and the line buffers
        // are empty, so the next batch starts a fresh line under the new value
        // and `TelnetBridge::on_data` re-hoists it before any byte flows.
        if let Some(flag) = &self.raw_wanted {
            self.capture_raw = flag.load(std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// Commit the pending bytes as a **prompt**: emit them on the partial-line path (so
    /// `prompt:`-flagged triggers fire) and reset the buffers so the next bytes start a fresh line.
    ///
    /// Driven by the telnet layer when it decodes a prompt boundary (`IAC GA` / `IAC EOR`) — a
    /// precise, server-sent signal, unlike the partial-line-at-end-of-buffer heuristic in
    /// [`notify_end_of_buffer`](Self::notify_end_of_buffer). Clearing the buffers here is what stops
    /// that heuristic from re-emitting the same prompt at end of read. A no-op when nothing is
    /// pending (e.g. a bare `IAC GA` with no preceding text). The send is best-effort, like
    /// [`notify_end_of_buffer`](Self::notify_end_of_buffer)'s.
    pub fn commit_prompt(&mut self) {
        // A prompt boundary finalizes the line; a `\r` just before it must
        // not overwrite what follows.
        self.pending_cr = None;
        if self.buf.is_empty() {
            return;
        }
        let pending_line = Arc::new(self.consume_into_pending_line());
        self.session_runtime_tx
            .send(RuntimeAction::HandleIncomingPartialLine(pending_line))
            .ok();
        self.buf.clear();
        self.buf_raw.clear();
        self.buf.shrink_to(INPUT_BUFFER_CAPACITY);
        self.buf_raw.shrink_to(INPUT_BUFFER_CAPACITY);
        self.refresh_capture_raw();
    }

    fn commit_line(&mut self) {
        let pending_line = Arc::new(self.consume_into_pending_line());
        self.session_runtime_tx
            .send(RuntimeAction::HandleIncomingLine(pending_line))
            .ok();
        self.buf.clear();
        self.buf_raw.clear();
        self.refresh_capture_raw();
    }

    fn push_incoming_char(&mut self, ch: char) {
        self.buf.push(ch);
    }

    pub fn push_raw_incoming_byte(&mut self, byte: u8) {
        if self.capture_raw {
            self.buf_raw.push(byte);
        }
    }
}

impl VTActor for VtProcessor {
    fn print(&mut self, b: char) {
        if let Some(raw_mark) = self.pending_cr.take() {
            self.restart_open_line(raw_mark);
        }
        self.push_incoming_char(b);
    }

    fn execute_c0_or_c1(&mut self, control: u8) {
        match control {
            b'\n' => {
                self.pending_cr = None;
                self.commit_line();
            }
            b'\r' => self.pending_cr = Some(self.buf_raw.len()),
            _ => {}
        }
    }

    fn dcs_hook(
        &mut self,
        _byte: u8,
        _params: &[i64],
        _intermediates: &[u8],
        _ignored_excess_intermediates: bool,
    ) {
    }

    fn dcs_put(&mut self, _byte: u8) {}

    fn dcs_unhook(&mut self) {}

    fn esc_dispatch(
        &mut self,
        _params: &[i64],
        _intermediates: &[u8],
        _ignored_excess_intermediates: bool,
        _byte: u8,
    ) {
    }

    fn csi_dispatch(&mut self, params: &[CsiParam], _parameters_truncated: bool, byte: u8) {
        if byte == b'm' {
            let new_style = sgr::process(self.cursor_style, params);
            self.change_style(new_style);
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]]) {
        // OSC 8 hyperlinks: `8 ; params ; URI`. vtparse splits the payload on
        // every `;`, but a URI may itself contain them — everything past the
        // second separator is the URI, rejoined. The params field (id=, …) is
        // accepted and unused. All other OSC selectors are ignored.
        if params.first() != Some(&&b"8"[..]) {
            return;
        }
        // A well-formed OSC 8 is `8 ; params ; URI`; anything shorter (a
        // truncated `ESC]8;` or bare `ESC]8`) is treated as a close so a
        // degenerate sequence can't leave a link open over later lines.
        if params.len() < 3 {
            self.close_link_range(false);
            return;
        }
        let uri = params[2..].join(&b';');
        if uri.is_empty() {
            self.close_link_range(false);
            return;
        }
        match link_action_for_uri(&String::from_utf8_lossy(&uri)) {
            Some(link) => self.open_link(link),
            // Unsupported scheme: the text still displays, unlinked.
            None => self.close_link_range(false),
        }
    }

    fn apc_dispatch(&mut self, _data: Vec<u8>) {}
}

#[cfg(test)]
mod tests {
    use super::{AnsiColor, Color, MAX_OSC8_URI_LEN, VtProcessor, parse_link_tooltip_text};
    use crate::session::runtime::RuntimeAction;
    use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
    use vtparse::VTParser;

    struct Harness {
        parser: VTParser,
        processor: VtProcessor,
        rx: UnboundedReceiver<RuntimeAction>,
    }

    fn harness() -> Harness {
        let (tx, rx) = unbounded_channel();
        Harness {
            parser: VTParser::new(),
            processor: VtProcessor::new(tx),
            rx,
        }
    }

    impl Harness {
        /// Mirrors the connection's byte loop: raw bytes (minus CR/LF) are
        /// pushed before the parser sees each byte.
        fn feed(&mut self, bytes: &[u8]) {
            for &b in bytes {
                if b != b'\n' && b != b'\r' {
                    self.processor.push_raw_incoming_byte(b);
                }
                self.parser.parse_byte(b, &mut self.processor);
            }
        }

        fn actions(&mut self) -> Vec<RuntimeAction> {
            let mut out = Vec::new();
            while let Ok(action) = self.rx.try_recv() {
                out.push(action);
            }
            out
        }
    }

    /// The committed/partial line texts and where retractions fall between them.
    fn transcript(actions: &[RuntimeAction]) -> Vec<String> {
        actions
            .iter()
            .filter_map(|action| match action {
                RuntimeAction::HandleIncomingLine(line) => Some(format!("line:{}", line.text)),
                RuntimeAction::HandleIncomingPartialLine(line) => {
                    Some(format!("partial:{}", line.text))
                }
                RuntimeAction::RetractIncomingPartialLine => Some("retract".to_string()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn bare_cr_overprints_the_open_line() {
        let mut h = harness();
        h.feed(b"10%\r20%\r100%\n");
        assert_eq!(
            transcript(&h.actions()),
            ["retract", "retract", "line:100%"]
        );
    }

    #[test]
    fn crlf_commits_normally() {
        let mut h = harness();
        h.feed(b"a\r\nb\r\n");
        assert_eq!(transcript(&h.actions()), ["line:a", "line:b"]);
    }

    #[test]
    fn newline_then_cr_line_endings_commit_normally() {
        // Some servers terminate with \n\r; the stray \r restarts an empty
        // frame, which retracts nothing upstream and loses no text.
        let mut h = harness();
        h.feed(b"a\n\rb\n");
        let transcript = transcript(&h.actions());
        assert_eq!(transcript[0], "line:a");
        assert_eq!(transcript.last().unwrap(), "line:b");
    }

    #[test]
    fn cursor_style_survives_an_overprint() {
        let mut h = harness();
        h.feed(b"\x1b[31mold\rnew\n");
        let actions = h.actions();
        let line = actions
            .iter()
            .find_map(|action| match action {
                RuntimeAction::HandleIncomingLine(line) => Some(line.clone()),
                _ => None,
            })
            .expect("a committed line");
        assert_eq!(line.text, "new");
        assert!(
            line.spans.iter().all(|span| matches!(
                span.style.fg,
                Color::Ansi {
                    color: super::sgr::AnsiColor::Red,
                    bold: false
                }
            )),
            "the SGR set before the overprint must still color the new frame: {:?}",
            line.spans
        );
        assert_eq!(line.raw(), Some("new"));
    }

    #[test]
    fn raw_capture_rises_at_batch_boundaries_and_falls_at_line_boundaries() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let flag = Arc::new(AtomicBool::new(false));
        let mut h = harness();
        h.processor.set_raw_wanted_flag(flag.clone());

        // No raw trigger registered: the wire bytes are not copied.
        h.feed(b"\x1b[31mplain\x1b[0m\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].text, "plain");
        assert_eq!(lines[0].raw(), None);

        // The flag rises mid-batch: no line captures yet — the reader may be
        // mid-run with the push branch hoisted off, so a rise waits for the
        // batch boundary and every line stays complete-or-absent (absent).
        h.feed(b"mid");
        flag.store(true, Ordering::Relaxed);
        h.feed(b"line\n\x1b[32mnext\x1b[0m\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].raw(), None, "a rise never applies mid-batch");
        assert_eq!(lines[1].raw(), None, "a rise never applies mid-batch");

        // The batch boundary latches the rise; capture starts with the next batch.
        h.processor.notify_end_of_buffer();
        h.feed(b"\x1b[32mnow\x1b[0m\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].raw(), Some("\x1b[32mnow\x1b[0m"));

        // A drop applies at the next line boundary: the line in flight when
        // the flag fell was fully pushed, so it still captures (complete), and
        // the one after it does not.
        flag.store(false, Ordering::Relaxed);
        h.feed(b"latched\nafter\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].raw(), Some("latched"));
        assert_eq!(lines[1].raw(), None);
    }

    #[test]
    fn overprint_after_a_flushed_partial_retracts_it() {
        let mut h = harness();
        h.feed(b"10%");
        h.processor.notify_end_of_buffer();
        h.feed(b"\r20%\n");
        assert_eq!(
            transcript(&h.actions()),
            ["partial:10%", "retract", "line:20%"]
        );
    }

    #[test]
    fn prompt_boundary_clears_a_pending_cr() {
        let mut h = harness();
        h.feed(b"> \r");
        h.processor.commit_prompt();
        h.feed(b"ok\n");
        assert_eq!(transcript(&h.actions()), ["partial:> ", "line:ok"]);
    }

    use crate::session::styled_line::{
        LinkAction, LinkColor, LinkDecoration, LinkMenuItem, LinkTooltip, StyledLine,
    };

    fn committed_lines(actions: &[RuntimeAction]) -> Vec<std::sync::Arc<StyledLine>> {
        actions
            .iter()
            .filter_map(|action| match action {
                RuntimeAction::HandleIncomingLine(line) => Some(line.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn osc8_http_link_spans_the_enclosed_text() {
        let mut h = harness();
        h.feed(b"\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\ done\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].text, "click me done");
        assert_eq!(lines[0].links.len(), 1);
        assert_eq!(lines[0].links[0].begin_pos, 0);
        assert_eq!(lines[0].links[0].end_pos, "click me".len());
        assert_eq!(
            lines[0].links[0].action,
            LinkAction::OpenUrl(std::sync::Arc::from("https://example.com"))
        );
        assert_eq!(
            lines[0].links[0]
                .tooltip
                .as_ref()
                .and_then(LinkTooltip::display),
            Some((std::sync::Arc::from("https://example.com"), None))
        );
    }

    #[test]
    fn osc8_basic_style_parses_full_and_compact_properties() {
        let mut h = harness();
        h.feed(
            b"\x1b]8;;send:look?config=%7B%22s%22%3A%7B%22c%22%3A%22red%22%2C%22bg%22%3A%22%2301020380%22%2C%22b%22%3Afalse%2C%22i%22%3Atrue%2C%22u%22%3Afalse%2C%22o%22%3A%22dotted%22%2C%22st%22%3A%22wavy%22%2C%22tdc%22%3A%22blue%22%7D%7D\x1b\\styled\x1b]8;;\x1b\\\n",
        );
        let lines = committed_lines(&h.actions());
        let style = &lines[0].links[0]
            .style
            .as_ref()
            .expect("authored style")
            .base;
        assert_eq!(
            style.foreground,
            Some(LinkColor {
                red: 255,
                green: 0,
                blue: 0,
                alpha: 255,
            })
        );
        assert_eq!(
            style.background,
            Some(LinkColor {
                red: 1,
                green: 2,
                blue: 3,
                alpha: 128,
            })
        );
        assert_eq!(style.bold, Some(false));
        assert_eq!(style.italic, Some(true));
        assert_eq!(style.underline, Some(LinkDecoration::None));
        assert_eq!(style.overline, Some(LinkDecoration::Dotted));
        assert_eq!(style.strikethrough, Some(LinkDecoration::Wavy));
        assert_eq!(
            style.decoration_color,
            Some(LinkColor {
                red: 0,
                green: 0,
                blue: 255,
                alpha: 255,
            })
        );
    }

    #[test]
    fn osc8_empty_authored_style_is_retained() {
        let mut h = harness();
        h.feed(b"\x1b]8;;send:look?config=%7B%22style%22%3A%7B%7D%7D\x1b\\look\x1b]8;;\x1b\\\n");
        let lines = committed_lines(&h.actions());
        assert!(lines[0].links[0].style.is_some());
    }

    #[test]
    fn osc8_config_tooltip_strips_config_and_discloses_the_target() {
        let mut h = harness();
        h.feed(
            b"\x1b]8;;https://example.com/pay?x=1&config=%7B%22tooltip%22%3A%22Trusted%20checkout%22%7D#receipt\x1b\\pay\x1b]8;;\x1b\\\n",
        );
        let lines = committed_lines(&h.actions());
        let link = &lines[0].links[0];
        assert_eq!(
            link.action,
            LinkAction::OpenUrl(std::sync::Arc::from("https://example.com/pay?x=1#receipt"))
        );
        assert_eq!(
            link.tooltip.as_ref().and_then(LinkTooltip::display),
            Some((
                std::sync::Arc::from("Trusted checkout"),
                Some(std::sync::Arc::from("https://example.com/pay?x=1#receipt"))
            ))
        );
    }

    #[test]
    fn osc8_tooltip_preserves_json_lf_and_normalizes_crlf() {
        let cases = [
            (
                b"%7B%22tooltip%22%3A%22Line%20one%5CnLine%20two%22%7D".as_slice(),
                "Line one\nLine two",
            ),
            (
                b"%7B%22tooltip%22%3A%22Line%20one%5Cr%5CnLine%20two%22%7D".as_slice(),
                "Line one\nLine two",
            ),
        ];
        for (config, expected) in cases {
            let mut h = harness();
            let mut input = b"\x1b]8;;https://example.com/stats?config=".to_vec();
            input.extend_from_slice(config);
            input.extend_from_slice(b"\x1b\\stats\x1b]8;;\x1b\\\n");
            h.feed(&input);
            let lines = committed_lines(&h.actions());
            assert_eq!(
                lines[0].links[0]
                    .tooltip
                    .as_ref()
                    .and_then(LinkTooltip::display),
                Some((
                    std::sync::Arc::from(expected),
                    Some(std::sync::Arc::from("https://example.com/stats"))
                ))
            );
        }
    }

    #[test]
    fn tooltip_ansi_parser_keeps_sgr_spans_and_discards_active_controls() {
        let parsed =
            parse_link_tooltip_text("\x1b[38;2;255;128;0mEPIC\x1b[0m\nDamage: \x1b[1;31m42\x1b[0m")
                .expect("styled tooltip");
        assert_eq!(parsed.text.as_ref(), "EPIC\nDamage: 42");
        assert_eq!(
            &parsed.text[parsed.spans[0].begin_pos..parsed.spans[0].end_pos],
            "EPIC"
        );
        assert_eq!(
            parsed.spans[0].style.fg,
            Color::Rgb {
                r: 255,
                g: 128,
                b: 0
            }
        );
        assert!(parsed.spans.iter().any(|span| {
            &parsed.text[span.begin_pos..span.end_pos] == "42"
                && span.style.attributes.bold
                && span.style.fg
                    == Color::Ansi {
                        color: AnsiColor::Red,
                        bold: false,
                    }
        }));
        assert_eq!(parsed.spans.first().map(|span| span.begin_pos), Some(0));
        assert_eq!(
            parsed.spans.last().map(|span| span.end_pos),
            Some(parsed.text.len())
        );
        assert!(
            parsed
                .spans
                .windows(2)
                .all(|pair| pair[0].end_pos == pair[1].begin_pos)
        );

        let safe =
            parse_link_tooltip_text("safe\x1b]8;;https://example.com/hidden\x1b\\text\x1b[2J\0end")
                .expect("safe tooltip");
        assert_eq!(safe.text.as_ref(), "safetext end");
        assert!(!safe.text.contains('\x1b'));
    }

    #[test]
    fn osc8_compact_tooltip_key_is_supported() {
        let mut h = harness();
        h.feed(
            b"\x1b]8;;send:north?config=%7B%22t%22%3A%22Take%20the%20north%20exit%22%7D\x1b\\north\x1b]8;;\x1b\\\n",
        );
        let lines = committed_lines(&h.actions());
        let link = &lines[0].links[0];
        assert_eq!(
            link.action,
            LinkAction::ServerSend(std::sync::Arc::from("north"))
        );
        assert_eq!(
            link.tooltip.as_ref().and_then(LinkTooltip::display),
            Some((
                std::sync::Arc::from("Take the north exit"),
                Some(std::sync::Arc::from("send:north"))
            ))
        );
    }

    #[test]
    fn osc8_reserved_config_is_stripped_even_when_malformed() {
        let mut h = harness();
        h.feed(b"\x1b]8;;https://example.com/?x=1&config=not-json\x1b\\x\x1b]8;;\x1b\\\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(
            lines[0].links[0].action,
            LinkAction::OpenUrl(std::sync::Arc::from("https://example.com/?x=1"))
        );
    }

    #[test]
    fn osc8_percent_encoded_config_key_remains_part_of_web_url() {
        let mut h = harness();
        h.feed(b"\x1b]8;;https://example.com/?%63%6f%6e%66%69%67=value\x1b\\x\x1b]8;;\x1b\\\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(
            lines[0].links[0].action,
            LinkAction::OpenUrl(std::sync::Arc::from(
                "https://example.com/?%63%6f%6e%66%69%67=value"
            ))
        );
    }

    #[test]
    fn osc8_uri_may_contain_semicolons_and_bel_terminates() {
        let mut h = harness();
        h.feed(b"\x1b]8;;https://example.com/a;b=1\x07x\x1b]8;;\x07\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(
            lines[0].links[0].action,
            LinkAction::OpenUrl(std::sync::Arc::from("https://example.com/a;b=1"))
        );
    }

    #[test]
    fn osc8_link_continues_across_a_line_commit() {
        let mut h = harness();
        h.feed(b"\x1b]8;;https://example.com\x1b\\one\ntwo\x1b]8;;\x1b\\!\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].text, "one");
        assert_eq!(
            (lines[0].links[0].begin_pos, lines[0].links[0].end_pos),
            (0, 3)
        );
        assert_eq!(lines[1].text, "two!");
        assert_eq!(
            (lines[1].links[0].begin_pos, lines[1].links[0].end_pos),
            (0, 3),
            "the continuation restarts at column 0 and ends at the close"
        );
    }

    #[test]
    fn osc8_send_scheme_percent_decodes_into_server_send() {
        let mut h = harness();
        h.feed(b"\x1b]8;;send:say%20hello%2C%20world\x1b\\hi\x1b]8;;\x1b\\\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(
            lines[0].links[0].action,
            LinkAction::ServerSend(std::sync::Arc::from("say hello, world"))
        );
    }

    #[test]
    fn osc8_prompt_prefills_percent_decoded_text() {
        let mut h = harness();
        h.feed(b"\x1b]8;;prompt:cast%20fireball\x1b\\cast\x1b]8;;\x1b\\\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(
            lines[0].links[0].action,
            LinkAction::Prompt(std::sync::Arc::from("cast fireball"))
        );
    }

    #[test]
    fn osc8_compact_disabled_link_keeps_tooltip_but_has_no_primary_action() {
        let mut h = harness();
        h.feed(
            b"\x1b]8;;send:north?config=%7B%22d%22%3Atrue%2C%22t%22%3A%22Unavailable%22%7D\x1b\\north\x1b]8;;\x1b\\\n",
        );
        let lines = committed_lines(&h.actions());
        let link = &lines[0].links[0];
        assert!(link.action.primary().is_none());
        assert!(link.action.menu().is_none());
        assert!(!link.action.opens_menu_on_left_click());
        assert_eq!(
            link.tooltip.as_ref().and_then(LinkTooltip::display),
            Some((
                std::sync::Arc::from("Unavailable"),
                Some(std::sync::Arc::from("send:north"))
            ))
        );
    }

    #[test]
    fn osc8_compact_menu_supports_actions_separators_title_and_default_tooltip() {
        let mut h = harness();
        h.feed(
            b"\x1b]8;;send:look?config=%7B%22m%22%3A%5B%7B%22Look%22%3A%22send%3Alook%22%7D%2C%22-%22%2C%7B%22Cast%22%3A%22prompt%3Acast%2520fireball%22%7D%5D%2C%22ti%22%3A%22Actions%22%7D\x1b\\actions\x1b]8;;\x1b\\\n",
        );
        let lines = committed_lines(&h.actions());
        let link = &lines[0].links[0];
        let menu = link.action.menu().expect("an enabled menu");
        assert!(!link.action.opens_menu_on_left_click());
        assert_eq!(menu.title.as_deref(), Some("Actions"));
        assert_eq!(menu.items.len(), 3);
        assert!(matches!(menu.items[1], LinkMenuItem::Separator));
        assert!(matches!(
            &menu.items[2],
            LinkMenuItem::Action { label, action: LinkAction::Prompt(command) }
                if label.as_ref() == "Cast" && command.as_ref() == "cast fireball"
        ));
        assert_eq!(
            link.tooltip.as_ref().and_then(LinkTooltip::display),
            Some((
                std::sync::Arc::from("Right-click for menu"),
                Some(std::sync::Arc::from("send:look"))
            ))
        );
    }

    #[test]
    fn osc8_unsupported_schemes_render_plain_text() {
        let mut h = harness();
        h.feed(b"\x1b]8;;file:///etc/passwd\x1b\\name\x1b]8;;\x1b\\\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].text, "name");
        assert!(lines[0].links.is_empty());
    }

    #[test]
    fn osc8_oversized_uri_is_ignored() {
        let mut payload = b"\x1b]8;;https://example.com/".to_vec();
        payload.extend(std::iter::repeat_n(b'x', MAX_OSC8_URI_LEN));
        payload.extend_from_slice(b"\x1b\\text\x1b]8;;\x1b\\\n");
        let mut h = harness();
        h.feed(&payload);
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].text, "text");
        assert!(lines[0].links.is_empty());
    }

    #[test]
    fn osc8_uri_at_byte_cap_is_accepted() {
        const PREFIX: &[u8] = b"https://example.com/";
        let mut payload = b"\x1b]8;;".to_vec();
        payload.extend_from_slice(PREFIX);
        payload.extend(std::iter::repeat_n(b'x', MAX_OSC8_URI_LEN - PREFIX.len()));
        payload.extend_from_slice(b"\x1b\\text\x1b]8;;\x1b\\\n");
        let mut h = harness();
        h.feed(&payload);
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].text, "text");
        assert_eq!(lines[0].links.len(), 1);
    }

    #[test]
    fn osc8_multibyte_uri_does_not_panic() {
        // A URI of multibyte UTF-8 whose bytes straddle the scheme-prefix
        // lengths must not panic the scheme check; it is simply unlinked.
        let mut h = harness();
        h.feed("\x1b]8;;\u{e9}\u{e9}\u{e9}\u{e9}\x1b\\text\x1b]8;;\x1b\\\n".as_bytes());
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].text, "text");
        assert!(lines[0].links.is_empty());
    }

    #[test]
    fn osc8_link_survives_a_cr_overprint() {
        let mut h = harness();
        h.feed(b"\x1b]8;;https://example.com\x1b\\old\rnew\x1b]8;;\x1b\\\n");
        let lines = committed_lines(&h.actions());
        assert_eq!(lines[0].text, "new");
        assert_eq!(lines[0].links.len(), 1);
        assert_eq!(
            (lines[0].links[0].begin_pos, lines[0].links[0].end_pos),
            (0, 3)
        );
    }
}
