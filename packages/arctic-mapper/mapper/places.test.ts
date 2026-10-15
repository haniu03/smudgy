import assert from "node:assert/strict";
import test from "node:test";
import { areaNotes, NoteDrafts, notesLinks, orderedPlaces, placeColor, placeName, roomNotes } from "./places.ts";
import { colorAtHue, paletteColor } from "./palette.ts";

const secret = (id: string, name: string, color: string | null = null) => ({ id, name, color } as Secret);
const alpha = secret("a", "Alpha"), zeta = secret("z", "zeta");

test("notes, links and the picker use Private, alphabetical Secrets, Map", () => {
    const entries = [
        { source: "map" as const, data: "map1,map2" },
        { source: zeta, data: "zeta" },
        { source: "private" as const, data: "private1,private2" },
        { source: alpha, data: "alpha" },
    ];
    const room = { combinedData: () => entries };
    assert.deepEqual(roomNotes(room).map(e => placeName(e.source)), ["Private", "Alpha", "zeta", "Map"]);
    assert.deepEqual(notesLinks(room, text => text.split(",")), ["private1", "private2", "alpha", "zeta", "map1", "map2"]);
    assert.deepEqual(orderedPlaces({ places: entries.map(e => e.source) }).map(placeName), ["Private", "Alpha", "zeta", "Map"]);
    assert.equal(entries[0].source, "map", "reading must not mutate the host's snapshot");
    assert.deepEqual(notesLinks(null, () => ["unexpected"]), []);
});

test("a place with text but no links falls through to the next place", () => {
    const room = { combinedData: () => [
        { source: "private" as const, data: "no links" },
        { source: zeta, data: "<z>" },
        { source: alpha, data: "<a>" },
        { source: "map" as const, data: "<m>" },
    ] };
    const extract = (text: string) => [...text.matchAll(/<(.+?)>/g)].map(match => match[1]);
    assert.deepEqual(notesLinks(room, extract), ["a", "z", "m"]);
});

test("area notes stay separate, including empty notes and duplicate Secret names", () => {
    const a2 = secret("b", "Alpha");
    const map = {
        places: ["map", zeta, a2, "private", alpha] as MapPlace[],
        in: (place: MapPlace) => ({ data: () => place === "map" ? undefined : place === "private" ? "" : "note" }) as AreaView,
    };
    assert.deepEqual(areaNotes(map).map(e => e.source), ["private", alpha, a2, zeta]);
});

test("drafts are independent and survive switching without copying between audiences", () => {
    const drafts = new NoteDrafts();
    assert.equal(drafts.value("private", () => "private saved"), "private saved");
    drafts.set("private", "private draft");
    assert.equal(drafts.value(alpha, () => undefined), "");
    drafts.set(alpha, "secret draft");
    assert.equal(drafts.value("map", () => "public saved"), "public saved");
    assert.equal(drafts.value("private", () => "new snapshot"), "private draft");
    assert.equal(drafts.value(secret("a", "Renamed"), () => "new snapshot"), "secret draft");
});

test("badge colors match the editor's chosen colors and palette positions", () => {
    const bookcase = secret("book", "Behind The Bookcase");
    const map = { name: "Midgaard", places: ["map", zeta, "private", bookcase] as MapPlace[] };
    assert.equal(placeColor(map, bookcase), "#eb9f2c");
    assert.equal(placeColor(map, zeta), paletteColor(["Midgaard", "Behind The Bookcase"], 1));
    assert.equal(placeColor(map, "private"), paletteColor(["Midgaard", "Behind The Bookcase"], 2));
    assert.equal(placeColor(map, secret("book", "Behind The Bookcase", "#123456")), "#123456");
    assert.equal(paletteColor(["Midgaard", "Behind The Bookcase"], 4), "#8d9d09");
    assert.equal(paletteColor(["The Wardens"], 1), "#78b4ff");
});

test("palette matches all 30 Rust golden colors and repeats", () => {
    const expected = [
        "#fc85ad", "#00cdb4", "#e1bd53", "#7593fe", "#db703b", "#60d4fe", "#74b24c",
        "#dda4f7", "#0098a2", "#c15ba8", "#64f0a7", "#ffbeba", "#9c8600", "#00a062",
        "#d49d7c", "#c5cdff", "#8977c8", "#128be0", "#39b5ff", "#e76886", "#baaf00",
        "#16b09b", "#bd76db", "#5ea3be", "#9ccf7f", "#aca2da", "#b1945e", "#e282da",
        "#9bbeff", "#00c0d7",
    ];
    assert.deepEqual(expected.map((_, i) => colorAtHue(0, i)), expected);
    assert.equal(colorAtHue(0, 30), expected[0]);
});
