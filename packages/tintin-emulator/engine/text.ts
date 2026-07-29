// TinTin++ text semantics shared by the pattern compiler, the interpolator,
// and the dispatcher: brace-aware item splitting, output escapes, variable
// path selectors, and the <088>-style color codes. Color handling produces
// plain `{ fg, bg }` data in the shapes smudgy's styling APIs accept, which
// keeps this file free of smudgy imports.

/** Read a balanced `{...}` group starting at `start` (which must be a `{`). */
export function readBalanced(text: string, start: number): { value: string; end: number; closed: boolean } {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return { value: text.slice(start + 1, i), end: i + 1, closed: true };
    }
  }
  return { value: text.slice(start + 1), end: text.length, closed: false };
}

const TINTIN_OUTPUT_ESCAPES = new Map<string, string>([
  ["a", "\x07"],
  ["e", "\x1b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
]);

/**
 * Decode documented TinTin control escapes in text that is about to be sent or
 * displayed. Kept separate from stored values: those may intentionally contain
 * regexes, paths, or a literal backslash for a later consumer.
 */
export function decodeTinTinOutputEscapes(value: string): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "\\" || index + 1 >= value.length) {
      output += value[index++];
      continue;
    }

    const code = value[index + 1];
    const mapped = TINTIN_OUTPUT_ESCAPES.get(code);
    if (mapped !== undefined) {
      output += mapped;
      index += 2;
      continue;
    }
    if (code === "\\" || code === ";") {
      output += code;
      index += 2;
      continue;
    }
    if (code === "c" && /[A-Za-z]/.test(value[index + 2] ?? "")) {
      output += String.fromCharCode(value[index + 2].toUpperCase().charCodeAt(0) & 31);
      index += 3;
      continue;
    }
    if (code === "x") {
      const digits = value.slice(index + 2, index + 4);
      if (/^[0-9A-Fa-f]{2}$/.test(digits)) {
        output += String.fromCodePoint(Number.parseInt(digits, 16));
        index += 4;
        continue;
      }
    }
    if (code === "u" && value[index + 2] === "{") {
      const close = value.indexOf("}", index + 3);
      const digits = close < 0 ? "" : value.slice(index + 3, close);
      const point = /^[0-9A-Fa-f]{1,6}$/.test(digits) ? Number.parseInt(digits, 16) : -1;
      if (point >= 0 && point <= 0x10FFFF) {
        output += String.fromCodePoint(point);
        index = close + 1;
        continue;
      }
    }
    if (code === "u" || code === "U") {
      const width = code === "u" ? 4 : 6;
      const digits = value.slice(index + 2, index + 2 + width);
      const point = digits.length === width && /^[0-9A-Fa-f]+$/.test(digits)
        ? Number.parseInt(digits, 16)
        : -1;
      if (point >= 0 && point <= 0x10FFFF) {
        output += String.fromCodePoint(point);
        index += 2 + width;
        continue;
      }
    }

    // Unknown escapes are retained for a later consumer rather than guessed here.
    output += `\\${code}`;
    index += 2;
  }
  return output;
}

/**
 * Split a TinTin list/body value into items: `{a}{b}` yields the braced items,
 * otherwise `separator` splits at depth zero outside quotes.
 */
export function splitTinTinItems(value: unknown, separator = ";"): string[] {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === "\\" && index + 1 < text.length) {
      current += ch + text[++index];
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{") {
      if (depth++ > 0) current += ch;
      continue;
    }
    if (ch === "}" && depth > 0) {
      if (--depth > 0) current += ch;
      else {
        items.push(current.trim());
        current = "";
      }
      continue;
    }
    if (depth === 0 && ch === separator) {
      if (current.trim()) items.push(current.trim());
      current = "";
      continue;
    }
    if (depth === 0 && /\s/.test(ch) && !current) continue;
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/** Split `name[sel][sel]` into `[name, sel, sel]`, tolerating `$`/`{}` wrapping. */
export function variablePath(value: unknown): string[] {
  const text = String(value ?? "").trim();
  const firstBracket = text.indexOf("[");
  const name = (firstBracket < 0 ? text : text.slice(0, firstBracket)).replace(/^\$?\{?|\}?$/g, "");
  const selectors: string[] = [];
  let index = firstBracket;
  while (index >= 0 && index < text.length && text[index] === "[") {
    let end = index + 1;
    let depth = 1;
    while (end < text.length && depth > 0) {
      if (text[end] === "[") depth += 1;
      else if (text[end] === "]") depth -= 1;
      if (depth > 0) end += 1;
    }
    selectors.push(text.slice(index + 1, end));
    index = text.indexOf("[", end + 1);
  }
  return [name, ...selectors];
}

/**
 * A TinTin value literal as a JavaScript value: numbers stay numeric, and an
 * even run of braced fields (`{k}{v}{k}{v}`) becomes a nested record the way
 * TinTin tables do. Everything else stays a string.
 */
export function staticTinTinValue(value: unknown): unknown {
  const raw = String(value ?? "").trim();
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const fields = raw.startsWith("{") ? splitTinTinItems(raw) : [];
  if (fields.length >= 2 && fields.length % 2 === 0) {
    const object: Record<string, unknown> = {};
    for (let index = 0; index < fields.length; index += 2) {
      object[fields[index]] = staticTinTinValue(fields[index + 1]);
    }
    return object;
  }
  return raw;
}

// ---- Line occurrence scanning ----------------------------------------------

/** UTF-8 byte length of `text` (smudgy line edit offsets are byte-based). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const point = ch.codePointAt(0) as number;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Byte-offset ranges of every non-overlapping occurrence of `needle` in
 * `text`, left to right. Offsets are UTF-8 byte offsets in the shape the
 * line editing `*At` APIs take.
 */
export function occurrenceByteRanges(text: string, needle: string): Array<{ begin: number; end: number }> {
  if (!needle) return [];
  const needleBytes = utf8Length(needle);
  const ranges: Array<{ begin: number; end: number }> = [];
  let from = 0;
  let base = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, from)) {
    const begin = base + utf8Length(text.slice(from, at));
    ranges.push({ begin, end: begin + needleBytes });
    from = at + needle.length;
    base = begin + needleBytes;
  }
  return ranges;
}

// ---- TinTin color codes ----------------------------------------------------

export const ANSI_COLORS: readonly string[] = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const XTERM_CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function sixLevel(channel: string): number {
  return XTERM_CUBE_LEVELS[channel.charCodeAt(0) - 97];
}

type NeutralColor =
  | { ansi: string }
  | { rgb: { r: number; g: number; b: number } }
  | { theme: "default" };

export interface ColorState {
  foreground: NeutralColor | null;
  background: NeutralColor | null;
  bold: boolean;
}

export function newColorState(): ColorState {
  return { foreground: null, background: null, bold: false };
}

/** A color in the plain shapes smudgy's `Color` accepts. */
export type ColorValue = string | { r: number; g: number; b: number } | { color: string; bold: boolean };

/** Foreground/background pair in the shape of smudgy's `LineColorOptions`. */
export interface StyleOptions {
  fg?: ColorValue;
  bg?: ColorValue;
}

/**
 * Apply one TinTin color code (the text inside `<...>`) to `state`. Returns
 * `false` when the code is not a recognized color, in which case the caller
 * keeps it as plain text.
 */
export function applyTinTinColor(state: ColorState, code: string, warn?: (message: string) => void): boolean {
  if (/^[a-f]{3}$/.test(code)) {
    const [r, g, b] = [...code].map(sixLevel);
    state.foreground = { rgb: { r, g, b } };
    state.bold = false;
    return true;
  }
  if (/^[A-F]{3}$/.test(code)) {
    const [r, g, b] = [...code.toLowerCase()].map(sixLevel);
    state.background = { rgb: { r, g, b } };
    return true;
  }
  if (/^[gG](?:[01]\d|2[0-3])$/.test(code)) {
    const level = Number(code.slice(1));
    const value = level === 0 ? 8 : 8 + level * 10;
    const rgb = { r: value, g: value, b: value };
    if (code[0] === "g") {
      state.foreground = { rgb };
      state.bold = false;
    } else state.background = { rgb };
    return true;
  }
  if (/^[FfBb][0-9A-Fa-f]{3}$/.test(code)) {
    const parts = [...code.slice(1)].map((digit) => Number.parseInt(digit, 16) * 17);
    const rgb = { r: parts[0], g: parts[1], b: parts[2] };
    if (code[0].toUpperCase() === "F") state.foreground = { rgb };
    else state.background = { rgb };
    return true;
  }
  if (/^[FfBb][0-9A-Fa-f]{6}$/.test(code)) {
    const parts = [1, 3, 5].map((at) => Number.parseInt(code.slice(at, at + 2), 16));
    const rgb = { r: parts[0], g: parts[1], b: parts[2] };
    if (code[0].toUpperCase() === "F") state.foreground = { rgb };
    else state.background = { rgb };
    return true;
  }
  if (code === "900") {
    // In substitutions this restores the source line's style. An unset smudgy
    // fragment inherits that same style at the replacement point.
    state.foreground = null;
    state.background = null;
    state.bold = false;
    return true;
  }
  if (/^\d{3}$/.test(code)) {
    const attribute = Number(code[0]);
    if (attribute === 0) {
      state.foreground = { theme: "default" };
      state.background = { theme: "default" };
      state.bold = false;
    } else if (attribute === 1) state.bold = true;
    else if (attribute === 2) state.bold = false;
    else if (attribute !== 8) {
      warn?.(`TinTin text attribute ${attribute} in <${code}> is not supported; colors were retained`);
    }
    const foreground = Number(code[1]);
    const background = Number(code[2]);
    if (foreground < 8) state.foreground = { ansi: ANSI_COLORS[foreground] };
    else if (foreground === 9) state.foreground = { theme: "default" };
    if (background < 8) state.background = { ansi: ANSI_COLORS[background] };
    else if (background === 9) state.background = { theme: "default" };
    return true;
  }
  return false;
}

function foregroundValue(color: NeutralColor, bold: boolean): ColorValue {
  if ("ansi" in color) return { color: color.ansi, bold };
  if ("rgb" in color) return color.rgb;
  return "default";
}

function backgroundValue(color: NeutralColor): ColorValue {
  if ("ansi" in color) return color.ansi;
  if ("rgb" in color) return color.rgb;
  return "default";
}

/** The state's colors as `{ fg, bg }` options; `null` when nothing is set. */
export function colorOptions(state: ColorState): StyleOptions | null {
  const options: StyleOptions = {};
  if (state.foreground) options.fg = foregroundValue(state.foreground, state.bold);
  if (state.background) options.bg = backgroundValue(state.background);
  return options.fg || options.bg ? options : null;
}

export interface StyledFragment {
  text: string;
  style: StyleOptions | null;
}

const COLOR_CODE_PATTERN = /<([0-9A-Fa-fgG]{3,7})>/g;

/**
 * Split text containing TinTin `<...>` color codes into styled fragments.
 * Unrecognized codes stay literal text with a warning, matching tt2smudgy.
 */
export function parseStyledFragments(value: unknown, warn?: (message: string) => void): StyledFragment[] {
  const text = String(value ?? "");
  const pattern = new RegExp(COLOR_CODE_PATTERN.source, "g");
  const state = newColorState();
  const fragments: StyledFragment[] = [];
  let current: StyleOptions | null = null;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      fragments.push({ text: text.slice(cursor, match.index), style: current });
    }
    if (applyTinTinColor(state, match[1], warn)) {
      current = colorOptions(state);
    } else {
      warn?.(`TinTin color code <${match[1]}> was kept as plain text`);
      fragments.push({ text: match[0], style: current });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) fragments.push({ text: text.slice(cursor), style: current });
  return fragments;
}

/**
 * A `#highlight` color argument as `{ fg, bg }` options: either a run of
 * `<...>` codes, or TinTin color words (`bold red on blue`). Unsupported
 * attributes are dropped with a warning, colors retained.
 */
export function highlightStyleOptions(value: unknown, warn: (message: string) => void): StyleOptions {
  const text = String(value ?? "");
  const colorCodes = [...text.matchAll(new RegExp(COLOR_CODE_PATTERN.source, "g"))];
  if (colorCodes.length && text.replace(new RegExp(COLOR_CODE_PATTERN.source, "g"), "").trim() === "") {
    const state = newColorState();
    if (colorCodes.every((match) => applyTinTinColor(state, match[1], warn))) {
      return colorOptions(state) ?? {};
    }
  }
  const tokens = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const unsupported = tokens.filter((token) => ["blink", "underscore", "underline", "italic", "reverse"].includes(token));
  if (unsupported.length) warn(`highlight attributes ${unsupported.join(", ")} are not supported; colors were retained`);
  const on = tokens.indexOf("on");
  const foregroundTokens = on >= 0 ? tokens.slice(0, on) : tokens;
  const backgroundTokens = on >= 0 ? tokens.slice(on + 1) : [];
  const foreground = foregroundTokens.find((token) => ANSI_COLORS.includes(token));
  const background = backgroundTokens.find((token) => ANSI_COLORS.includes(token));
  const bright = foregroundTokens.some((token) => token === "bold" || token === "light" || token === "bright");
  const dim = foregroundTokens.some((token) => token === "dim" || token === "dark");
  if (!foreground && !background) {
    warn(`highlight color ${JSON.stringify(text)} was not recognized; default styling was used`);
    return {};
  }
  const options: StyleOptions = {};
  if (foreground) options.fg = { color: foreground, bold: bright && !dim };
  if (background) options.bg = background;
  return options;
}
