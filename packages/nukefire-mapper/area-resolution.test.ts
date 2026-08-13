import assert from "node:assert/strict";
import test from "node:test";
import {
  findAreaByNukeFireId,
  findCompatibleAreaByName,
  NUKEFIRE_AREA_ID_PROPERTY,
  type NukeFireAreaCandidate,
} from "./area-resolution.ts";

interface Candidate extends NukeFireAreaCandidate {
  readonly id: string;
}

function candidate(
  id: string,
  name: string,
  storage: MapStorage,
  areaId?: number,
): Candidate {
  return {
    id,
    name,
    storage,
    data(key: string): string | undefined {
      return key === NUKEFIRE_AREA_ID_PROPERTY && areaId !== undefined
        ? String(areaId)
        : undefined;
    },
  };
}

test("area identity wins over duplicate display names", () => {
  const sameName = candidate("name-only", "Central Plaza", "local");
  const exact = candidate("exact", "Old Central Plaza", "local", 42);

  assert.equal(findAreaByNukeFireId([sameName, exact], "local", 42), exact);
});

test("area identity matching stays within the configured storage tier", () => {
  const cloud = candidate("cloud", "Central Plaza", "cloud", 42);
  const local = candidate("local", "Central Plaza", "local", 42);

  assert.equal(findAreaByNukeFireId([cloud, local], "local", 42), local);
});

test("name fallback does not reuse an area tagged for another identity", () => {
  const wrong = candidate("wrong", "Central Plaza", "local", 41);
  const unclaimed = candidate("unclaimed", "central plaza", "local");

  assert.equal(findCompatibleAreaByName([wrong, unclaimed], "local", 42, "Central Plaza"), unclaimed);
});
