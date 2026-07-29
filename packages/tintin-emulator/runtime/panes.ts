// The #split pane: a terminal strip above the main view that #showme and
// #prompt can address by row. TinTin positions text at exact rows of its
// split region; smudgy panes append lines, so a row number here selects the
// pane rather than a position within it. Documented in the README.

import { session } from "smudgy:core";
import type { Pane, StyledText } from "smudgy:core";

const PANE_NAME = "TinTin";
const ROW_PIXELS = 20;

let splitPane: Pane | null = null;

/** Open the split pane, `rows` text rows tall. `split()` on an existing name
 *  ignores the height, so resizing means closing and recreating. */
export function openSplit(rows: number): void {
  splitPane?.close();
  splitPane = session.mainPane.split("top", {
    name: PANE_NAME,
    height: Math.max(1, Math.round(rows)) * ROW_PIXELS,
  });
}

export function closeSplit(): boolean {
  if (!splitPane) return false;
  splitPane.close();
  splitPane = null;
  return true;
}

export function hasSplit(): boolean {
  return splitPane !== null;
}

/** Echo into the split pane; `false` when no split is open. */
export function splitEcho(text: string | StyledText): boolean {
  if (!splitPane) return false;
  splitPane.echo(text);
  return true;
}
