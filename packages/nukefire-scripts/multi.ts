// =============================================================================
//  Multi-session layout
// =============================================================================
//  The oldest live same-server session owns the NukeFire UI. Package params
//  either dock up to three later sessions in a column on the right or group
//  every same-server main pane into one tab set.

import { getSessions, session, vars, type Pane, type Session } from "smudgy:core";
import { connected, created, destroyed } from "smudgy:events/sessions";
import { sessionLayout } from "./config.ts";
import { COMPACT_TERMINAL_FONT_SIZE } from "./theme.ts";

const SECONDARY_FONT_SIZE = COMPACT_TERMINAL_FONT_SIZE;
const SECONDARY_COLUMN_WIDTH = 440;
const MAX_SECONDARIES = 3;
const LAYOUT_DELAY_MS = 100;
const RESIZE_DELAY_MS = 150;

type RoleHandler = (isPrimary: boolean) => void;

let helperSerial = 0;

/** Whether this runtime currently belongs to the oldest same-server session. */
export function isPrimarySession(): boolean {
  return getSessions()[0]?.id === session.id;
}

/** Session whose main pane currently occupies the large central terminal slot. */
export function getMagnifiedSession(sessions = getSessions()): Session | undefined {
  const storedId = Number(vars.nfMagnifiedSessionId);
  return sessions.find((candidate) => candidate.id === storedId) ?? sessions[0];
}

function exchangeMainPanes(current: Session, target: Session): void {
  const currentFont = current.mainPane.fontSize;
  const targetFont = target.mainPane.fontSize;
  current.mainPane.swap(target.mainPane);
  current.mainPane.setFontSize(targetFont ?? null);
  target.mainPane.setFontSize(currentFont ?? null);
}

/** Swap an ordinal session into the central slot and return the new occupant. */
export function magnifySession(ordinal: number): Session | undefined {
  const sessions = getSessions();
  const target = sessions[ordinal - 1];
  const current = getMagnifiedSession(sessions);
  if (!target || !current) return undefined;

  if (sessionLayout === "tabbed") {
    target.mainPane.select();
  } else if (target.id !== current.id) {
    exchangeMainPanes(current, target);
  }
  vars.nfMagnifiedSessionId = target.id;
  target.input.focus();
  return target;
}

function restorePrimaryToCenter(primary: Session, sessions: readonly Session[]): void {
  const current = getMagnifiedSession([...sessions]);
  if (current && current.id !== primary.id) exchangeMainPanes(current, primary);
  vars.nfMagnifiedSessionId = primary.id;
}

function helperName(kind: string, target: Session): string {
  helperSerial += 1;
  return `NF ${kind} ${target.id} ${Date.now().toString(36)} ${helperSerial}`;
}

function desiredLowerHeight(
  totalHeight: number | undefined,
  index: number,
  count: number,
): number | undefined {
  if (totalHeight === undefined) return undefined;
  return Math.max(1, Math.round((totalHeight * (count - index)) / count));
}

function dockSecondary(
  primary: Session,
  secondaries: readonly Session[],
  index: number,
  totalHeight: number | undefined,
): void {
  const target = secondaries[index];
  const destination = index === 0
    ? primary.mainPane.split("right", {
      name: helperName("dock", target),
      width: SECONDARY_COLUMN_WIDTH,
      terminal: false,
    })
    : secondaries[index - 1].mainPane.split("bottom", {
      name: helperName("dock", target),
      height: desiredLowerHeight(totalHeight, index, secondaries.length),
      terminal: false,
    });

  target.mainPane.swap(destination);
  destination.close();
  target.mainPane.setFontSize(SECONDARY_FONT_SIZE);
}

/** Resize a main pane's layout group through a short-lived sibling tab. */
function resizeMainGroup(pane: Pane, owner: Session, size: { width?: number; height?: number }): void {
  const helper = pane.addTab({
    name: helperName("resize", owner),
    terminal: false,
  });
  try {
    helper.resize(size);
  } finally {
    helper.close();
  }
}

function rebalanceSecondaryColumn(primary: Session, secondaries: readonly Session[]): void {
  const totalHeight = primary.mainPane.size?.height;
  if (secondaries.length === 0) return;

  const firstHeight = totalHeight === undefined
    ? undefined
    : Math.max(1, Math.round(totalHeight / secondaries.length));
  resizeMainGroup(secondaries[0].mainPane, secondaries[0], {
    width: SECONDARY_COLUMN_WIDTH,
    height: firstHeight,
  });

  // Setting the first and last extents is enough: the center pane receives
  // the remaining height when all three secondary slots are occupied.
  if (secondaries.length === 3 && firstHeight !== undefined) {
    resizeMainGroup(secondaries[2].mainPane, secondaries[2], { height: firstHeight });
  }
}

function arrangeTabbedSessions(): void {
  const sessions = getSessions();
  const primary = sessions[0];
  if (primary?.id !== session.id) return;

  for (const secondary of sessions.slice(1)) {
    secondary.mainPane.groupWith(primary.mainPane, { position: "end" });
    // A tab occupies the full terminal slot, so undo the compact override
    // used by the alternative right-hand stack.
    secondary.mainPane.setFontSize(null);
  }
}

function arrangeSecondarySessions(forceDock: boolean, rebalance: boolean): void {
  const sessions = getSessions();
  const primary = sessions[0];
  if (primary?.id !== session.id) return;

  if (forceDock) restorePrimaryToCenter(primary, sessions);

  const secondaries = sessions.slice(1, MAX_SECONDARIES + 1);
  const magnified = getMagnifiedSession(sessions);
  const totalHeight = primary.mainPane.size?.height;
  let changed = false;

  for (let index = 0; index < secondaries.length; index += 1) {
    const secondary = secondaries[index];
    // The explicit font override doubles as a durable reload marker. A newly
    // opened session follows the global font and therefore has no override.
    if (!forceDock && (
      secondary.id === magnified?.id || secondary.mainPane.fontSize === SECONDARY_FONT_SIZE
    )) continue;
    dockSecondary(primary, secondaries, index, totalHeight);
    changed = true;
  }

  if (changed || rebalance) {
    setTimeout(() => {
      const live = getSessions();
      if (live[0]?.id !== session.id) return;
      rebalanceSecondaryColumn(live[0], live.slice(1, MAX_SECONDARIES + 1));
    }, RESIZE_DELAY_MS);
  }
}

/**
 * Keep this package's role and the shared multi-session layout current.
 * The returned role callback fires immediately and whenever leadership moves.
 */
export function startMultiSessionSupport(onRoleChange: RoleHandler): void {
  let currentRole: boolean | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forceNextDock = false;
  let rebalanceNext = false;

  const sync = (): void => {
    timer = undefined;
    const nextRole = isPrimarySession();
    const promoted = currentRole === false && nextRole;

    if (nextRole !== currentRole) {
      currentRole = nextRole;
      onRoleChange(nextRole);
    }

    if (nextRole) {
      if (sessionLayout === "tabbed") {
        arrangeTabbedSessions();
      } else {
        arrangeSecondarySessions(forceNextDock || promoted, rebalanceNext);
      }
    }
    forceNextDock = false;
    rebalanceNext = false;
  };

  const schedule = (forceDock = false): void => {
    forceNextDock ||= forceDock;
    rebalanceNext = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(sync, LAYOUT_DELAY_MS);
  };

  created.on(() => schedule(true));
  connected.on(() => schedule(true));
  destroyed.on(() => schedule(true));

  sync();
}
