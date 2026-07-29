// The execution environment TinTin bodies run against: `vars` from
// smudgy:core is the variable store (package-private and persistent), with
// per-execution locals (#local) shadowing it, capture slots (%0..%99)
// supplied by whatever fired the body, and regex capture slots (&0..&99) set
// by an enclosing #replace/#regexp. All selector indexing is TinTin's
// 1-based form, on reads, writes, and deletes alike; lookups never walk the
// prototype chain, so a variable named `toString` is just a variable.

import { vars } from "smudgy:core";
import type { Env } from "../engine/eval.ts";

/** One selector step into a nested value, with TinTin's 1-based indexing. */
function stepIn(value: unknown, selector: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const index = Number(selector);
    if (Number.isInteger(index) && index >= 1) return value[index - 1];
    return undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.hasOwn(record, selector)) return record[selector];
    const index = Number(selector);
    if (Number.isInteger(index) && index >= 1) {
      const key = Object.keys(record)[index - 1];
      return key === undefined ? undefined : record[key];
    }
    return undefined;
  }
  return undefined;
}

/** Write one slot, mapping numeric selectors 1-based on arrays like reads do. */
function writeSlot(holder: Record<string, unknown> | unknown[], selector: string, value: unknown): void {
  if (Array.isArray(holder)) {
    const index = Number(selector);
    if (Number.isInteger(index) && index >= 1) {
      holder[index - 1] = value;
      return;
    }
  }
  (holder as Record<string, unknown>)[selector] = value;
}

export interface ExecutionEnv extends Env {
  /** `#local` — define in this execution's scope rather than `vars`. */
  setLocal(path: string[], value: unknown): void;
  deleteLocal(path: string[]): void;
  /** Capture slots for `%0..%99`, replaced when an automation fires. */
  slots: Record<number, string>;
  /** Regex capture slots for `&0..&99`, set by #replace/#regexp. */
  regexSlots: Record<number, string>;
}

export interface EnvOptions {
  slots?: Record<number, string>;
  warn: (message: string) => void;
  callFunction?: Env["callFunction"];
}

export function makeEnv({ slots = {}, warn, callFunction }: EnvOptions): ExecutionEnv {
  const locals: Record<string, unknown> = Object.create(null);
  const regexSlots: Record<number, string> = {};

  const rootFor = (name: string): Record<string, unknown> =>
    Object.hasOwn(locals, name) ? locals : (vars as Record<string, unknown>);

  const getIn = (path: string[]): unknown => {
    let value: unknown = rootFor(path[0])[path[0]];
    for (const selector of path.slice(1)) value = stepIn(value, selector);
    return value;
  };

  const setIn = (root: Record<string, unknown>, path: string[], value: unknown) => {
    let holder: Record<string, unknown> | unknown[] = root;
    for (const selector of path.slice(0, -1)) {
      let next = holder === root ? root[selector] : stepIn(holder, selector);
      if (next === null || typeof next !== "object") {
        next = {};
        writeSlot(holder, selector, next);
      }
      holder = next as Record<string, unknown> | unknown[];
    }
    writeSlot(holder, path.at(-1)!, value);
  };

  const deleteIn = (root: Record<string, unknown>, path: string[]) => {
    if (path.length === 1) {
      delete root[path[0]];
      return;
    }
    let holder: unknown = root[path[0]];
    for (const selector of path.slice(1, -1)) holder = stepIn(holder, selector);
    if (holder === null || typeof holder !== "object") return;
    const last = path.at(-1)!;
    if (Array.isArray(holder)) {
      const index = Number(last);
      if (Number.isInteger(index) && index >= 1) holder.splice(index - 1, 1);
      return;
    }
    delete (holder as Record<string, unknown>)[last];
  };

  const env: ExecutionEnv = {
    slots,
    regexSlots,
    warn,
    callFunction,
    getVar: (path) => getIn(path),
    hasVar: (path) => getIn(path) !== undefined,
    setVar: (path, value) => setIn(rootFor(path[0]), path, value),
    deleteVar: (path) => deleteIn(rootFor(path[0]), path),
    setLocal: (path, value) => setIn(locals, path, value),
    deleteLocal: (path) => deleteIn(locals, path),
    sizeVar: (path) => {
      const value = getIn(path);
      if (value === null || value === undefined) return 0;
      if (Array.isArray(value)) return value.length;
      if (typeof value === "object") return Object.keys(value as object).length;
      return 1;
    },
    keyVar: (path) => {
      if (path.length < 2) return path[0] ?? "";
      const parent = getIn(path.slice(0, -1));
      const last = path.at(-1)!;
      if (parent !== null && typeof parent === "object" && !Array.isArray(parent)) {
        const index = Number(last);
        if (Number.isInteger(index) && index >= 1) {
          return Object.keys(parent as object)[index - 1] ?? "";
        }
        if (Object.hasOwn(parent as object, last)) return last;
      }
      warn(`*${path.join("[")} could not be resolved to a table key`);
      return "";
    },
    slot: (n) => slots[n],
    regexSlot: (n) => regexSlots[n],
  };
  return env;
}
