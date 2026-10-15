import assert from "node:assert/strict";
import test from "node:test";
import { observedDoor } from "./doors.ts";
import { recordObservedDoors } from "./recording.ts";

test("observations keep door names and commands; a closed observation doesn't unlock a door", () => {
    const door = { state: "locked", name: "gate", opensWith: "unlock gate;open gate" } as const;
    assert.deepEqual(observedDoor(door, true), door);
    assert.deepEqual(observedDoor(door, false), { ...door, state: "open" });
    assert.equal(observedDoor(null, false), null);
    assert.deepEqual(observedDoor(null, true), { state: "closed", name: null, opensWith: null });
});

test("recording addresses the observed exit by identity and preserves its metadata", async () => {
    const updates: unknown[] = [];
    const mapper = { setRoomExit: async (...args: unknown[]) => { updates.push(args); return null; } };
    const room = { areaId: "area", roomNumber: 3, exits: [
        { id: "secret-exit", place: "private", fromDirection: "North", door: { state: "closed", name: "gate", opensWith: "pull chain" } },
        { id: "plain", fromDirection: "South", door: null },
        { id: "locked", fromDirection: "East", door: { state: "locked" } },
    ] } as unknown as Room;
    await recordObservedDoors(mapper, room, [
        { direction: "North", closed: false }, { direction: "South", closed: false }, { direction: "East", closed: true },
    ]);
    assert.deepEqual(updates, [["area", 3, "secret-exit", { door: { state: "open", name: "gate", opensWith: "pull chain" } }]]);
});

test("ambiguous parallel exits and unseen exits are left intact", async () => {
    const mapper = { setRoomExit: async () => { assert.fail("must not guess"); return null; } };
    const room = { exits: [{ fromDirection: "North", door: null }, { fromDirection: "North", door: null }] } as unknown as Room;
    await recordObservedDoors(mapper, room, [{ direction: "North", closed: true }, { direction: "South", closed: true }]);
});
