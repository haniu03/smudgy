import type { MapMerge } from "./map-activity.ts";

/** The map and room property that holds their Markdown notes. */
export const NOTES_PROPERTY = "notes";

/** What the notes editor writes: one map's notes, or one room's. */
export type NoteTarget =
  | {
    readonly kind: "area";
    readonly areaId: string;
    readonly name: string;
  }
  | {
    readonly kind: "room";
    readonly areaId: string;
    readonly roomNumber: number;
    /** The game's room number, which the room keeps when maps are combined. */
    readonly vnum: number | undefined;
    readonly name: string;
  };

/** Notes worth showing: none when the property is missing or blank. */
export function noteText(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * Follow a committed merge while the editor is open. A moved room takes its
 * new address. A map keeps its own target: saving to a map that was combined
 * into another fails rather than overwrite the other map's notes.
 */
export function followMerge(target: NoteTarget, merge: MapMerge): NoteTarget {
  if (target.kind !== "room") return target;
  const moved = merge.rooms.find(({ from }) =>
    from.area === target.areaId && from.room === target.roomNumber
  );
  return moved ? { ...target, areaId: merge.into, roomNumber: moved.to } : target;
}
