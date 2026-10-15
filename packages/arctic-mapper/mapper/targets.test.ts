import assert from "node:assert/strict";
import { test } from "node:test";
import { TargetRegistry } from "./targets.ts";

const location = { areaId: "map-area", roomNumber: 12 };

test("target names match without case, prefer exact matches, and reject ambiguous prefixes", () => {
    const targets = new TargetRegistry();
    targets.set({ name: " Zurek ", location });
    targets.set({ name: "Zurek's camp", location: { areaId: "secret-area", roomNumber: 3 } });
    assert.equal(targets.find("ZUREK").location.roomNumber, 12);
    assert.equal(targets.find("zurek's").location.areaId, "secret-area");
    assert.throws(() => targets.find("z"), /matches Zurek, Zurek's camp/);
    assert.throws(() => targets.find("missing"), /No speedwalk target/);
    assert.throws(() => targets.find(""), /No speedwalk target/);
});

test("setting replaces a name, copies the address, and null removes it", () => {
    const targets = new TargetRegistry();
    const address = { ...location };
    targets.set({ name: "camp", location: address });
    address.roomNumber = 99;
    assert.equal(targets.find("c").location.roomNumber, 12);
    targets.set({ name: "CAMP", location: { areaId: "private-area", roomNumber: 2 } });
    assert.deepEqual(targets.find("camp").location, { areaId: "private-area", roomNumber: 2 });
    targets.set({ name: "cAmP", location: null });
    assert.throws(() => targets.find("camp"), /No speedwalk target/);
});

test("session movement and renames replace the previous automatic target", () => {
    const targets = new TargetRegistry();
    targets.set({ name: "Zurek", location }, 2);
    targets.set({ name: "Zurek", location: { ...location, roomNumber: 13 } }, 2);
    assert.equal(targets.find("z").location.roomNumber, 13);
    targets.set({ name: "Kapusniak", location }, 2);
    assert.throws(() => targets.find("z"), /No speedwalk target/);
    assert.equal(targets.find("k").name, "Kapusniak");
    targets.set({ name: "Kapusniak", location: null }, 2);
    assert.throws(() => targets.find("k"), /No speedwalk target/);
});

test("removing a session preserves a target since replaced by another owner", () => {
    const targets = new TargetRegistry();
    targets.set({ name: "camp", location }, 1);
    targets.set({ name: "camp", location: { ...location, roomNumber: 2 } }, 2);
    targets.removeSession(1);
    assert.equal(targets.find("camp").location.roomNumber, 2);
    targets.set({ name: "camp", location: { ...location, roomNumber: 3 } });
    targets.removeSession(2);
    assert.equal(targets.find("camp").location.roomNumber, 3);
});

test("invalid procedure payloads fail before replacing an existing target", () => {
    const targets = new TargetRegistry();
    targets.set({ name: "camp", location });
    for (const request of [null, {}, { name: " " }, { name: "camp" },
        { name: "camp", location: { roomNumber: 1 } },
        { name: "camp", location: { areaId: "", roomNumber: 1 } },
        ...[0, -1, 1.5, NaN, Infinity, 2147483648, "1"].map(roomNumber =>
            ({ name: "camp", location: { areaId: "map-area", roomNumber } })),
    ]) assert.throws(() => targets.set(request as any), TypeError);
    assert.deepEqual(targets.find("camp").location, location);
});
