import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomChangeTracker } from "./room-change.ts";

const text = { title: "Hall", description: ["A long hallway."] };
const here = { areaId: "area", roomNumber: 1 };
const there = { areaId: "area", roomNumber: 2 };

test("initial observation and repeated looks do not change rooms, mapped or unmapped", () => {
    for (const location of [here, null]) {
        const tracker = new RoomChangeTracker();
        assert.equal(tracker.observe(text, undefined, location), null);
        assert.equal(tracker.observe(text, "look", location), null);
        assert.equal(tracker.observe({ title: " Hall ", description: ["A long", " hallway. "] }, undefined, location), null);
    }
});

test("directional moves detect identical mapped and unmapped rooms", () => {
    for (const location of [there, null]) {
        const tracker = new RoomChangeTracker();
        tracker.observe(text, undefined, location ? here : null);
        assert.deepEqual(tracker.observe(text, "North", location), {
            mapped: location !== null, areaId: location?.areaId ?? null,
            roomNumber: location?.roomNumber ?? null, title: "Hall",
        });
        assert.equal(tracker.observe(text, "look", location), null);
    }
});

test("known self-loops do not change rooms", () => {
    const tracker = new RoomChangeTracker();
    tracker.observe(text, undefined, here);
    assert.equal(tracker.observe(text, "North", here), null);
});

test("uncommanded relocation uses title and full description changes", () => {
    const tracker = new RoomChangeTracker();
    tracker.observe(text, undefined, null);
    assert.ok(tracker.observe({ ...text, title: "Forest" }, undefined, null));
    assert.ok(tracker.observe({ ...text, title: "Forest", description: ["A clearing."] }, undefined, null));
});

test("brief and full descriptions of the same room do not cause an extra reset", () => {
    const tracker = new RoomChangeTracker();
    tracker.observe(text, undefined, null);
    assert.equal(tracker.observe({ ...text, description: [] }, "look", null), null);
    assert.equal(tracker.observe(text, "look", null), null);
    assert.ok(tracker.observe({ ...text, description: [] }, "North", null));
    assert.equal(tracker.observe({ ...text, description: ["A different hallway."] }, "look", null), null);
});

test("map loading, losing a match, and editor renumbering alone are not movement", () => {
    const tracker = new RoomChangeTracker();
    tracker.observe(text, undefined, null);
    assert.equal(tracker.observe(text, "look", here), null);
    assert.equal(tracker.observe(text, "look", there), null);
    assert.equal(tracker.observe(text, "look", null), null);
});

test("dark or blind moves emit even without any room text or map", () => {
    const tracker = new RoomChangeTracker();
    tracker.observe(text, undefined, here);
    assert.deepEqual(tracker.observe(null, "North", null), {
        mapped: false, areaId: null, roomNumber: null, title: null,
    });
    assert.ok(tracker.observe(null, "North", null));
    assert.equal(tracker.observe(null, "look", null), null);
    assert.equal(tracker.observe(null, undefined, null), null);
    assert.equal(tracker.observe({ ...text, title: "Clearing" }, "look", null), null,
        "regaining vision must not report the same move twice");
});

test("mapped dark moves include the destination, and dark looks preserve the text baseline", () => {
    const tracker = new RoomChangeTracker();
    tracker.observe(text, undefined, here);
    assert.equal(tracker.observe(null, "look", here), null);
    assert.deepEqual(tracker.observe(null, "North", there), {
        mapped: true, ...there, title: null,
    });
    assert.equal(tracker.observe(null, "North", there), null, "mapped dark self-loop");
});

test("the first successful move counts even before a baseline, and reset forgets the old session", () => {
    const tracker = new RoomChangeTracker();
    assert.ok(tracker.observe(null, "North", null));
    tracker.observe(text, undefined, here);
    tracker.reset();
    assert.equal(tracker.observe({ ...text, title: "Elsewhere" }, undefined, there), null);
});
