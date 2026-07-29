// Echo helpers: TinTin-voiced status and error messages, and the styled
// rendering path shared by #showme and #substitute (TinTin <088> color codes
// -> smudgy styled text, then interpolation and output escapes per fragment).

import { echo, style } from "smudgy:core";
import type { StyledText } from "smudgy:core";
import { parseStyledFragments, decodeTinTinOutputEscapes } from "../engine/text.ts";
import type { StyledFragment } from "../engine/text.ts";
import { interpolate } from "../engine/eval.ts";
import type { Env } from "../engine/eval.ts";

function templateArray(strings: string[]): TemplateStringsArray {
  return Object.assign([...strings], { raw: [...strings] }) as unknown as TemplateStringsArray;
}

/** Compose styled fragments into a single echo-able value. */
export function composeFragments(fragments: StyledFragment[]): string | StyledText {
  if (!fragments.some((fragment) => fragment.style)) {
    return fragments.map((fragment) => fragment.text).join("");
  }
  const values = fragments.map((fragment) => fragment.style
    ? (style(fragment.style)(templateArray([fragment.text])))
    : fragment.text);
  const strings = new Array(values.length + 1).fill("");
  return style(templateArray(strings), ...values);
}

/**
 * Render TinTin output text: color codes split first, then each fragment is
 * interpolated and its control escapes decoded, matching tt2smudgy's order.
 */
export function renderOutput(text: unknown, env: Env): string | StyledText {
  const fragments = parseStyledFragments(text, env.warn).map((fragment) => ({
    ...fragment,
    text: decodeTinTinOutputEscapes(interpolate(fragment.text, env)),
  }));
  if (!fragments.length) return "";
  return composeFragments(fragments);
}

/**
 * Render text whose interpolation has already happened: color codes and
 * output escapes only. Re-running interpolation here would resolve sigils
 * that appear inside the user's own data.
 */
export function renderPlain(text: unknown, warn: (message: string) => void): string | StyledText {
  const fragments = parseStyledFragments(text, warn).map((fragment) => ({
    ...fragment,
    text: decodeTinTinOutputEscapes(fragment.text),
  }));
  if (!fragments.length) return "";
  return composeFragments(fragments);
}

/** A TinTin-voiced confirmation, e.g. `#OK. {gt} IS NOW AN ALIAS.` */
export function echoOk(message: string): void {
  echo(style.echo`${message}`);
}

/** A TinTin-voiced error, e.g. `#ERROR: #UNKNOWN COMMAND.` */
export function echoError(message: string): void {
  echo(style.warn`${message}`);
}

/** A quieter advisory (pattern warnings, approximation notes). */
export function echoNote(message: string): void {
  echo(style.warn`#NOTE: ${message}`);
}

/** A warning sink that echoes each distinct message once per execution. */
export function makeWarnSink(): (message: string) => void {
  const seen = new Set<string>();
  return (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    echoNote(message);
  };
}
