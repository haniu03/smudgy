// =============================================================================
//  Multi-session command routing and focus hotkeys
// =============================================================================
//  Session numbers are one-based positions in getSessions(), not persistent
//  runtime ids: 1 is always the elected main session, followed by its docked
//  secondaries. Compact selectors preserve their written routing order.

import { createAlias, createHotkey, getSessions, session, style } from "smudgy:core";
import { magnifySession } from "./multi.ts";

const ROUTER_PRIORITY = 1000;

function warnMissing(ordinals: readonly number[]): void {
  if (ordinals.length === 0) return;
  const suffix = ordinals.length === 1 ? "" : "s";
  session.echo(style.warn`[multi] session${suffix} ${ordinals.join(", ")} not available`);
}

function sendToOrdinals(selector: string, command: string): void {
  const sessions = getSessions();
  const sent = new Set<number>();
  const missing: number[] = [];

  for (const digit of selector) {
    const ordinal = Number(digit);
    if (sent.has(ordinal)) continue;
    sent.add(ordinal);

    const target = sessions[ordinal - 1];
    if (target) {
      target.send(command);
    } else {
      missing.push(ordinal);
    }
  }
  warnMissing(missing);
}

// `1foo`, `1 foo`, `241foo`, and `241 foo`. A compact command begins with a
// non-selector character; use a separating space when the command itself
// begins with a digit.
createAlias(
  /^(?<targets>[1-4]+)(?:\s+(?<spaced>\S.*)|(?<compact>[^1-4\s].*))$/,
  ({ targets, spaced, compact }) => {
    const command = (spaced || compact).trim();
    if (command) sendToOrdinals(targets, command);
  },
  {
    name: "nf-session-route",
    priority: ROUTER_PRIORITY,
    fallthrough: false,
  },
);

// Accept `*foo` / `* foo`, plus exclusion selectors such as `*-1foo` and
// `*-423 foo`. When exclusions are present, the star is optional: `-1foo`
// and `-423 foo` are equivalent. Excluding every live session is a silent no-op.
createAlias(
  /^(?:\*?-(?<exclude>[1-4]+)|\*)\s*(?<command>\S.*)$/,
  ({ exclude, command }) => {
    const text = command.trim();
    if (!text) return;
    const excluded = new Set([...(exclude ?? "")].map(Number));
    for (const [index, target] of getSessions().entries()) {
      if (!excluded.has(index + 1)) target.send(text);
    }
  },
  {
    name: "nf-session-broadcast",
    priority: ROUTER_PRIORITY,
    fallthrough: false,
  },
);

// `,foo` / `, foo` sends to every session except the one whose input received
// the command. Exclusions mirror broadcast syntax: `,-1foo` and `,-423 foo`.
// An empty target set is intentionally a silent no-op.
createAlias(
  /^,(?:-(?<exclude>[1-4]+))?\s*(?<command>\S.*)$/,
  ({ exclude, command }) => {
    const text = command.trim();
    if (!text) return;
    const excluded = new Set([...(exclude ?? "")].map(Number));
    for (const [index, target] of getSessions().entries()) {
      if (target.id !== session.id && !excluded.has(index + 1)) target.send(text);
    }
  },
  {
    name: "nf-session-others",
    priority: ROUTER_PRIORITY,
    fallthrough: false,
  },
);

const SESSION_KEYS = ["F1", "F2", "F3", "F4"] as const;

for (const [index, key] of SESSION_KEYS.entries()) {
  const ordinal = index + 1;
  createHotkey(
    { key },
    () => {
      const target = getSessions()[ordinal - 1];
      if (target) {
        // A main pane may itself be an inactive tab (notably in the configured
        // all-sessions tab layout). Select it before moving keyboard focus.
        target.mainPane.select();
        target.input.focus();
      } else {
        warnMissing([ordinal]);
      }
    },
    { name: `nf-focus-session-${ordinal}` },
  );

  createHotkey(
    { key, modifiers: ["ctrl"] },
    () => {
      if (!magnifySession(ordinal)) warnMissing([ordinal]);
    },
    { name: `nf-magnify-session-${ordinal}` },
  );
}
