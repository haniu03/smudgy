export const NUKEFIRE_AREA_ID_PROPERTY = "nukefire.zone";

export interface NukeFireAreaCandidate {
  readonly name: string;
  readonly storage: MapStorage;
  data(key: string): string | undefined;
}

/** Find the area already tagged with NukeFire's area identity. */
export function findAreaByNukeFireId<T extends NukeFireAreaCandidate>(
  areas: readonly T[],
  storage: MapStorage,
  areaId: number | string,
): T | undefined {
  const expected = String(areaId);
  return areas.find((candidate) =>
    candidate.storage === storage &&
    candidate.data(NUKEFIRE_AREA_ID_PROPERTY) === expected
  );
}

/**
 * Fall back to a display-name match only when it is unclaimed or already
 * carries the requested NukeFire area identity.
 */
export function findCompatibleAreaByName<T extends NukeFireAreaCandidate>(
  areas: readonly T[],
  storage: MapStorage,
  areaId: number | string,
  name: string,
): T | undefined {
  const expected = String(areaId);
  return areas.find((candidate) => {
    if (candidate.storage !== storage) return false;
    const candidateAreaId = candidate.data(NUKEFIRE_AREA_ID_PROPERTY);
    return (candidateAreaId === undefined || candidateAreaId === expected) &&
      candidate.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0;
  });
}
