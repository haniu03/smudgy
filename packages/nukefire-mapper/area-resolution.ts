export const NUKEFIRE_AREA_ID_PROPERTY = "nukefire.zone";

export interface NukeFireAreaCandidate {
  readonly name: string;
  readonly storage: MapStorage;
  data(key: string): string | undefined;
}

/**
 * Whether an existing area may be adopted by a mapper configured for
 * `configured` storage. Durable NukeFire maps are adopted from either durable
 * tier — a cloud map kept by an earlier install must not be shadowed by a
 * fresh local duplicate carrying the same externalIds — while session areas
 * and session-configured mappers only ever pair with each other. New areas
 * are still created in the configured tier.
 */
export function isAdoptableStorage(candidate: MapStorage, configured: MapStorage): boolean {
  return configured === "session" ? candidate === "session" : candidate !== "session";
}

/**
 * Find the area already tagged with NukeFire's area identity. An area in the
 * configured storage tier wins over an adoptable area in another tier.
 */
export function findAreaByNukeFireId<T extends NukeFireAreaCandidate>(
  areas: readonly T[],
  storage: MapStorage,
  areaId: number | string,
): T | undefined {
  const expected = String(areaId);
  const matches = areas.filter((candidate) =>
    isAdoptableStorage(candidate.storage, storage) &&
    candidate.data(NUKEFIRE_AREA_ID_PROPERTY) === expected
  );
  return matches.find((candidate) => candidate.storage === storage) ?? matches[0];
}

/**
 * Fall back to a display-name match only when it is unclaimed or already
 * carries the requested NukeFire area identity. The configured storage tier
 * wins over an adoptable area in another tier.
 */
export function findCompatibleAreaByName<T extends NukeFireAreaCandidate>(
  areas: readonly T[],
  storage: MapStorage,
  areaId: number | string,
  name: string,
): T | undefined {
  const expected = String(areaId);
  const matches = areas.filter((candidate) => {
    if (!isAdoptableStorage(candidate.storage, storage)) return false;
    const candidateAreaId = candidate.data(NUKEFIRE_AREA_ID_PROPERTY);
    return (candidateAreaId === undefined || candidateAreaId === expected) &&
      candidate.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0;
  });
  return matches.find((candidate) => candidate.storage === storage) ?? matches[0];
}

/**
 * The area one observed room is written into. A vnum the map already contains
 * keeps its room's area even when the snapshot's zone resolves to a different
 * one — border rooms are reported by both neighboring zones, and re-creating a
 * known vnum in the zone's area would duplicate it under the same externalId.
 * Only unknown vnums land in the zone's area.
 */
export function areaForObservedRoom<T>(
  zoneArea: T | undefined,
  knownRoomArea: T | undefined,
): T | undefined {
  return knownRoomArea ?? zoneArea;
}
