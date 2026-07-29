// TinTin++ pattern compiler, ported from tools/tt2smudgy: compiles TinTin's
// intermediate pattern language (%1..%99 slots, typed wildcards, embedded
// {PCRE}, %i/%I case modes, leading ~ raw matching) to Rust-regex-compatible
// source, with an explicit slot -> capture-group map. PCRE2-only constructs
// are detected and reported so a definition can be rejected with a readable
// error instead of a Rust regex parse failure.
//
// Pure module, no smudgy imports.

import { readBalanced } from "./text.ts";

function escapeRegexLiteral(ch: string): string {
  return /[\\.^$|?*+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

export type VariableLookup = Map<string, unknown> | Record<string, unknown> | ((name: string) => unknown);

function lookupOf(variables: VariableLookup | undefined): (name: string) => unknown {
  if (typeof variables === "function") return variables;
  if (variables instanceof Map) return (name) => variables.get(name);
  return (name) => (variables as Record<string, unknown> | undefined)?.[name];
}

/** Expand `$var`/`${var}` seeds in a pattern from definition-time variables. */
export function expandSeedVariables(pattern: string, variables: VariableLookup | undefined, warnings: string[]): string {
  const lookup = lookupOf(variables);
  let value = pattern;
  const seen = new Set<string>();
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    value = value.replace(/\$\{([^}]+)\}|\$([A-Za-z][A-Za-z0-9_]*)/g, (whole, braced, plain) => {
      const name = braced ?? plain;
      const replacement = lookup(name);
      if (replacement === undefined) return whole;
      if (seen.has(name) && String(replacement).includes(`$${name}`)) {
        warnings.push(`variable ${JSON.stringify(name)} recursively references itself in the pattern`);
        return whole;
      }
      seen.add(name);
      changed = true;
      return String(replacement);
    });
    if (!changed) break;
  }
  return value;
}

function capturingGroupCount(source: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") { i += 1; continue; }
    if (source[i] === "[") { inClass = true; continue; }
    if (source[i] === "]") { inClass = false; continue; }
    if (inClass || source[i] !== "(") continue;
    if (source[i + 1] !== "?") count += 1;
    else if (/^\?<(?![=!])/.test(source.slice(i + 1)) || /^\?P</.test(source.slice(i + 1))) count += 1;
  }
  return count;
}

function pcreCompatibility(source: string): string[] {
  const found: string[] = [];
  // TinTin wraps each {...} fragment in a capture group before handing it to
  // PCRE2, so shorthand such as {?!text} becomes the lookahead (?!text).
  const wrapped = `(${source})`;
  const checks: Array<[RegExp, string]> = [
    [/\(\?(?:[=!]|<[=!])/, "lookaround"],
    [/\\[1-9][0-9]*|\\k[<{']|\\g[<{']|\(\?P=/, "backreference"],
    [/\(\?>/, "atomic group"],
    [/\(\?\(/, "conditional group"],
    [/\(\?(?:R|0|&|P>)/, "recursive/subroutine call"],
    [/\(\?\|/, "branch-reset group"],
    [/\(\*/, "PCRE control verb"],
    [/(?:\+\+|\*\+|\?\+|\{\d+(?:,\d*)?\}\+)/, "possessive quantifier"],
    [/\\[CKRX]|\\[hHvVG]/, "PCRE-only escape"],
    [/\\Q|\\E/, "quoted-literal escape"],
    [/\(\?#/, "inline regex comment"],
    [/\(\?'[^']+'/, "PCRE named-group spelling"],
  ];
  for (const [pattern, label] of checks) if (pattern.test(wrapped)) found.push(label);
  return [...new Set(found)];
}

function normalizeEmbeddedPcre(source: string): string {
  let output = "";
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "\\" || i + 1 >= source.length) {
      output += source[i];
      continue;
    }
    const next = source[i + 1];
    if (next === "\\") {
      output += "\\\\";
      i += 1;
    } else if (next === "e") {
      output += "\\x1b";
      i += 1;
    } else if (next === "Z") {
      output += "\\z";
      i += 1;
    } else {
      output += `\\${next}`;
      i += 1;
    }
  }
  return output;
}

function typedAtom(kind: string, warnings: string[]): string | null {
  switch (kind) {
    case "a": return "[^\\x00]";
    case "A": return "\\n";
    case "c": return "(?:\\x1b\\[[0-9;]*m)";
    case "d": return "[0-9]";
    case "D": return "[^0-9]";
    case "p":
      warnings.push("%p's TinTin byte range is approximated with Unicode code points U+0020 through U+00FE");
      return "[\\x20-\\x{00FE}]";
    case "P":
      warnings.push("%P's TinTin byte range is approximated with Unicode code points outside U+0020 through U+00FE");
      return "[^\\x20-\\x{00FE}]";
    case "s": return "[\\r\\n\\t ]";
    case "S": return "[^\\r\\n\\t ]";
    case "u":
      warnings.push("%u is approximated as one Unicode scalar because smudgy patterns do not match encoded UTF-8 bytes");
      return "(?s:.)";
    case "U":
      warnings.push("%U matches invalid UTF-8 bytes in TinTin++ and has no smudgy string equivalent");
      return "(?-u:\\b\\B)";
    case "w": return "[A-Za-z0-9_]";
    case "W": return "[^A-Za-z0-9_]";
    case "?": case ".": case "*": return ".";
    default: return null;
  }
}

function rangeToken(text: string, start: number, warnings: string[]): { expression: string; end: number } {
  let i = start;
  let minimum = "";
  while (/\d/.test(text[i] ?? "")) minimum += text[i++];
  let maximum: string | null = null;
  if (text.slice(i, i + 2) === "..") {
    i += 2;
    maximum = "";
    while (/\d/.test(text[i] ?? "")) maximum += text[i++];
  }
  const kind = text[i] ?? "";
  const atom = typedAtom(kind, warnings);
  if (!atom) return { expression: ".+", end: start };
  i += 1;
  if (!minimum && maximum === null) return { expression: `${atom}+`, end: i };
  const min = minimum || "0";
  const quantifier = maximum === null ? `{${min}}` : `{${min},${maximum}}`;
  return { expression: `${atom}${quantifier}`, end: i };
}

export interface CompiledPattern {
  /** Rust-regex-compatible source. */
  source: string;
  /** Whether the pattern had a leading `~` (raw/color matching). */
  raw: boolean;
  /** The pattern after seed-variable expansion. */
  expanded: string;
  /** TinTin slot number (as a string key) -> capture group number. */
  captureMap: Record<string, number>;
  /** Total capture groups in `source`. */
  groups: number;
  /** Literal `{?!text}` lookaheads to enforce as runtime guards. */
  negativeLiterals: string[];
  unsupported: boolean;
  unsupportedFeatures: string[];
  warnings: string[];
}

/**
 * Compile TinTin++'s intermediate pattern language to smudgy/Rust regex
 * source. Unsupported PCRE2-only features are retained in `source` but
 * explicitly flagged so the caller can reject the definition with a readable
 * error.
 */
export function compileTinTinPattern(pattern: unknown, { variables }: { variables?: VariableLookup } = {}): CompiledPattern {
  const warnings: string[] = [];
  const unsupportedFeatures: string[] = [];
  const negativeLiterals: string[] = [];
  let expanded = expandSeedVariables(String(pattern ?? ""), variables, warnings);
  let raw = false;
  if (expanded.startsWith("~")) {
    raw = true;
    expanded = expanded.slice(1);
  }

  let source = "";
  let i = 0;
  let groups = 0;
  let nextSlot = 1;
  const captureMap: Record<string, number> = {};

  const mapCapture = (slot: number) => {
    groups += 1;
    captureMap[String(slot)] = groups;
    nextSlot = Math.min(99, Number(slot) + 1);
  };
  const mapAutomaticCapture = () => {
    const slot = nextSlot;
    mapCapture(slot);
    return slot;
  };
  const addCapture = (expression: string, slot: number | null = null) => {
    if (slot === null) mapAutomaticCapture(); else mapCapture(slot);
    source += `(${expression})`;
  };

  while (expanded[i] === "^") { source += "^"; i += 1; }
  while (i < expanded.length) {
    const ch = expanded[i];
    const finalAfter = (end: number) => end >= expanded.length;

    if (ch === "\\") {
      const next = expanded[i + 1];
      if (next === undefined) { source += "\\z"; i += 1; continue; }
      if (next === "e") source += "\\x1b";
      else if (next === "%") source += "%";
      else if (next === "Z") source += "\\z";
      else if (next === "b" || next === "B") source += `(?-u:\\${next})`;
      else if (next === "d") source += "[0-9]";
      else if (next === "D") source += "[^0-9]";
      else if (next === "s") source += "[\\r\\n\\t ]";
      else if (next === "S") source += "[^\\r\\n\\t ]";
      else if (next === "w") source += "[A-Za-z0-9_]";
      else if (next === "W") source += "[^A-Za-z0-9_]";
      else source += `\\${next}`;
      if (/[CKRXhHvVG]/.test(next)) unsupportedFeatures.push(`PCRE-only escape \\${next}`);
      i += 2;
      continue;
    }

    if (ch === "{") {
      const group = readBalanced(expanded, i);
      const negativeLiteral = /^\?!([A-Za-z0-9 _'",:;.!-]+)$/.exec(group.value);
      if (negativeLiteral) {
        negativeLiterals.push(negativeLiteral[1]);
        warnings.push(`negative literal lookahead is enforced as a runtime guard: ${JSON.stringify(negativeLiteral[1])}`);
        i = group.end;
        continue;
      }
      const incompatibilities = pcreCompatibility(group.value);
      unsupportedFeatures.push(...incompatibilities);
      if (!group.closed) warnings.push("unterminated embedded PCRE group");
      mapAutomaticCapture();
      const innerGroups = capturingGroupCount(group.value);
      source += `(${normalizeEmbeddedPcre(group.value)})`;
      for (let n = 0; n < innerGroups; n++) mapAutomaticCapture();
      i = group.end;
      continue;
    }

    if (ch === "$" && i === expanded.length - 1) { source += "$"; i += 1; continue; }
    if (ch === "$" || ch === "^") { source += `\\${ch}`; i += 1; continue; }

    if (ch !== "%") {
      source += escapeRegexLiteral(ch);
      i += 1;
      continue;
    }

    const code = expanded[i + 1] ?? "";
    if (/\d/.test(code)) {
      let digits = code;
      if (/\d/.test(expanded[i + 2] ?? "")) digits += expanded[i + 2];
      const end = i + 1 + digits.length;
      addCapture(finalAfter(end) ? ".*" : ".*?", Number(digits));
      i = end;
      continue;
    }
    if (code === "%") { source += "%"; i += 2; continue; }
    if (code === "i" || code === "I") {
      source += code === "i" ? "(?i)" : "(?-i)";
      i += 2;
      continue;
    }

    let suppressed = false;
    let token = code;
    let tokenStart = i + 2;
    if (code === "!") {
      suppressed = true;
      token = expanded[i + 2] ?? "";
      tokenStart = i + 3;
    }

    if (suppressed && token === "{") {
      const group = readBalanced(expanded, i + 2);
      unsupportedFeatures.push(...pcreCompatibility(group.value));
      source += normalizeEmbeddedPcre(group.value);
      groups += capturingGroupCount(group.value);
      if (!group.closed) warnings.push("unterminated suppressed embedded PCRE group");
      i = group.end;
      continue;
    }

    if (token === "+") {
      const range = rangeToken(expanded, tokenStart, warnings);
      const end = range.end === tokenStart ? tokenStart : range.end;
      const expression = `${range.expression}${finalAfter(end) ? "" : "?"}`;
      if (suppressed) source += expression;
      else addCapture(expression);
      i = end;
      continue;
    }

    const atom = typedAtom(token, warnings);
    if (atom) {
      const end = suppressed ? i + 3 : i + 2;
      let expression: string;
      if (token === ".") expression = atom;
      else if (token === "?") expression = `${atom}?${finalAfter(end) ? "" : "?"}`;
      else expression = `${atom}*${finalAfter(end) ? "" : "?"}`;
      if (suppressed) source += expression;
      else addCapture(expression);
      i = end;
      continue;
    }

    source += "%";
    i += 1;
  }

  const uniqueUnsupported = [...new Set(unsupportedFeatures)];
  if (uniqueUnsupported.length) {
    warnings.push(`smudgy's Rust regex engine does not support: ${uniqueUnsupported.join(", ")}`);
  }
  return {
    source: source || "(?:)",
    raw,
    expanded,
    captureMap,
    groups,
    negativeLiterals,
    unsupported: uniqueUnsupported.length > 0,
    unsupportedFeatures: uniqueUnsupported,
    warnings,
  };
}

/**
 * A compiled pattern as JavaScript regex source and flags, when the Rust
 * source has no Rust-only syntax; `null` otherwise. Used for expression-level
 * pattern matching (`#if {$x == "{pat}"}`), which runs in JS rather than the
 * client's trigger engine.
 */
export function jsRegexSource(compiled: CompiledPattern): { source: string; flags: string } | null {
  let source = compiled.source;
  let flags = "";
  if (source.includes("(?i)")) {
    source = source.replaceAll("(?i)", "");
    flags += "i";
  }
  // A bare inline flag group is a JS syntax error; a leftover (?-i) after the
  // strip above means mixed case modes, which JS cannot express either way.
  if (source.includes("(?-i)")) return null;
  if (/\(\?-u:/.test(source) || /\\x\{/.test(source)) return null;
  // \z is end-of-text in Rust regex but a literal "z" in JavaScript.
  let backslashRun = 0;
  for (const ch of source) {
    if (ch === "\\") { backslashRun += 1; continue; }
    if (ch === "z" && backslashRun % 2 === 1) return null;
    backslashRun = 0;
  }
  source = source.replaceAll("(?P<", "(?<");
  try {
    new RegExp(source, flags);
  } catch {
    return null;
  }
  return { source, flags };
}
