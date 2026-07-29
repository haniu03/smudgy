// #path, TinTin's recorded-route facility. Recording watches what the
// session sends (the sys `send` event) and appends any command found in the
// pathdir table; #path run replays the route, #path undo backtracks one step
// with the recorded reverse. The route is session state and never persisted;
// the pathdir table persists with the other definitions.
//
// The sys `send` event is delivered turns after `send()` returns, so the
// replay/backtrack sends the emulator makes itself are excluded by an
// expected-sends ledger that the event handler consumes. A synchronous
// suppress flag doesn't work: it would already be reset by the time the
// event arrives.

import { send, createTimer } from "smudgy:core";
import type { Timer } from "smudgy:core";
import { send as sentOutput } from "smudgy:events/sys";
import { zipPath, unzipPath, lookupDir } from "../engine/path.ts";
import type { PathStep } from "../engine/path.ts";
import { getPathDirs } from "./definitions.ts";

let steps: PathStep[] = [];
let recording = false;
let subscribed = false;
const expectedSends = new Map<string, number>();
let runTimers: Timer[] = [];

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
    if (!recording) return;
    const known = lookupDir(getPathDirs(), command);
    if (known) steps.push({ dir: known.dir, reverse: known.reverse });
  });
}

function sendUnrecorded(command: string): void {
  ensureSubscription();
  expectedSends.set(command, (expectedSends.get(command) ?? 0) + 1);
  send(command);
}

function cancelRunTimers(): void {
  for (const timer of runTimers) timer.delete();
  runTimers = [];
}

/** TinTin's create clears the route AND starts tracking movement. */
export function pathCreate(): void {
  cancelRunTimers();
  steps = [];
  pathStart();
}

export function pathDestroy(): void {
  cancelRunTimers();
  steps = [];
  recording = false;
}

export function pathStart(): void {
  ensureSubscription();
  recording = true;
}

export function pathStop(): void {
  recording = false;
}

export function pathState(): { steps: PathStep[]; recording: boolean; zipped: string } {
  return { steps: [...steps], recording, zipped: zipPath(steps) };
}

/** Append a step by direction name; `false` when it's not a pathdir. */
export function pathInsert(dir: string): boolean {
  const known = lookupDir(getPathDirs(), dir.trim());
  if (!known) return false;
  steps.push({ dir: known.dir, reverse: known.reverse });
  return true;
}

/** Drop the last step without moving. `false` when the path is empty. */
export function pathDelete(): boolean {
  return steps.pop() !== undefined;
}

/** Backtrack: drop the last step and send its reverse. */
export function pathUndo(): string | null {
  const last = steps.pop();
  if (!last) return null;
  sendUnrecorded(last.reverse);
  return last.reverse;
}

/**
 * Replay the route. With no delay every step sends now; with `seconds`
 * between steps the walk is timer-paced. Starting a new run (or clearing
 * the path) cancels a paced run still in flight.
 */
export function pathRun(seconds: number | null): number {
  cancelRunTimers();
  const route = [...steps];
  if (!route.length) return 0;
  if (seconds === null || seconds <= 0) {
    for (const step of route) sendUnrecorded(step.dir);
    return route.length;
  }
  // Timer names land in the automations window, where "/" is not a legal
  // name character.
  runTimers = route.map((step, index) => createTimer(
    { name: `#path run ${index + 1} of ${route.length}`, intervalMs: Math.round(seconds * 1000) * (index + 1), repeat: false },
    () => sendUnrecorded(step.dir),
  ));
  return route.length;
}

/**
 * Replace the route from a speedwalk. Unknown names load as literal steps,
 * the way TinTin takes them (`open;2n` routes are normal); they're returned
 * so the caller can mention them.
 */
export function pathUnzip(speedwalk: string): string[] {
  cancelRunTimers();
  const result = unzipPath(speedwalk, getPathDirs());
  steps = result.steps;
  return result.literals;
}

/** Save forms: TinTin's `;`-joined command lists per direction. */
export function pathSave(mode: "forward" | "backward" | "both"): string | { forward: string; backward: string } {
  const forward = steps.map((step) => step.dir).join(";");
  const backward = [...steps].reverse().map((step) => step.reverse).join(";");
  if (mode === "forward") return forward;
  if (mode === "backward") return backward;
  return { forward, backward };
}
