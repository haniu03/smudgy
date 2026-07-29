// Runtime interpolation and expression evaluation for TinTin++ command
// bodies: $var/${var}/&var/*var with [selector] chains, %N capture slots,
// @fn{} calls, and the #math/#if expression language (TinTin's precedence
// table, dice rolls, and pattern-matching equality). These are direct
// evaluators modeled on tt2smudgy's compilers, which emit TypeScript source
// for the same semantics.
//
// The host supplies the Env; nothing here imports smudgy.

import { readBalanced, splitTinTinItems } from "./text.ts";
import { compileTinTinPattern, jsRegexSource } from "./pattern.ts";

/** The world a TinTin body executes against. */
export interface Env {
  /** `$name` lookup (locals shadow vars). `undefined` when absent. */
  getVar(path: string[]): unknown;
  setVar(path: string[], value: unknown): void;
  hasVar(path: string[]): boolean;
  deleteVar(path: string[]): void;
  /** `&name` — element count of a table/list, 0 when absent. */
  sizeVar(path: string[]): number;
  /** `*name` — the key(s) at a path, as TinTin renders them. */
  keyVar(path: string[]): string;
  /** `%N` capture/argument slot. `undefined` when the slot has no source. */
  slot(n: number): string | undefined;
  /** `&N` regex capture slot (set by #replace/#regexp). */
  regexSlot?(n: number): string | undefined;
  /** `@fn{args}` user-function call. `undefined` when the name is unknown. */
  callFunction?(name: string, args: string[]): unknown;
  warn(message: string): void;
}

/** A value rendered the way TinTin prints it: tables as `{k}{v}` runs. */
export function stringifyTinTin(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(Number(value));
  if (Array.isArray(value)) return value.map((item) => `{${stringifyTinTin(item)}}`).join("");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `{${key}}{${stringifyTinTin(item)}}`)
      .join("");
  }
  return String(value);
}

/** TinTin truthiness: numbers by value, other text by non-emptiness. */
export function tinTinTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const number = Number(value);
  return Number.isNaN(number) ? String(value ?? "").length > 0 : number !== 0;
}

function isNumericText(value: unknown): boolean {
  return typeof value === "number" || /^\s*-?\d+(?:\.\d+)?\s*$/.test(String(value ?? ""));
}

/** TinTin equality: numeric when both sides are numbers, textual otherwise. */
export function tinTinEqual(left: unknown, right: unknown): boolean {
  if (isNumericText(left) && isNumericText(right)) return Number(left) === Number(right);
  return String(left ?? "") === String(right ?? "");
}

/** TinTin ordering: numeric when both sides are numbers, strcmp otherwise. */
export function tinTinCompare(left: unknown, right: unknown): number {
  if (isNumericText(left) && isNumericText(right)) {
    const difference = Number(left) - Number(right);
    return difference < 0 ? -1 : difference > 0 ? 1 : 0;
  }
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve a `name[sel][sel]` chain that may itself interpolate, into the
 * final path segments.
 */
function resolveSelectors(name: string, selectors: string[], env: Env): string[] {
  return [name, ...selectors.map((selector) =>
    /[$@%&*]/.test(selector) ? interpolate(selector, env) : selector)];
}

/**
 * Expand a TinTin body/argument text: `%N` slots, `$var`/`&var`/`*var` with
 * selector chains, `@fn{...}` calls, `%%` and `@@` escapes. Unresolvable
 * references stay literal with a warning, matching tt2smudgy.
 */
export function interpolate(text: unknown, env: Env): string {
  const value = String(text ?? "");
  let output = "";
  for (let index = 0; index < value.length;) {
    if (value[index] === "\\" && value[index + 1] === ";") {
      // The lexer keeps `\;` so it survives command splitting; it reads back
      // as a plain semicolon everywhere downstream.
      output += ";";
      index += 2;
      continue;
    }
    if (value[index] === "%" && /\d/.test(value[index + 1] ?? "")) {
      let end = index + 2;
      if (/\d/.test(value[end] ?? "")) end += 1;
      const slot = Number(value.slice(index + 1, end));
      const resolved = env.slot(slot);
      if (resolved === undefined) {
        output += value.slice(index, end);
        env.warn(`%${slot} has no corresponding capture here; kept literal`);
      } else {
        output += resolved;
      }
      index = end;
      continue;
    }
    if (value[index] === "%" && value[index + 1] === "%") {
      output += "%";
      index += 2;
      continue;
    }
    if (value[index] === "&" && /\d/.test(value[index + 1] ?? "")) {
      // TinTin's #replace/#regexp expose their captures as &0..&99, distinct
      // from the %N slots of the automation whose body is running.
      let end = index + 2;
      if (/\d/.test(value[end] ?? "")) end += 1;
      const slot = Number(value.slice(index + 1, end));
      const resolved = env.regexSlot?.(slot);
      if (resolved === undefined) {
        output += value.slice(index, end);
        env.warn(`&${slot} has no regex capture here; kept literal`);
      } else {
        output += resolved;
      }
      index = end;
      continue;
    }
    if (["$", "&", "*"].includes(value[index]) &&
      (/[A-Za-z_]/.test(value[index + 1] ?? "") || value[index + 1] === "{")) {
      const sigil = value[index];
      let end = index + 1;
      let name: string;
      if (value[end] === "{") {
        const group = readBalanced(value, end);
        name = group.value;
        end = group.end;
      } else {
        const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(end));
        name = match![0];
        end += match![0].length;
      }
      const selectors: string[] = [];
      while (value[end] === "[") {
        // Selector chains nest; reuse the brace reader over a bracket-mapped
        // copy (same length, so positions line up).
        const group = readBalanced(value.replaceAll("[", "{").replaceAll("]", "}"), end);
        selectors.push(group.value);
        end = group.end;
      }
      const path = resolveSelectors(
        /[$@%&*]/.test(name) ? interpolate(name, env) : name,
        selectors,
        env,
      );
      if (sigil === "$") output += stringifyTinTin(env.getVar(path));
      else if (sigil === "&") output += String(env.sizeVar(path));
      else output += env.keyVar(path);
      index = end;
      continue;
    }
    if (value[index] === "@" && value[index + 1] === "@") {
      output += "@";
      index += 2;
      continue;
    }
    if (value[index] === "@" && /[A-Za-z_]/.test(value[index + 1] ?? "")) {
      const match = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(value.slice(index))!;
      const name = match[1];
      const end = index + match[0].length;
      if (value[end] === "{") {
        const group = readBalanced(value, end);
        const call = env.callFunction?.(
          name,
          splitTinTinItems(group.value, ";").map((argument) => interpolate(argument, env)),
        );
        if (call === undefined) {
          output += value.slice(index, group.end);
          env.warn(`@${name} is not a defined function; kept literal`);
        } else {
          output += stringifyTinTin(call);
        }
        index = group.end;
        continue;
      }
      output += match[0];
      index = end;
      continue;
    }
    output += value[index];
    index += 1;
  }
  return output;
}

// ---- Expressions -----------------------------------------------------------

function findExpressionOperator(text: string, operators: string[]): { start: number; operator: string } | null {
  let braces = 0;
  let parens = 0;
  let quote = "";
  for (let index = text.length - 1; index >= 0; index--) {
    const ch = text[index];
    if (ch === "\\") { index -= 1; continue; }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "}") { braces += 1; continue; }
    if (ch === "{") { braces -= 1; continue; }
    if (ch === ")") { parens += 1; continue; }
    if (ch === "(") { parens -= 1; continue; }
    if (braces || parens) continue;
    for (const operator of operators) {
      const start = index - operator.length + 1;
      if (start >= 0 && text.slice(start, index + 1) === operator) return { start, operator };
    }
  }
  return null;
}

function hasOuterExpressionParens(text: string): boolean {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === "\\") { index += 1; continue; }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")" && --depth === 0 && index !== text.length - 1) return false;
  }
  return depth === 0;
}

function tinTinDice(count: number, sides: number): number {
  const rolls = Math.max(0, Math.floor(count));
  const die = Math.max(1, Math.floor(sides));
  let total = 0;
  for (let n = 0; n < rolls; n++) total += 1 + Math.floor(Math.random() * die);
  return total;
}

/** A quoted/braced right-hand side usable as a match pattern, or `null`. */
function quotedPatternOf(text: string): string | null {
  const trimmed = text.trim();
  const quoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"));
  if (!quoted) return null;
  const inner = trimmed.slice(1, -1);
  return /[$@&]|%\d{1,2}|\*[A-Za-z_{]/.test(inner) ? null : inner;
}

// TinTin's expression precedence, loosest first; each level splits at its
// rightmost operator, so operators associate left.
const PRECEDENCE: string[][] = [
  ["||"], ["^^"], ["&&"], ["|"], ["^"], ["&"],
  ["===", "!==", "==", "!="], [">=", "<=", ">", "<"],
  ["<<", ">>", ".."], ["+", "-"], ["**"], ["//", "*", "/", "%"],
];

/**
 * Evaluate a TinTin `#math`/`#if` expression. Follows TinTin's precedence
 * table, with `d` dice rolls, `//` roots, and quoted-pattern equality
 * (`$name == "{pat}"` matches, not compares).
 */
export function evalExpression(value: unknown, env: Env): unknown {
  const evaluate = (raw: unknown): unknown => {
    const text = String(raw ?? "").trim();
    if (!text) return 0;
    if (hasOuterExpressionParens(text)) return evaluate(text.slice(1, -1));
    if (text.startsWith("!") && !text.startsWith("!=")) {
      return !tinTinTruthy(evaluate(text.slice(1)));
    }
    if (text.startsWith("~")) {
      return ~Number(evaluate(text.slice(1)));
    }

    for (const operators of PRECEDENCE) {
      const found = findExpressionOperator(text, operators);
      if (!found || found.start <= 0 || found.start + found.operator.length >= text.length) continue;
      const leftText = text.slice(0, found.start);
      const rightText = text.slice(found.start + found.operator.length);
      const operator = found.operator;

      if (operator === "&&") {
        return tinTinTruthy(evaluate(leftText)) && tinTinTruthy(evaluate(rightText));
      }
      if (operator === "||") {
        return tinTinTruthy(evaluate(leftText)) || tinTinTruthy(evaluate(rightText));
      }
      if (operator === "^^") {
        return tinTinTruthy(evaluate(leftText)) !== tinTinTruthy(evaluate(rightText));
      }
      if (operator === "==" || operator === "!=") {
        const left = evaluate(leftText);
        const quotedPattern = quotedPatternOf(rightText);
        let matched: boolean;
        const compiled = quotedPattern === null ? null : compileTinTinPattern(quotedPattern);
        const jsPattern = compiled && !compiled.unsupported ? jsRegexSource(compiled) : null;
        if (jsPattern) {
          // TinTin string equality is a fully anchored match (\A...\Z).
          try {
            matched = new RegExp(`^(?:${jsPattern.source})$`, jsPattern.flags).test(String(left ?? ""));
          } catch {
            matched = tinTinEqual(left, evaluate(rightText));
          }
        } else {
          matched = tinTinEqual(left, evaluate(rightText));
        }
        return operator === "==" ? matched : !matched;
      }
      if (operator === "===" || operator === "!==") {
        const same = String(evaluate(leftText) ?? "") === String(evaluate(rightText) ?? "");
        return operator === "===" ? same : !same;
      }
      if ([">", ">=", "<", "<="].includes(operator)) {
        const ordering = tinTinCompare(evaluate(leftText), evaluate(rightText));
        if (operator === ">") return ordering > 0;
        if (operator === ">=") return ordering >= 0;
        if (operator === "<") return ordering < 0;
        return ordering <= 0;
      }
      const left = Number(evaluate(leftText));
      const right = Number(evaluate(rightText));
      switch (operator) {
        case "&": return left & right;
        case "|": return left | right;
        case "^": return left ^ right;
        case "<<": return left << right;
        case ">>": return left >> right;
        case "..":
          // TinTin packs a range into one number: (min+1e8)*1e9 + (max+1e8).
          return (left + 100000000) * 1000000000 + (right + 100000000);
        case "+": return left + right;
        case "-": return left - right;
        case "**": return left ** right;
        case "//": return Math.pow(left, 1 / right);
        case "*": return left * right;
        case "/": return left / right;
        case "%": return left % right;
      }
    }

    const dice = /^([0-9$({].*?)\s*d\s*([0-9$({].*)$/i.exec(text);
    if (dice) {
      return tinTinDice(Number(evaluate(dice[1])), Number(evaluate(dice[2])));
    }
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
    if (/^true$/i.test(text)) return 1;
    if (/^false$/i.test(text)) return 0;
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith("{") && text.endsWith("}"))) {
      return interpolate(text.slice(1, -1), env);
    }
    return interpolate(text, env);
  };

  return evaluate(value);
}

/** Evaluate an expression and reduce it to TinTin truthiness. */
export function evalCondition(value: unknown, env: Env): boolean {
  return tinTinTruthy(evalExpression(value, env));
}

/** Evaluate a `#math` result: numbers stay numbers, booleans become 1/0. */
export function evalMath(value: unknown, env: Env): unknown {
  const result = evalExpression(value, env);
  if (typeof result === "boolean") return result ? 1 : 0;
  return result;
}
