import assert from "node:assert/strict";
import test from "node:test";
import { followMerge, noteText, type NoteTarget } from "./notes-model.ts";

test("blank notes read as no notes", () => {
  assert.equal(noteText(undefined), undefined);
  assert.equal(noteText(""), undefined);
  assert.equal(noteText(" \n\t"), undefined);
  assert.equal(noteText("  Ask the *guard* first.\n"), "  Ask the *guard* first.\n");
});

test("a room being edited follows a merge to its new address", () => {
  const room: NoteTarget = { kind: "room", areaId: "section", roomNumber: 4, vnum: 3001, name: "Gate" };
  const merge = {
    into: "midgaard",
    rooms: [
      { from: { area: "section", room: 3 }, to: 12 },
      { from: { area: "section", room: 4 }, to: 13 },
    ],
  };
  assert.deepEqual(followMerge(room, merge), { ...room, areaId: "midgaard", roomNumber: 13 });
  assert.equal(followMerge(room, { into: "midgaard", rooms: [{ from: { area: "other", room: 4 }, to: 9 }] }), room);
});

test("a map being edited keeps its own target through a merge", () => {
  const area: NoteTarget = { kind: "area", areaId: "section", name: "Midgaard" };
  assert.equal(followMerge(area, { into: "midgaard", rooms: [{ from: { area: "section", room: 4 }, to: 13 }] }), area);
});
