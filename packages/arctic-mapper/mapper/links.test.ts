import assert from "node:assert/strict";
import test from "node:test";
import { extendExit, linkNeedsOtherPlace } from "./links.ts";

const area = "map-a" as AreaId;
const target = { fromDirection: "North", toDirection: "South", toAreaId: area, toRoomNumber: 2 } as const;
const stub = (changes: Partial<Exit> = {}) => ({
    id: "stub" as ExitId, place: "map", fromDirection: "North",
    toRoomNumber: null, toAreaId: null,
    door: { state: "locked", name: "gate", opensWith: "unlock gate;open gate" },
    command: "enter gate", isHidden: true, weight: 7, connectionId: "geometry",
    ...changes,
} as Exit);

function fixture(exits: Exit[], place: MapPlace = "map") {
    const updates: unknown[] = [], creates: unknown[] = [];
    const writer = {
        setRoomExit: async (number: Room | number, id: ExitIdLike, update: ExitUpdates) => { updates.push([number, id, update]); },
        createRoomExit: async (number: Room | number, args: ExitArgs) => { creates.push([number, args]); return "new" as ExitId; },
    };
    return { writer, updates, creates, room: { roomNumber: 1, place, exits } };
}

test("finding a link extends the existing stub with only its destination fields", async () => {
    const exit = stub();
    const f = fixture([exit]);
    assert.equal(await extendExit(f.writer, f.room, target), "stub");
    assert.deepEqual(f.updates, [[1, "stub", { toAreaId: area, toRoomNumber: 2, toDirection: "South" }]]);
    assert.deepEqual(f.creates, []);
    assert.equal(exit.door?.opensWith, "unlock gate;open gate");
    assert.equal(exit.command, "enter gate");
});

test("a source-owned room extends its own stub with independent room numbering", async () => {
    const place = { id: "secret" } as Secret;
    const f = fixture([stub({ place })], place);
    assert.equal(await extendExit(f.writer, f.room, { ...target, toAreaId: "secret-area" as AreaId }), "stub");
    assert.equal(f.creates.length, 0);
});

test("a stub that already names the destination map is completed with its room", async () => {
    const f = fixture([stub({ toAreaId: area })]);
    assert.equal(await extendExit(f.writer, f.room, target), "stub");
    assert.equal(f.creates.length, 0);
});

test("identical room numbers in different places are not the same destination", async () => {
    const other = stub({ toRoomNumber: 2, toAreaId: "secret-area" as AreaId });
    const f = fixture([other, stub()]);
    assert.equal(await extendExit(f.writer, f.room, target), "stub");
    assert.equal(f.updates.length, 1);
});

test("existing linked exits are reused and parallel links are retained", async () => {
    const f = fixture([stub({ ...target, id: "linked" as ExitId }), stub()]);
    assert.equal(await extendExit(f.writer, f.room, target), "linked");
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.creates, []);
});

test("an attached Private stub is extended in its own place instead of copied to Map", async () => {
    const f = fixture([stub({ place: "private" })]);
    assert.equal(linkNeedsOtherPlace(f.room, target), true);
    assert.equal(await extendExit(f.writer, f.room, target), "stub");
    assert.equal(f.updates.length, 1);
    assert.deepEqual(f.creates, []);
});

test("multiple unlinked exits are ambiguous even when they belong to different places", async () => {
    const ambiguous = fixture([stub(), stub({ id: "other" as ExitId, place: "private" })]);
    await assert.rejects(extendExit(ambiguous.writer, ambiguous.room, target), /Multiple unlinked/);
    assert.deepEqual(ambiguous.creates, []);
});
