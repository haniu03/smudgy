const ANSI_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

export type AnsiColor =
  | string
  | { r: number; g: number; b: number }
  | { color: string; bold: boolean; paletteBright?: boolean };

export interface AnsiAttributes {
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: "none" | "single" | "double";
  blink: "none" | "slow" | "fast";
  crossedOut: boolean;
  reverse: boolean;
}

export interface AnsiStyleOptions {
  fg?: AnsiColor;
  bg?: AnsiColor;
  attributes?: AnsiAttributes;
}

export interface AnsiFragment {
  text: string;
  style: AnsiStyleOptions | null;
}

interface AnsiState {
  fg?: AnsiColor;
  bg?: AnsiColor;
  attributes: AnsiAttributes;
  active: boolean;
}

function defaultAttributes(): AnsiAttributes {
  return {
    bold: false,
    faint: false,
    italic: false,
    underline: "none",
    blink: "none",
    crossedOut: false,
    reverse: false,
  };
}

function reset(state: AnsiState): void {
  state.fg = "default";
  state.bg = "default";
  state.attributes = defaultAttributes();
  state.active = true;
}

function paletteColor(index: number): AnsiColor {
  if (index < 16) {
    return {
      color: ANSI_COLORS[index % 8],
      bold: false,
      paletteBright: index >= 8,
    };
  }
  if (index < 232) {
    const offset = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return {
      r: levels[Math.floor(offset / 36) % 6],
      g: levels[Math.floor(offset / 6) % 6],
      b: levels[offset % 6],
    };
  }
  const gray = 8 + Math.min(23, index - 232) * 10;
  return { r: gray, g: gray, b: gray };
}

function basicColor(code: number, base: number, bright: boolean): AnsiColor {
  return {
    color: ANSI_COLORS[code - base],
    bold: false,
    paletteBright: bright,
  };
}

function applyExtendedColor(
  state: AnsiState,
  params: readonly number[],
  at: number,
  target: "fg" | "bg",
): number {
  const mode = params[at + 1];
  if (mode === 2 && params.length >= at + 5) {
    state[target] = {
      r: Math.min(255, params[at + 2]),
      g: Math.min(255, params[at + 3]),
      b: Math.min(255, params[at + 4]),
    };
    return at + 4;
  }
  if (mode === 5 && params.length >= at + 3) {
    state[target] = paletteColor(Math.min(255, params[at + 2]));
    return at + 2;
  }
  return at;
}

function applySgr(state: AnsiState, rawParams: string): void {
  const params = rawParams === ""
    ? [0]
    : rawParams.split(";").map((part) => Number(part || 0));
  state.active = true;

  for (let at = 0; at < params.length; at += 1) {
    const code = params[at];
    if (code === 0) reset(state);
    else if (code === 1) state.attributes.bold = true;
    else if (code === 2) state.attributes.faint = true;
    else if (code === 3) state.attributes.italic = true;
    else if (code === 4) state.attributes.underline = "single";
    else if (code === 5) state.attributes.blink = "slow";
    else if (code === 6) state.attributes.blink = "fast";
    else if (code === 7) state.attributes.reverse = true;
    else if (code === 9) state.attributes.crossedOut = true;
    else if (code === 21) state.attributes.underline = "double";
    else if (code === 22) {
      state.attributes.bold = false;
      state.attributes.faint = false;
    } else if (code === 23) state.attributes.italic = false;
    else if (code === 24) state.attributes.underline = "none";
    else if (code === 25) state.attributes.blink = "none";
    else if (code === 27) state.attributes.reverse = false;
    else if (code === 29) state.attributes.crossedOut = false;
    else if (code >= 30 && code <= 37) state.fg = basicColor(code, 30, false);
    else if (code === 38) at = applyExtendedColor(state, params, at, "fg");
    else if (code === 39) state.fg = "default";
    else if (code >= 40 && code <= 47) state.bg = basicColor(code, 40, false);
    else if (code === 48) at = applyExtendedColor(state, params, at, "bg");
    else if (code === 49) state.bg = "default";
    else if (code >= 90 && code <= 97) state.fg = basicColor(code, 90, true);
    else if (code >= 100 && code <= 107) state.bg = basicColor(code, 100, true);
  }
}

function snapshot(state: AnsiState): AnsiStyleOptions | null {
  if (!state.active) return null;
  return {
    ...(state.fg === undefined ? {} : { fg: state.fg }),
    ...(state.bg === undefined ? {} : { bg: state.bg }),
    attributes: { ...state.attributes },
  };
}

/** Split a string into styled text fragments, consuming ANSI CSI controls. */
export function parseAnsiFragments(value: unknown): AnsiFragment[] {
  const text = String(value ?? "");
  // deno-lint-ignore no-control-regex
  const controls = /\x1b\[([0-9;:?]*)([ -/]*)?([@-~])/g;
  const state: AnsiState = { attributes: defaultAttributes(), active: false };
  const fragments: AnsiFragment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = controls.exec(text))) {
    if (match.index > cursor) {
      fragments.push({ text: text.slice(cursor, match.index), style: snapshot(state) });
    }
    if (match[3] === "m") applySgr(state, match[1]);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    fragments.push({ text: text.slice(cursor), style: snapshot(state) });
  }
  return fragments;
}
