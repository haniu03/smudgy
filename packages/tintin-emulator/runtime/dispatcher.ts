// Executes parsed TinTin nodes: plain text is sent to the MUD, definition
// commands create native automations, immediate commands run on the spot.
// TinTin's brace rule governs interpolation: pattern and body arguments pass
// through raw (patterns seed-expand at compile, bodies interpolate when they
// fire); value arguments interpolate at execution.
//
// Control flow (#break, #continue, #return) threads a Signal up through
// executeNodes; loops consume break/continue, and definition bodies swallow
// whatever escapes.

import { echo, send, vars, style, getSessions, byName } from "smudgy:core";
import { nodeArgumentText, bodyFor, parseTinTin, formatDiagnostic, discoverFileCommandChar } from "../engine/parse.ts";
import type { TinTinNode, CommandNode } from "../engine/parse.ts";
import {
  decodeTinTinOutputEscapes, variablePath, staticTinTinValue, splitTinTinItems,
} from "../engine/text.ts";
import {
  interpolate, evalCondition, evalExpression, evalMath, stringifyTinTin, tinTinEqual, tinTinCompare,
} from "../engine/eval.ts";
import { formatTinTin, tinTinListOption } from "../engine/format.ts";
import { compileTinTinPattern, jsRegexSource } from "../engine/pattern.ts";
import type { ExecutionEnv } from "./env.ts";
import { echoOk, echoError, echoNote, renderOutput, renderPlain } from "./output.ts";
import {
  defineAlias, removeAlias, defineAction, removeAction, defineGag, removeGag,
  defineHighlight, removeHighlight, defineSubstitute, removeSubstitute,
  defineTicker, removeTicker, defineDelay, removeDelay,
  defineFunction, removeFunction, defineMacro, removeMacro, defineEvent, removeEvent,
  definePrompt, removePrompt, getPathDirs, setPathDir, removePathDir,
  classKill, classSize, getCurrentClass, setCurrentClass,
  resolveIgnoreKind, toggleIgnore, ignoreStates,
  getStored, setExecutor, tinTinPriority, makeExecutionEnv, STORE_KEY,
} from "./definitions.ts";
import type { Signal } from "./definitions.ts";
import { beginRead, endRead, writeDataFile } from "./files.ts";
import { openSplit, closeSplit, splitEcho } from "./panes.ts";
import {
  pathCreate, pathDestroy, pathStart, pathStop, pathState,
  pathInsert, pathDelete, pathUndo, pathRun, pathUnzip, pathSave,
} from "./paths.ts";

const MAX_DEPTH = 50;
const MAX_WHILE_ITERATIONS = 100000;

/** Commands this build implements. */
const SUPPORTED = new Set([
  "alias", "unalias", "action", "unaction", "gag", "ungag",
  "highlight", "unhighlight", "substitute", "unsubstitute",
  "variable", "unvariable", "local", "unlocal", "math",
  "showme", "echo", "send", "nop", "cr",
  "if", "elseif", "else", "switch", "case", "default",
  "loop", "foreach", "while", "parse", "break", "continue", "return",
  "function", "unfunction", "format", "replace", "regexp", "cat", "list",
  "macro", "unmacro", "event", "unevent", "class", "ignore", "info",
  "delay", "undelay", "ticker", "unticker",
  "read", "write", "split", "unsplit", "prompt", "unprompt",
  "path", "pathdir", "unpathdir", "all", "session", "bell",
  "help", "commands",
]);

/** Commands that would need sandbox-escape or network permissions. */
const DECLINED = new Map<string, string>([
  ["system", "smudgy packages are sandboxed; there is no shell access"],
  ["run", "smudgy packages are sandboxed; there is no shell access"],
  ["script", "smudgy packages are sandboxed; write a smudgy script instead"],
  ["port", "smudgy runs sessions side by side; #all or #<session> {command} replaces port links"],
  ["chat", "smudgy packages cannot open sockets"],
  ["ssl", "connections are managed in smudgy's connection settings"],
  ["daemon", "smudgy has no detach/attach model"],
  ["textin", "use #read to load a command file from the package data directory"],
]);

const PATH_OPTIONS = [
  "create", "delete", "describe", "destroy", "end", "insert", "new",
  "run", "save", "start", "stop", "undo", "unzip", "zip",
];

const CLASS_OPTIONS = ["assign", "clear", "close", "kill", "open", "size"];

let activeCommandChar = "#";
export function setDispatcherCommandChar(commandChar: string): void {
  activeCommandChar = commandChar;
}

function cc(name: string): string {
  return `${activeCommandChar}${name}`;
}

/** `#delay` with three arguments is the named form unless the first is a bare number. */
function isNamedDelay(node: CommandNode): boolean {
  if (node.args.length !== 3) return false;
  if (node.args.every((argument) => argument.braced)) return true;
  return !/^-?\d+(?:\.\d+)?$/.test(node.args[0].value.trim());
}

/**
 * Run `fn` with the `&N` regex capture slots replaced; the `%N` slots of the
 * enclosing automation stay untouched (TinTin keeps the two families apart).
 */
function withRegexSlots<T>(env: ExecutionEnv, slots: Record<number, string>, run: () => T): T {
  const saved = { ...env.regexSlots };
  const clear = () => {
    for (const key of Object.keys(env.regexSlots)) delete env.regexSlots[Number(key)];
  };
  clear();
  Object.assign(env.regexSlots, slots);
  try {
    return run();
  } finally {
    clear();
    Object.assign(env.regexSlots, saved);
  }
}

function compileRuntimePattern(env: ExecutionEnv, patternText: string): { regex: RegExp; captureMap: Record<string, number> } | null {
  const compiled = compileTinTinPattern(patternText, { variables: (name) => env.getVar([name]) });
  const js = compiled.unsupported ? null : jsRegexSource(compiled);
  if (!js) {
    echoError(`#ERROR: {${patternText}} cannot run here (${compiled.unsupported ? compiled.unsupportedFeatures.join(", ") : "Rust-only pattern syntax"}).`);
    return null;
  }
  return { regex: new RegExp(js.source, js.flags), captureMap: compiled.captureMap };
}

function matchSlots(captureMap: Record<string, number>, match: RegExpExecArray | RegExpMatchArray): Record<number, string> {
  const slots: Record<number, string> = { 0: match[0] ?? "" };
  for (const [slot, group] of Object.entries(captureMap)) {
    slots[Number(slot)] = match[group] ?? "";
  }
  return slots;
}

function listDefinitions(kind: string, entries: Record<string, object>, render: (def: never) => string): void {
  const values = Object.values(entries);
  if (!values.length) {
    echoNote(`no ${kind}s are defined`);
    return;
  }
  for (const def of values) echo(render(def as never));
}

/** Track an `#if`/`#elseif`/`#else` chain across sibling nodes. */
type ChainState = "none" | "matched" | "unmatched";

export function executeNodes(nodes: TinTinNode[], env: ExecutionEnv, depth = 0): Signal {
  if (depth > MAX_DEPTH) {
    echoError(`#ERROR: command nesting exceeded ${MAX_DEPTH} levels; execution stopped.`);
    return null;
  }
  let chain: ChainState = "none";

  for (const node of nodes) {
    if (node.kind === "comment") continue;

    if (node.kind === "send") {
      chain = "none";
      try {
        send(decodeTinTinOutputEscapes(interpolate(node.text, env)));
      } catch (error) {
        echoError(`#ERROR: send failed: ${error instanceof Error ? error.message : String(error)}.`);
      }
      continue;
    }

    const name = node.name;
    if (name === "if") {
      const condition = evalCondition(node.args[0]?.value ?? "", env);
      const elseBody = bodyFor(node, 2);
      let signal: Signal = null;
      if (condition) {
        signal = executeNodes(bodyFor(node, 1), env, depth + 1);
        chain = "matched";
      } else if (elseBody.length || node.args[2]) {
        signal = executeNodes(elseBody, env, depth + 1);
        chain = "matched";
      } else {
        chain = "unmatched";
      }
      if (signal) return signal;
      continue;
    }
    if (name === "elseif") {
      if (chain === "none") {
        echoError(`#ERROR: ${cc("elseif")} without a preceding ${cc("if")}.`);
      } else if (chain === "unmatched" && evalCondition(node.args[0]?.value ?? "", env)) {
        const signal = executeNodes(bodyFor(node, 1), env, depth + 1);
        chain = "matched";
        if (signal) return signal;
      }
      continue;
    }
    if (name === "else") {
      if (chain === "none") {
        echoError(`#ERROR: ${cc("else")} without a preceding ${cc("if")}.`);
      } else if (chain === "unmatched") {
        const signal = executeNodes(bodyFor(node, 0), env, depth + 1);
        chain = "none";
        if (signal) return signal;
        continue;
      }
      chain = "none";
      continue;
    }
    chain = "none";

    // One bad command must not abort the rest of a body or a #read file; a
    // throw becomes a TinTin-style error and execution moves on.
    let signal: Signal = null;
    try {
      signal = executeCommand(node, env, depth);
    } catch (error) {
      echoError(`#ERROR: ${cc(node.name)} failed: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (signal) return signal;
  }
  return null;
}
setExecutor(executeNodes);

function executeCommand(node: CommandNode, env: ExecutionEnv, depth: number): Signal {
  const name = node.name;
  // TinTin echoes confirmations for typed commands but stays quiet inside
  // running bodies, roughly its interactive/verbose distinction.
  const quiet = depth > 0;
  const arg = (index: number) => node.args[index]?.value ?? "";
  const argText = (index: number) => nodeArgumentText(node, index);

  switch (name) {
    case "nop":
      return null;
    case "cr":
      send("");
      return null;
    case "send":
      send(decodeTinTinOutputEscapes(interpolate(argText(0), env)));
      return null;
    case "showme": {
      const rendered = renderOutput(argText(0), env);
      // A BRACED text plus a numeric row routes into the #split pane. Row
      // numbers select the pane, not a position; smudgy panes append.
      // Unbraced text takes the whole tail, so a trailing number there is
      // part of the message, not a row.
      const rowText = node.args[0]?.braced && node.args[1] ? interpolate(arg(1), env).trim() : "";
      if (/^\d+$/.test(rowText) && splitEcho(rendered)) return null;
      echo(rendered);
      return null;
    }
    case "echo": {
      // #echo {format} {args...}: a #format render straight to the screen.
      // Formatting already interpolated everything, so the result renders
      // colors and escapes only; running it back through interpolation would
      // resolve sigils inside the user's data.
      if (node.args.length > 1) {
        const formatted = formatTinTin(
          interpolate(arg(0), env),
          node.args.slice(1).map((item) => interpolate(item.value, env)),
          env.warn,
        );
        echo(renderPlain(formatted, env.warn));
      } else {
        echo(renderOutput(argText(0), env));
      }
      return null;
    }

    // ---- Control flow ------------------------------------------------------

    case "break":
      return { kind: "break" };
    case "continue":
      return { kind: "continue" };
    case "return":
      return { kind: "return", value: interpolate(argText(0), env) };
    case "case":
    case "default":
      echoError(`#ERROR: ${cc(name)} outside ${cc("switch")}.`);
      return null;

    case "loop": {
      const from = Number(evalExpression(arg(0), env));
      const to = Number(evalExpression(arg(1), env));
      const variable = interpolate(arg(2), env);
      if (!Number.isFinite(from) || !Number.isFinite(to) || !variable) {
        echoError(`#ERROR: ${cc("loop")} needs numeric bounds and a variable name.`);
        return null;
      }
      const step = from <= to ? 1 : -1;
      for (let value = from; step > 0 ? value <= to : value >= to; value += step) {
        env.setLocal([variable], value);
        const signal = executeNodes(bodyFor(node, 3), env, depth + 1);
        if (signal?.kind === "break") break;
        if (signal?.kind === "return") return signal;
      }
      return null;
    }
    case "foreach": {
      const items = splitTinTinItems(interpolate(arg(0), env));
      const variable = interpolate(arg(1), env);
      if (!variable) {
        echoError(`#ERROR: ${cc("foreach")} needs a variable name.`);
        return null;
      }
      for (const item of items) {
        env.setLocal([variable], item);
        const signal = executeNodes(bodyFor(node, 2), env, depth + 1);
        if (signal?.kind === "break") break;
        if (signal?.kind === "return") return signal;
      }
      return null;
    }
    case "while": {
      let iterations = 0;
      while (evalCondition(arg(0), env)) {
        if (++iterations > MAX_WHILE_ITERATIONS) {
          echoError(`#ERROR: ${cc("while")} exceeded ${MAX_WHILE_ITERATIONS} iterations; stopped.`);
          break;
        }
        const signal = executeNodes(bodyFor(node, 1), env, depth + 1);
        if (signal?.kind === "break") break;
        if (signal?.kind === "return") return signal;
      }
      return null;
    }
    case "parse": {
      const text = interpolate(arg(0), env);
      const variable = interpolate(arg(1), env);
      if (!variable) {
        echoError(`#ERROR: ${cc("parse")} needs a variable name.`);
        return null;
      }
      for (const ch of text) {
        env.setLocal([variable], ch);
        const signal = executeNodes(bodyFor(node, 2), env, depth + 1);
        if (signal?.kind === "break") break;
        if (signal?.kind === "return") return signal;
      }
      return null;
    }
    case "switch": {
      const value = evalExpression(arg(0), env);
      let defaultNode: CommandNode | null = null;
      for (const child of bodyFor(node, 1)) {
        if (child.kind !== "statement" && child.kind !== "command") continue;
        if (child.name === "default") {
          defaultNode = child;
          continue;
        }
        if (child.name !== "case") {
          env.warn(`only ${cc("case")}/${cc("default")} belong in ${cc("switch")}; ignored ${cc(child.name)}`);
          continue;
        }
        if (tinTinEqual(value, evalExpression(child.args[0]?.value ?? "", env))) {
          const signal = executeNodes(bodyFor(child, 1), env, depth + 1);
          // TinTin cases do not fall through; #break just exits the switch.
          return signal?.kind === "break" ? null : signal;
        }
      }
      if (defaultNode) {
        const signal = executeNodes(bodyFor(defaultNode, 0), env, depth + 1);
        return signal?.kind === "break" ? null : signal;
      }
      return null;
    }

    // ---- Variables and text ------------------------------------------------

    case "variable": {
      if (!node.args.length) {
        const entries = Object.entries(vars as Record<string, unknown>)
          .filter(([key]) => key !== STORE_KEY);
        if (!entries.length) echoNote("no variables are defined");
        for (const [key, value] of entries) {
          echo(`${cc("variable")} {${key}} {${stringifyTinTin(value)}}`);
        }
        return null;
      }
      const path = variablePath(interpolate(arg(0), env));
      if (!node.args[1]) {
        if (!env.hasVar(path)) {
          echoError(`#ERROR: {${path.join("][")}} IS NOT A VARIABLE.`);
        } else {
          echo(`${cc("variable")} {${path.join("][")}} {${stringifyTinTin(env.getVar(path))}}`);
        }
        return null;
      }
      env.setVar(path, staticTinTinValue(interpolate(argText(1), env)));
      if (!quiet) echoOk(`#OK. {${path[0]}} IS NOW SET.`);
      return null;
    }
    case "unvariable": {
      const path = variablePath(interpolate(arg(0), env));
      env.deleteVar(path);
      if (!quiet) echoOk(`#OK. {${path[0]}} IS NO LONGER A VARIABLE.`);
      return null;
    }
    case "local": {
      const path = variablePath(interpolate(arg(0), env));
      env.setLocal(path, staticTinTinValue(interpolate(argText(1), env)));
      return null;
    }
    case "unlocal": {
      env.deleteLocal(variablePath(interpolate(arg(0), env)));
      return null;
    }
    case "math": {
      const path = variablePath(interpolate(arg(0), env));
      const result = evalMath(argText(1), env);
      if (typeof result === "number" && !Number.isFinite(result)) {
        // The vars store is JSON-backed; Infinity/NaN would silently null out.
        echoError(`#ERROR: ${cc("math")} result is not a finite number.`);
        return null;
      }
      env.setVar(path, result);
      return null;
    }
    case "cat": {
      const path = variablePath(interpolate(arg(0), env));
      const current = env.hasVar(path) ? stringifyTinTin(env.getVar(path)) : "";
      env.setVar(path, current + interpolate(argText(1), env));
      return null;
    }
    case "format": {
      const path = variablePath(interpolate(arg(0), env));
      const formatted = formatTinTin(
        interpolate(arg(1), env),
        node.args.slice(2).map((item) => interpolate(item.value, env)),
        env.warn,
      );
      env.setVar(path, formatted);
      return null;
    }
    case "replace": {
      const path = variablePath(interpolate(arg(0), env));
      const pattern = compileRuntimePattern(env, arg(1));
      if (!pattern) return null;
      const searcher = new RegExp(pattern.regex.source, `${pattern.regex.flags}g`);
      const current = stringifyTinTin(env.getVar(path) ?? "");
      let output = "";
      let last = 0;
      for (const match of current.matchAll(searcher)) {
        const at = match.index ?? 0;
        output += current.slice(last, at);
        output += withRegexSlots(env, matchSlots(pattern.captureMap, match), () => interpolate(argText(2), env));
        last = at + match[0].length;
        if (match[0] === "") break;
      }
      output += current.slice(last);
      env.setVar(path, output);
      return null;
    }
    case "regexp": {
      const subject = interpolate(arg(0), env);
      const pattern = compileRuntimePattern(env, arg(1));
      if (!pattern) return null;
      const match = pattern.regex.exec(subject);
      if (match) {
        return withRegexSlots(env, matchSlots(pattern.captureMap, match), () =>
          executeNodes(bodyFor(node, 2), env, depth + 1));
      }
      return executeNodes(bodyFor(node, 3), env, depth + 1);
    }
    case "list":
      executeList(node, env);
      return null;

    // ---- Definitions -------------------------------------------------------

    case "alias": {
      if (!node.args.length) {
        listDefinitions("alias", getStored().aliases, (def: { pattern: string; commands: string; priority: number }) =>
          `${cc("alias")} {${def.pattern}} {${def.commands}} {${def.priority}}`);
        return null;
      }
      if (!node.args[1]) {
        const def = getStored().aliases[arg(0)];
        if (def) echo(`${cc("alias")} {${def.pattern}} {${def.commands}} {${def.priority}}`);
        else echoError(`#ERROR: {${arg(0)}} IS NOT AN ALIAS.`);
        return null;
      }
      // The commands argument takes the unbraced remainder (TinTin GET_ALL);
      // a priority is only reachable when the commands are braced.
      defineAlias(arg(0), argText(1), node.args[1]?.braced ? tinTinPriority(node.args[2]?.value) : tinTinPriority(undefined), quiet);
      return null;
    }
    case "unalias": {
      if (removeAlias(argText(0))) {
        if (!quiet) echoOk(`#OK. {${argText(0)}} IS NO LONGER AN ALIAS.`);
      } else echoError(`#ERROR: {${argText(0)}} IS NOT AN ALIAS.`);
      return null;
    }

    case "action": {
      if (!node.args.length) {
        listDefinitions("action", getStored().actions, (def: { pattern: string; commands: string; priority: number }) =>
          `${cc("action")} {${def.pattern}} {${def.commands}} {${def.priority}}`);
        return null;
      }
      if (!node.args[1]) {
        const def = getStored().actions[arg(0)];
        if (def) echo(`${cc("action")} {${def.pattern}} {${def.commands}} {${def.priority}}`);
        else echoError(`#ERROR: {${arg(0)}} IS NOT AN ACTION.`);
        return null;
      }
      defineAction(arg(0), argText(1), node.args[1]?.braced ? tinTinPriority(node.args[2]?.value) : tinTinPriority(undefined), quiet);
      return null;
    }
    case "unaction": {
      if (removeAction(argText(0))) {
        if (!quiet) echoOk(`#OK. {${argText(0)}} IS NO LONGER AN ACTION.`);
      } else echoError(`#ERROR: {${argText(0)}} IS NOT AN ACTION.`);
      return null;
    }

    case "gag": {
      if (!node.args.length) {
        listDefinitions("gag", getStored().gags, (def: { pattern: string }) => `${cc("gag")} {${def.pattern}}`);
        return null;
      }
      defineGag(argText(0), quiet);
      return null;
    }
    case "ungag": {
      if (removeGag(argText(0))) {
        if (!quiet) echoOk(`#OK. {${argText(0)}} IS NO LONGER A GAG.`);
      } else echoError(`#ERROR: {${argText(0)}} IS NOT A GAG.`);
      return null;
    }

    case "highlight": {
      if (!node.args.length) {
        listDefinitions("highlight", getStored().highlights, (def: { pattern: string; color: string }) =>
          `${cc("highlight")} {${def.pattern}} {${def.color}}`);
        return null;
      }
      defineHighlight(arg(0), argText(1), quiet);
      return null;
    }
    case "unhighlight": {
      if (removeHighlight(argText(0))) {
        if (!quiet) echoOk(`#OK. {${argText(0)}} IS NO LONGER A HIGHLIGHT.`);
      } else echoError(`#ERROR: {${argText(0)}} IS NOT A HIGHLIGHT.`);
      return null;
    }

    case "substitute": {
      if (!node.args.length) {
        listDefinitions("substitute", getStored().substitutes, (def: { pattern: string; replacement: string }) =>
          `${cc("substitute")} {${def.pattern}} {${def.replacement}}`);
        return null;
      }
      defineSubstitute(arg(0), argText(1), quiet);
      return null;
    }
    case "unsubstitute": {
      if (removeSubstitute(argText(0))) {
        if (!quiet) echoOk(`#OK. {${argText(0)}} IS NO LONGER A SUBSTITUTE.`);
      } else echoError(`#ERROR: {${argText(0)}} IS NOT A SUBSTITUTE.`);
      return null;
    }

    case "function": {
      if (!node.args.length) {
        listDefinitions("function", getStored().functions, (def: { name: string; commands: string }) =>
          `${cc("function")} {${def.name}} {${def.commands}}`);
        return null;
      }
      if (!node.args[1]) {
        const def = getStored().functions[arg(0).trim().toLowerCase()];
        if (def) echo(`${cc("function")} {${def.name}} {${def.commands}}`);
        else echoError(`#ERROR: {${arg(0)}} IS NOT A FUNCTION.`);
        return null;
      }
      defineFunction(arg(0), argText(1), quiet);
      return null;
    }
    case "unfunction": {
      if (removeFunction(argText(0))) {
        if (!quiet) echoOk(`#OK. {${arg(0)}} IS NO LONGER A FUNCTION.`);
      } else echoError(`#ERROR: {${arg(0)}} IS NOT A FUNCTION.`);
      return null;
    }

    case "macro": {
      if (!node.args.length) {
        listDefinitions("macro", getStored().macros, (def: { key: string; commands: string }) =>
          `${cc("macro")} {${def.key}} {${def.commands}}`);
        return null;
      }
      defineMacro(arg(0), argText(1), quiet);
      return null;
    }
    case "unmacro": {
      if (removeMacro(argText(0))) {
        if (!quiet) echoOk(`#OK. {${arg(0)}} IS NO LONGER A MACRO.`);
      } else echoError(`#ERROR: {${arg(0)}} IS NOT A MACRO.`);
      return null;
    }

    case "event": {
      if (!node.args.length) {
        listDefinitions("event", getStored().events, (def: { name: string; commands: string }) =>
          `${cc("event")} {${def.name}} {${def.commands}}`);
        return null;
      }
      defineEvent(arg(0), argText(1), quiet);
      return null;
    }
    case "unevent": {
      if (removeEvent(argText(0))) {
        if (!quiet) echoOk(`#OK. {${arg(0)}} IS NO LONGER AN EVENT.`);
      } else echoError(`#ERROR: {${arg(0)}} IS NOT AN EVENT.`);
      return null;
    }

    case "class": {
      const className = interpolate(arg(0), env);
      const optionInput = arg(1).trim().toLowerCase();
      const option = CLASS_OPTIONS.find((candidate) => optionInput && candidate.startsWith(optionInput));
      if (!className || !option) {
        echoError(`#ERROR: ${cc("class")} {name} {${CLASS_OPTIONS.join("|")}}.`);
        return null;
      }
      switch (option) {
        case "open":
          setCurrentClass(className);
          if (!quiet) echoOk(`#OK. {${className}} IS NOW THE OPEN CLASS.`);
          return null;
        case "close":
          if (getCurrentClass() === className) setCurrentClass(null);
          if (!quiet) echoOk(`#OK. {${className}} IS NO LONGER OPEN.`);
          return null;
        case "assign": {
          const previous = getCurrentClass();
          setCurrentClass(className);
          try {
            return executeNodes(bodyFor(node, 2), env, depth + 1);
          } finally {
            setCurrentClass(previous);
          }
        }
        case "kill":
        case "clear": {
          const count = classKill(className);
          if (!quiet) echoOk(`#OK. {${className}} KILLED ${count} DEFINITION${count === 1 ? "" : "S"}.`);
          return null;
        }
        case "size":
          echo(`${cc("class")} {${className}} holds ${classSize(className)} definition(s).`);
          return null;
      }
      return null;
    }

    case "ignore": {
      if (!node.args.length) {
        for (const [kind, state] of ignoreStates()) {
          echo(`${cc("ignore")} ${kind}: ${state ? "ignored" : "active"}`);
        }
        return null;
      }
      const kind = resolveIgnoreKind(interpolate(arg(0), env));
      if (!kind) {
        echoError(`#ERROR: ${cc("ignore")} takes aliases, actions, gags, highlights, substitutes, tickers, macros, or events.`);
        return null;
      }
      const ignored = toggleIgnore(kind);
      if (!quiet) echoOk(`#OK. ${kind.toUpperCase()} ARE NOW ${ignored ? "IGNORED" : "ACTIVE"}.`);
      return null;
    }

    case "info": {
      const stored = getStored();
      const counts = Object.entries(stored)
        .map(([kind, table]) => `${kind}: ${Object.keys(table as object).length}`)
        .join(", ");
      echo(`tintin-emulator definitions: ${counts}`);
      return null;
    }

    case "ticker": {
      if (!node.args.length) {
        listDefinitions("ticker", getStored().tickers, (def: { name: string; commands: string; seconds: number }) =>
          `${cc("ticker")} {${def.name}} {${def.commands}} {${def.seconds}}`);
        return null;
      }
      defineTicker(
        arg(0),
        argText(1),
        node.args[1]?.braced ? Number(interpolate(arg(2), env)) : Number.NaN,
        quiet,
      );
      return null;
    }
    case "unticker": {
      if (removeTicker(argText(0))) {
        if (!quiet) echoOk(`#OK. {${argText(0)}} IS NO LONGER A TICKER.`);
      } else echoError(`#ERROR: {${argText(0)}} IS NOT A TICKER.`);
      return null;
    }
    case "delay": {
      if (isNamedDelay(node)) {
        defineDelay(interpolate(arg(0), env), arg(1), Number(interpolate(arg(2), env)));
      } else {
        defineDelay(null, argText(1), Number(interpolate(arg(0), env)));
      }
      return null;
    }
    case "undelay": {
      if (!removeDelay(interpolate(arg(0), env))) {
        echoError(`#ERROR: {${arg(0)}} IS NOT A DELAY.`);
      }
      return null;
    }

    // ---- Files -------------------------------------------------------------

    case "read": {
      const name = interpolate(argText(0), env);
      const opened = beginRead(name);
      if (opened.error !== undefined) {
        echoError(`#ERROR: ${opened.error}.`);
        return null;
      }
      try {
        // Per TinTin, each file declares its own command char: its first
        // character after any leading comment block.
        const parsed = parseTinTin(opened.text, {
          source: name,
          commandChar: discoverFileCommandChar(opened.text),
        });
        let warnings = 0;
        for (const item of parsed.diagnostics) {
          if (item.code === "unknown-command") continue;
          env.warn(formatDiagnostic(item));
          warnings += 1;
        }
        executeNodes(parsed.nodes, makeExecutionEnv(), depth + 1);
        if (!quiet) {
          echoOk(`#OK. READ {${name}}: ${parsed.nodes.length} commands${warnings ? `, ${warnings} warnings` : ""}.`);
        }
      } finally {
        endRead();
      }
      return null;
    }
    case "write": {
      const name = interpolate(argText(0), env);
      if (!name) {
        echoError(`#ERROR: ${cc("write")} needs a file name.`);
        return null;
      }
      const exported = exportDefinitions();
      const error = writeDataFile(name, exported.content);
      if (error) echoError(`#ERROR: ${error}.`);
      else if (!quiet) {
        const note = exported.skipped
          ? ` (${exported.skipped} entr${exported.skipped === 1 ? "y" : "ies"} skipped: unbalanced braces)`
          : "";
        echoOk(`#OK. WROTE {${name}}${note}.`);
      }
      return null;
    }

    // ---- Split / prompt ----------------------------------------------------

    case "split": {
      const rows = node.args.length ? Number(interpolate(arg(0), env)) : 2;
      if (!Number.isFinite(rows) || rows < 1) {
        echoError(`#ERROR: ${cc("split")} takes a number of rows.`);
        return null;
      }
      if (node.args[1]) env.warn(`${cc("split")}'s second argument is ignored; smudgy keeps the main view flexible`);
      openSplit(rows);
      if (!quiet) echoOk(`#OK. SPLIT OPEN (${Math.round(rows)} rows).`);
      return null;
    }
    case "unsplit": {
      if (closeSplit()) {
        if (!quiet) echoOk(`#OK. SPLIT CLOSED.`);
      } else echoError(`#ERROR: no split is open.`);
      return null;
    }
    case "prompt": {
      if (!node.args.length) {
        listDefinitions("prompt", getStored().prompts, (def: { pattern: string; replacement: string; row: number | null }) =>
          `${cc("prompt")} {${def.pattern}} {${def.replacement}}${def.row === null || def.row === undefined ? "" : ` {${def.row}}`}`);
        return null;
      }
      if (!node.args[1]) {
        const def = getStored().prompts[arg(0)];
        if (def) echo(`${cc("prompt")} {${def.pattern}} {${def.replacement}}${def.row === null || def.row === undefined ? "" : ` {${def.row}}`}`);
        else echoError(`#ERROR: {${arg(0)}} IS NOT A PROMPT.`);
        return null;
      }
      const rowText = interpolate(arg(2), env).trim();
      const row = /^-?\d+$/.test(rowText) ? Number(rowText) : null;
      definePrompt(arg(0), arg(1), row, quiet);
      return null;
    }
    case "unprompt": {
      if (removePrompt(argText(0))) {
        if (!quiet) echoOk(`#OK. {${argText(0)}} IS NO LONGER A PROMPT.`);
      } else echoError(`#ERROR: {${argText(0)}} IS NOT A PROMPT.`);
      return null;
    }

    // ---- Paths -------------------------------------------------------------

    case "path": {
      const optionInput = interpolate(arg(0), env).trim().toLowerCase();
      const option = PATH_OPTIONS.find((candidate) => optionInput && candidate.startsWith(optionInput));
      switch (option) {
        case "new":
        case "create":
          // TinTin's create clears the route AND starts tracking movement.
          pathCreate();
          if (!quiet) echoOk(`#OK. TRACKING A NEW PATH.`);
          return null;
        case "destroy":
          pathDestroy();
          if (!quiet) echoOk(`#OK. PATH DESTROYED.`);
          return null;
        case "start":
          pathStart();
          if (!quiet) echoOk(`#OK. TRACKING MOVEMENT.`);
          return null;
        case "end":
        case "stop":
          pathStop();
          if (!quiet) echoOk(`#OK. NO LONGER TRACKING.`);
          return null;
        case "describe": {
          const state = pathState();
          echo(`${cc("path")}: ${state.steps.length} steps${state.recording ? " (recording)" : ""}: ${state.zipped || "(empty)"}`);
          return null;
        }
        case "insert": {
          const dir = interpolate(arg(1), env).trim();
          if (!pathInsert(dir)) echoError(`#ERROR: {${dir}} IS NOT A PATHDIR.`);
          return null;
        }
        case "delete":
          if (!pathDelete()) echoError(`#ERROR: the path is empty.`);
          return null;
        case "undo":
          if (pathUndo() === null) echoError(`#ERROR: the path is empty.`);
          return null;
        case "run": {
          const secondsText = interpolate(arg(1), env).trim();
          const seconds = secondsText ? Number(secondsText) : null;
          if (secondsText && !Number.isFinite(seconds)) {
            echoError(`#ERROR: {${secondsText}} is not a number of seconds.`);
            return null;
          }
          const count = pathRun(seconds);
          if (!count) echoError(`#ERROR: the path is empty.`);
          else if (!quiet) echoOk(`#OK. RUNNING ${count} STEPS.`);
          return null;
        }
        case "zip":
          echo(pathState().zipped || "(empty)");
          return null;
        case "unzip": {
          const literals = pathUnzip(interpolate(argText(1), env));
          if (!quiet) {
            const note = literals.length ? ` (${literals.length} literal command${literals.length === 1 ? "" : "s"})` : "";
            echoOk(`#OK. PATH LOADED (${pathState().steps.length} steps${note}).`);
          }
          return null;
        }
        case "save": {
          // TinTin: #path save {forward|backward|both} {variable}.
          const modeInput = interpolate(arg(1), env).trim().toLowerCase();
          const mode = (["forward", "backward", "both"] as const)
            .find((candidate) => modeInput && candidate.startsWith(modeInput));
          const destinationText = interpolate(arg(2), env).trim();
          if (!mode || !destinationText) {
            echoError(`#ERROR: ${cc("path")} save {forward|backward|both} {variable}.`);
            return null;
          }
          env.setVar(variablePath(destinationText), pathSave(mode));
          if (!quiet) echoOk(`#OK. PATH SAVED TO {${destinationText}}.`);
          return null;
        }
        default:
          echoNote(`${cc("path")} ${optionInput || "?"} is not supported (walk/goto/load/map/swap/move/get are not implemented).`);
          return null;
      }
    }
    case "pathdir": {
      if (!node.args.length) {
        for (const entry of Object.values(getPathDirs())) {
          echo(`${cc("pathdir")} {${entry.dir}} {${entry.reverse}}`);
        }
        return null;
      }
      const dir = interpolate(arg(0), env).trim();
      const reverse = interpolate(arg(1), env).trim();
      if (!dir || !reverse) {
        echoError(`#ERROR: ${cc("pathdir")} {dir} {reverse}.`);
        return null;
      }
      if (!setPathDir(dir, reverse)) {
        echoError(`#ERROR: {${dir}} cannot be a pathdir name.`);
        return null;
      }
      if (!quiet) echoOk(`#OK. {${dir}} REVERSES TO {${reverse}}.`);
      return null;
    }
    case "unpathdir": {
      const dir = interpolate(argText(0), env).trim();
      if (removePathDir(dir)) {
        if (!quiet) echoOk(`#OK. {${dir}} IS NO LONGER A PATHDIR.`);
      } else echoError(`#ERROR: {${dir}} IS NOT A PATHDIR.`);
      return null;
    }

    // ---- Sessions ----------------------------------------------------------

    case "all": {
      const command = decodeTinTinOutputEscapes(interpolate(argText(0), env));
      if (!command) {
        echoError(`#ERROR: ${cc("all")} needs a command.`);
        return null;
      }
      const sessions = getSessions();
      for (const target of sessions) target.send(command);
      if (!quiet) echoOk(`#OK. SENT TO ${sessions.length} SESSION${sessions.length === 1 ? "" : "S"}.`);
      return null;
    }
    case "session": {
      if (!node.args.length) {
        const sessions = getSessions();
        if (!sessions.length) echoNote("no sessions are connected");
        for (const target of sessions) echo(`${cc("session")} {${target.profile.name}}`);
        return null;
      }
      echoNote(`opening sessions is managed in smudgy's connections window; ${cc(interpolate(arg(0), env))} {command} reaches a connected one`);
      return null;
    }
    case "bell": {
      echo(style.warn`*bell*`);
      return null;
    }

    case "help":
    case "commands": {
      showHelp();
      return null;
    }
  }

  const declined = DECLINED.get(name);
  if (declined) {
    echoError(`#ERROR: ${cc(name)} is not available: ${declined}.`);
    return null;
  }
  if (node.known) {
    echoNote(`${cc(name)} is not supported by tintin-emulator yet.`);
    return null;
  }
  // TinTin session-target shorthand: #<session name> {command}.
  const target = byName(node.spelling);
  if (target && node.args.length) {
    target.send(decodeTinTinOutputEscapes(interpolate(argText(0), env)));
    return null;
  }
  echoError(`#ERROR: ${cc(node.spelling)} IS NOT A COMMAND.`);
  return null;
}

/** Whether text can sit inside a braced argument without breaking out. */
function bracesBalanced(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * The persisted definitions as a TinTin command file (#write). TinTin braces
 * have no escape, so a field whose text would break out of its braces is
 * skipped with a note instead of being written as live commands. Variable
 * values captured from MUD output make that case trivially reachable.
 */
function exportDefinitions(): { content: string; skipped: number } {
  const stored = getStored();
  const lines: string[] = [
    `${activeCommandChar}nop written by tintin-emulator;`,
  ];
  let skipped = 0;
  const emit = (text: string, cls?: string) => {
    const wrapped = cls ? `${cc("class")} {${cls}} {assign} {${text}}` : text;
    if (!bracesBalanced(text) || (cls !== undefined && !bracesBalanced(wrapped))) {
      skipped += 1;
      lines.push(`${cc("nop")} skipped an entry with unbalanced braces;`);
      return;
    }
    lines.push(wrapped);
  };
  for (const [key, value] of Object.entries(vars as Record<string, unknown>)) {
    if (key === STORE_KEY) continue;
    // Arrays restore through #list create so they come back as lists, not
    // brace-run strings.
    if (Array.isArray(value)) {
      emit(`${cc("list")} {${key}} {create} {${value.map((item) => `{${stringifyTinTin(item)}}`).join("")}}`);
      continue;
    }
    emit(`${cc("variable")} {${key}} {${stringifyTinTin(value)}}`);
  }
  for (const def of Object.values(stored.pathdirs)) {
    emit(`${cc("pathdir")} {${def.dir}} {${def.reverse}}`);
  }
  for (const def of Object.values(stored.functions)) emit(`${cc("function")} {${def.name}} {${def.commands}}`, def.class);
  for (const def of Object.values(stored.aliases)) emit(`${cc("alias")} {${def.pattern}} {${def.commands}} {${def.priority}}`, def.class);
  for (const def of Object.values(stored.actions)) emit(`${cc("action")} {${def.pattern}} {${def.commands}} {${def.priority}}`, def.class);
  for (const def of Object.values(stored.gags)) emit(`${cc("gag")} {${def.pattern}}`, def.class);
  for (const def of Object.values(stored.highlights)) emit(`${cc("highlight")} {${def.pattern}} {${def.color}}`, def.class);
  for (const def of Object.values(stored.substitutes)) emit(`${cc("substitute")} {${def.pattern}} {${def.replacement}}`, def.class);
  for (const def of Object.values(stored.prompts)) {
    emit(`${cc("prompt")} {${def.pattern}} {${def.replacement}}${def.row === null || def.row === undefined ? "" : ` {${def.row}}`}`, def.class);
  }
  for (const def of Object.values(stored.tickers)) emit(`${cc("ticker")} {${def.name}} {${def.commands}} {${def.seconds}}`, def.class);
  for (const def of Object.values(stored.macros)) emit(`${cc("macro")} {${def.key}} {${def.commands}}`, def.class);
  for (const def of Object.values(stored.events)) emit(`${cc("event")} {${def.name}} {${def.commands}}`, def.class);
  return { content: `${lines.join("\n")}\n`, skipped };
}

function executeList(node: CommandNode, env: ExecutionEnv): void {
  const arg = (index: number) => node.args[index]?.value ?? "";
  const path = variablePath(interpolate(arg(0), env));
  const option = tinTinListOption(arg(1));
  const raw = env.getVar(path);
  let list: unknown[];
  if (Array.isArray(raw)) list = [...raw];
  else if (raw === undefined || raw === null) list = [];
  else if (typeof raw === "object") list = Object.values(raw as object);
  else list = splitTinTinItems(stringifyTinTin(raw));

  const write = () => env.setVar(path, list);
  const collect = (from: number) =>
    node.args.slice(from).flatMap((item) => splitTinTinItems(interpolate(item.value, env)));
  const oneBased = (text: string) => {
    const index = Number(evalExpression(text, env));
    if (!Number.isFinite(index) || index === 0) return null;
    return index < 0 ? list.length + index + 1 : index;
  };

  switch (option) {
    case "create":
      list = collect(2);
      write();
      return;
    case "add":
      list.push(...collect(2));
      write();
      return;
    case "clear":
      list = [];
      write();
      return;
    case "delete": {
      const index = oneBased(arg(2));
      const count = node.args[3] ? Number(interpolate(arg(3), env)) : 1;
      if (index === null || index < 1 || index > list.length) {
        echoError(`#ERROR: {${arg(2)}} is not a valid list index.`);
        return;
      }
      list.splice(index - 1, Math.max(1, count));
      write();
      return;
    }
    case "insert": {
      const index = oneBased(arg(2));
      if (index === null) {
        echoError(`#ERROR: {${arg(2)}} is not a valid list index.`);
        return;
      }
      const at = Math.min(Math.max(index, 1), list.length + 1);
      list.splice(at - 1, 0, ...collect(3));
      write();
      return;
    }
    case "set": {
      const index = oneBased(arg(2));
      if (index === null || index < 1 || index > list.length) {
        echoError(`#ERROR: {${arg(2)}} is not a valid list index.`);
        return;
      }
      list[index - 1] = interpolate(arg(3), env);
      write();
      return;
    }
    case "get": {
      const index = oneBased(arg(2));
      const destination = variablePath(interpolate(arg(3), env));
      env.setVar(destination, index !== null && index >= 1 && index <= list.length ? list[index - 1] : "");
      return;
    }
    case "size": {
      const destination = variablePath(interpolate(arg(2), env));
      env.setVar(destination, list.length);
      return;
    }
    case "reverse":
      list.reverse();
      write();
      return;
    case "sort":
    case "order":
      list.sort((a, b) => tinTinCompare(a, b));
      write();
      return;
    case "collapse": {
      const separator = node.args[2] ? interpolate(arg(2), env) : ";";
      env.setVar(path, list.map((item) => stringifyTinTin(item)).join(separator));
      return;
    }
    case "explode": {
      const separator = node.args[2] ? interpolate(arg(2), env) : ";";
      env.setVar(path, stringifyTinTin(raw ?? "").split(separator));
      return;
    }
    case "copy": {
      const destination = variablePath(interpolate(arg(2), env));
      env.setVar(destination, [...list]);
      return;
    }
    case "tokenize":
      list = [...interpolate(arg(2), env)];
      write();
      return;
    case "find": {
      const pattern = compileRuntimePattern(env, arg(2));
      const destination = variablePath(interpolate(arg(3), env));
      if (!pattern) return;
      const matcher = new RegExp(`^(?:${pattern.regex.source})$`, pattern.regex.flags);
      const found = list.findIndex((item) => matcher.test(stringifyTinTin(item)));
      env.setVar(destination, found + 1);
      return;
    }
    case "shuffle": {
      for (let index = list.length - 1; index > 0; index--) {
        const swap = Math.floor(Math.random() * (index + 1));
        [list[index], list[swap]] = [list[swap], list[index]];
      }
      write();
      return;
    }
    default:
      echoNote(`${cc("list")} ${option || "?"} is not supported yet.`);
  }
}

function showHelp(): void {
  const supported = [...SUPPORTED].map(cc).join(", ");
  echo(`tintin-emulator understands: ${supported}`);
  echoNote(`${cc("read")} and ${cc("write")} use this package's data directory; ${[...DECLINED.keys()].map(cc).join(", ")} stay unavailable in a sandboxed package.`);
}
