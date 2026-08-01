// #path, TinTin's recorded-route facility. Recording watches what the
// session sends (the sys `send` event) and appends commands from the pathdir
// table. A path also has TinTin's cursor: loaded paths start at position 1,
// recorded paths finish one position past their final step, and run/walk
// advance that cursor.
//
// The sys `send` event is delivered turns after `send()` returns, so sends
// made by replay/backtracking are excluded through an expected-sends ledger.

import { send, createTimer } from "smudgy:core";
import type { Timer } from "smudgy:core";
import { send as sentOutput } from "smudgy:events/sys";
import { zipPath, unzipPath, lookupDir } from "../engine/path.ts";
import type { PathStep } from "../engine/path.ts";
import { splitTinTinItems } from "../engine/text.ts";
import { getPathDirs } from "./definitions.ts";

let steps: PathStep[] = [];
let position = 0;
let recording = false;
let subscribed = false;
const expectedSends = new Map<string, number>();
let runTimers: Timer[] = [];
let pendingRunSteps = 0;
let runEpoch = 0;

function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  sentOutput.on((payload) => {
    const command = payload.command.trim();
    const expected = expectedSends.get(command) ?? 0;
    if (expected > 0) {
      if (expected === 1) expectedSends.delete(command);
      else expectedSends.set(command, expected - 1);
      return;
    }
    pathRecordCommand(command);
  });
}

/**
 * Record a command that is reaching the MUD without a sys:send event.
 * SPEEDWALK uses this because its expanded directions must bypass aliases.
 */
export function pathRecordCommand(command: string): boolean {
  if (!recording) return false;
  const known = lookupDir(getPathDirs(), command.trim());
  if (!known) return false;
  steps.push({ dir: known.dir, reverse: known.reverse });
  position = steps.length;
  return true;
}

function sendUnrecorded(command: string): void {
  ensureSubscription();
  expectedSends.set(command, (expectedSends.get(command) ?? 0) + 1);
  send(command);
}

function cancelRunTimers(): boolean {
  const wasRunning = pendingRunSteps > 0;
  runEpoch += 1;
  for (const timer of runTimers) timer.delete();
  runTimers = [];
  pendingRunSteps = 0;
  return wasRunning;
}

/** TinTin's create clears the route AND starts tracking movement. */
export function pathCreate(): void {
  cancelRunTimers();
  steps = [];
  position = 0;
  pathStart();
}

export function pathDestroy(): void {
  cancelRunTimers();
  steps = [];
  position = 0;
  recording = false;
}

export function pathStart(): void {
  ensureSubscription();
  recording = true;
}

/** Stop mapping first; if not mapping, abort a paced run. */
export function pathStop(): "recording" | "running" | "idle" {
  if (recording) {
    recording = false;
    return "recording";
  }
  return cancelRunTimers() ? "running" : "idle";
}

export interface PathState {
  steps: PathStep[];
  /** Zero-based cursor; TinTin displays it as position + 1. */
  position: number;
  recording: boolean;
  running: boolean;
  zipped: string;
}

export function pathState(): PathState {
  return {
    steps: steps.map((step) => ({ ...step })),
    position,
    recording,
    running: pendingRunSteps > 0,
    zipped: zipPath(steps),
  };
}

/** Append a path node. Known #pathdirs supply their configured reverse. */
export function pathInsert(dir: string, reverse?: string, delay = 0): boolean {
  const forward = dir.trim();
  if (!forward) return false;
  const known = lookupDir(getPathDirs(), forward);
  const step: PathStep = known
    ? { dir: known.dir, reverse: known.reverse }
    : { dir: forward, reverse: reverse === undefined ? forward : reverse.trim() };
  if (Number.isFinite(delay) && delay > 0) step.delay = delay;
  steps.push(step);
  // TinTin only follows an insertion when path mapping is active.
  if (recording) position = steps.length;
  return true;
}

/** Drop the final node without moving. */
export function pathDelete(): boolean {
  cancelRunTimers();
  if (steps.pop() === undefined) return false;
  position = Math.min(position, steps.length);
  return true;
}

export type PathUndoResult =
  | { ok: true; command: string }
  | { ok: false; reason: "empty" | "position" | "recording" };

/** Undo the final mapped step, matching TinTin's cursor/mapping guards. */
export function pathUndo(): PathUndoResult {
  cancelRunTimers();
  if (!steps.length) return { ok: false, reason: "empty" };
  if (position !== steps.length) return { ok: false, reason: "position" };
  if (!recording) return { ok: false, reason: "recording" };
  const last = steps[steps.length - 1];
  sendUnrecorded(last.reverse);
  steps.pop();
  position = steps.length;
  return { ok: true, command: last.reverse };
}

/**
 * Run forward from the current cursor. With no delay, all remaining steps are
 * sent immediately. A paced run advances the cursor as each timer fires and
 * can be resumed after #path stop.
 */
export function pathRun(seconds: number | null): number {
  cancelRunTimers();
  const start = position;
  const route = steps.slice(start);
  if (!route.length) return 0;
  if (seconds === null || seconds <= 0) {
    for (const step of route) {
      sendUnrecorded(step.dir);
      position += 1;
    }
    return route.length;
  }

  recording = false;
  const epoch = runEpoch;
  pendingRunSteps = route.length;
  let elapsedMs = 0;
  runTimers = route.map((step, offset) => {
    const expectedPosition = start + offset;
    const timer = createTimer(
      {
        name: `#path run ${offset + 1} of ${route.length}`,
        intervalMs: Math.max(1, elapsedMs),
        repeat: false,
      },
      () => {
        if (epoch !== runEpoch || position !== expectedPosition) return;
        sendUnrecorded(step.dir);
        position += 1;
        pendingRunSteps -= 1;
        if (pendingRunSteps === 0) runTimers = [];
      },
    );
    elapsedMs += Math.round((seconds + (step.delay ?? 0)) * 1000);
    return timer;
  });
  return route.length;
}

/** Take one forward/backward step and advance the cursor. */
export function pathWalk(direction: "forward" | "backward"): string | null {
  cancelRunTimers();
  recording = false;
  if (direction === "backward") {
    if (position === 0) return null;
    position -= 1;
    const command = steps[position].reverse;
    sendUnrecorded(command);
    return command;
  }
  if (position >= steps.length) return null;
  const command = steps[position].dir;
  sendUnrecorded(command);
  position += 1;
  return command;
}

/** Set the cursor without sending movement. Positions are TinTin's 1-based values. */
export function pathGoto(target: "start" | "end" | number): number | null {
  cancelRunTimers();
  if (target === "start") position = 0;
  else if (target === "end") position = steps.length;
  else {
    if (!Number.isInteger(target) || target < 1 || target > steps.length + 1) return null;
    position = target - 1;
  }
  return position + 1;
}

/** Move the cursor relatively without sending movement. */
export function pathMove(amount: number): { from: number; to: number } | null {
  cancelRunTimers();
  if (!Number.isFinite(amount)) return null;
  const from = position + 1;
  position = Math.max(0, Math.min(steps.length, position + Math.trunc(amount)));
  return { from, to: position + 1 };
}

/** Reverse node order and exchange every forward/backward command. */
export function pathSwap(): boolean {
  cancelRunTimers();
  if (!steps.length) return false;
  if (position !== 0) position = steps.length - position;
  steps = [...steps].reverse().map((step) => ({
    dir: step.reverse,
    reverse: step.dir,
    ...(step.delay === undefined ? {} : { delay: step.delay }),
  }));
  return true;
}

function splitTopLevelSemicolons(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "{") depth += 1;
    else if (value[index] === "}") depth = Math.max(0, depth - 1);
    else if (value[index] === ";" && depth === 0) {
      items.push(value.slice(start, index));
      start = index + 1;
    }
  }
  items.push(value.slice(start));
  return items;
}

function appendLoadedStep(forward: string, reverse?: string, delayText?: string): void {
  const delay = delayText === undefined ? 0 : Number(delayText);
  pathInsert(forward, reverse, Number.isFinite(delay) ? delay : 0);
}

/**
 * Replace the path from TinTin's simple/brace-list form, a saved variable, or
 * the `{forward}{backward}{delay}` triples produced by `#path save both`.
 */
export function pathLoad(value: unknown): number {
  cancelRunTimers();
  steps = [];
  position = 0;
  recording = false;

  if (Array.isArray(value)) {
    for (const item of value) appendLoadedStep(String(item));
    return steps.length;
  }

  // Backward compatibility with the emulator's old object-shaped BOTH value.
  if (value && typeof value === "object" && "forward" in value) {
    value = String((value as { forward: unknown }).forward ?? "");
  }

  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (text.startsWith(";")) {
    for (const item of splitTopLevelSemicolons(text).filter(Boolean)) {
      const fields = splitTinTinItems(item);
      if (fields.length) appendLoadedStep(fields[0], fields[1], fields[2]);
    }
  } else {
    for (const item of splitTinTinItems(text)) appendLoadedStep(item);
  }
  return steps.length;
}

/**
 * Replace the route from a v2 speedwalk. Unknown names load as literal steps,
 * the way TinTin accepts commands such as `open;2n`.
 */
export function pathUnzip(speedwalk: string): string[] {
  cancelRunTimers();
  const result = unzipPath(speedwalk, getPathDirs());
  steps = result.steps;
  position = 0;
  recording = false;
  return result.literals;
}

/** TinTin's save forms, including its 1-based cursor position. */
export function pathSave(
  mode: "forward" | "backward" | "both" | "length" | "position",
): string | number {
  if (mode === "length") return steps.length;
  if (mode === "position") return position + 1;
  if (mode === "forward") return steps.map((step) => step.dir).join(";");
  if (mode === "backward") return [...steps].reverse().map((step) => step.reverse).join(";");
  return steps
    .map((step) => `;{${step.dir}}{${step.reverse}}{${step.delay ?? 0}}`)
    .join("");
}

/** Collapse the current route into one forward/backward speedwalk node. */
export function pathZip(): { forward: string; backward: string } | null {
  cancelRunTimers();
  if (!steps.length) return null;
  const forward = zipPath(steps);
  const backward = zipPath(
    [...steps].reverse().map((step) => ({ dir: step.reverse, reverse: step.dir })),
  );
  steps = [{ dir: forward, reverse: backward }];
  position = 0;
  return { forward, backward };
}

/** TinTin-style route display with the next step in square brackets. */
export function pathMap(): string | null {
  if (!steps.length) return null;
  const rendered = steps.map((step, index) => {
    const command = /\s/.test(step.dir) ? `{${step.dir}}` : step.dir;
    return index === position ? `[${command}]` : command;
  });
  if (position === steps.length) rendered.push("[ ]");
  return `${rendered.join(" ")}`;
}
