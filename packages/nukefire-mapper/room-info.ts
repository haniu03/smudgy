import type { NukeFireMapLink } from "smudgy://kapusniak/nukefire-gmcp";
import { isUsableVnum, mapDirection, type MappedDirection } from "./model.ts";

export interface VerticalExitObservation {
  mapped: MappedDirection;
  destination?: number;
  closed: boolean;
}

/**
 * Extract the topology Map.Local omits from the current room's ordinary GMCP
 * exit table. A numeric destination is stronger than an ambiguous `closed`
 * entry if a server happens to publish aliases for the same direction.
 */
export function verticalExitObservations(
  exits: Readonly<Record<string, number | "closed">>,
): VerticalExitObservation[] {
  const byDirection = new Map<"Up" | "Down", VerticalExitObservation>();
  for (const [command, value] of Object.entries(exits)) {
    const mapped = mapDirection(command);
    if (mapped.direction !== "Up" && mapped.direction !== "Down") continue;
    const destination = typeof value === "number" && isUsableVnum(value)
      ? value
      : undefined;
    const observation = {
      mapped,
      ...(destination === undefined ? {} : { destination }),
      closed: value === "closed",
    } satisfies VerticalExitObservation;
    const known = byDirection.get(mapped.direction);
    if (!known || (known.destination === undefined && destination !== undefined)) {
      byDirection.set(mapped.direction, observation);
    }
  }
  return [...byDirection.values()]
    .sort((a, b) => a.mapped.direction.localeCompare(b.mapped.direction));
}

/** Convert destination-bearing observations into the normal mapper link path. */
export function verticalMapLinks(
  center: number,
  observations: readonly VerticalExitObservation[],
): NukeFireMapLink[] {
  return observations.flatMap((observation) => observation.destination === undefined
    ? []
    : [{
      from: center,
      to: observation.destination,
      direction: observation.mapped.command,
      bidirectional: false,
      closed: observation.closed,
      locked: false,
      route: false,
    }]);
}
