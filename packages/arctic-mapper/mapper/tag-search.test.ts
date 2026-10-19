import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as layoutModel from "../../map-layout/model.ts";
import * as layoutGeometry from "../../map-layout/layout.ts";
import { layoutSnapshotKey } from "../../map-layout/stable-snapshot.ts";
import { findAreaByName, findNearestRoomWithTagsInArea } from "./tag-search.ts";
import { targets } from "./targets.ts";

const aliases = new Map<string, { pattern: RegExp; run: Function }>();
const messages: string[] = [], walks: Room[] = [];
const soloWalks: boolean[] = [];
const rooms = new Map<string, Room>(), areas: Area[] = [];
const routes = new Map<string, [AreaId, RoomNumber][]>();
const state = { room: null as Room | null, area: null as Area | null };
let globalSearches = 0;
let walkLength = 1;
const targetNames = new Set<string>();
const key = (area: string, number: number) => `${area}#${number}`;
const mapper = {
    areas,
    getAreaById: (id: string) => areas.find(area => area.id === id)!,
    getPathBetweenRooms: (_from: string, _number: number, to: string, number: number) => routes.get(key(to, number)) ?? [],
    findNearestRoomWithTags: (_here: Room, { all = [], none = [] }: { all?: string[]; none?: string[] }) => {
        globalSearches++;
        const room = state.room;
        const has = (tag: string) => !!room?.tags.includes(tag.toUpperCase());
        return room && all.every(has) && !none.some(has) ? room : undefined;
    },
    findNearestRoomInArea: (_here: Room, area: Area) => area.room(area.roomNumbers[0]),
};

// Exercise the registered alias itself, including its actual pattern, without
// loading panes or sending movement commands to a live game.
globalThis.__tagSearchTest = {
    core: {
        mapper, Matches: undefined, echo: (text: string) => messages.push(text),
        createAlias: (pattern: RegExp, run: Function, options: { name: string }) => aliases.set(options.name, { pattern, run }),
        createHotkey() {}, createTrigger() {}, send() {}, sendRaw() {}, capture() {},
        getSessions: () => [], session: { id: 1 },
        buffer: {}, line: {},
    },
    mapper: {
        state, speedwalk: (room: Room, _from: Room, alone = false) => { walks.push(room); soloWalks.push(alone); return walkLength; },
        distanceBetweenRooms: (a: Room, b: Room) => Math.abs(a.x - b.x),
        debugLog() {}, findRoomsAt() {}, idsMatch() {}, linkRooms() {},
        options: {}, parseRoomExits() {}, parseRoomExitsDetailed() {},
        roomsImpactedByPush() {}, State: {}, ZMode: {},
        Direction: {}, DirectionLetter: {}, MoveCommands: {}, OppositeDirection: {},
    },
    events: { RoomEvent: undefined, mapEvent: { on() {} } },
    mapEvents: { areasLoaded: { on() {} } },
    widget: { requestExistingRoomConnection() {} },
    widgets: { extractMarkdownLinks() {} },
    layout: { ...layoutModel, ...layoutGeometry, layoutSnapshotKey, planAreaChange() {}, loadLayoutModel() {} },
    prompt: { on() {} },
};
const mocks = new Map([
    ["smudgy:core", "core"], ["smudgy:widgets", "widgets"],
    ["smudgy:@map-layout", "layout"], ["./mapper.ts", "mapper"],
    ["./events.ts", "events"], ["./widget.tsx", "widget"],
    ["smudgy:events/map", "mapEvents"],
    ["smudgy:events/kapusniak/arctic-prompt/prompt", "prompt"],
]);
registerHooks({
    resolve(specifier, context, next) {
        const name = context.parentURL?.endsWith("/alias.ts") ? mocks.get(specifier) : undefined;
        return name ? { url: `tag-search-test:${name}`, shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
        if (url.startsWith("tag-search-test:")) {
            const name = url.slice("tag-search-test:".length);
            const source = name === "prompt" ? "export default globalThis.__tagSearchTest.prompt;"
                : Object.keys(globalThis.__tagSearchTest[name]).map(key =>
                    `export const ${key} = globalThis.__tagSearchTest.${name}.${key};`).join("\n");
            return { format: "module", source, shortCircuit: true };
        }
        if (url.endsWith("/alias.ts")) return { format: "module", shortCircuit: true,
            source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" }) };
        return next(url, context);
    },
});
await import("./alias.ts");

function makeArea(id: string, name: string) {
    const area = {
        id, name, roomNumbers: [] as number[],
        room: (number: number) => rooms.get(key(id, number)),
        findRoomsWithTag: (tag: string) => [...rooms.values()].filter(room =>
            room.areaId === id && room.hasTag(tag)),
    } as unknown as Area;
    areas.push(area);
    return area;
}
function makeRoom(area: Area, number: number, tags: string[], cost?: number) {
    const room = { areaId: area.id, roomNumber: number, tags, x: number, exits: [],
        hasTag: (tag: string) => tags.includes(tag.toUpperCase()),
    } as unknown as Room;
    rooms.set(key(area.id, number), room);
    area.roomNumbers.push(number);
    if (cost !== undefined && state.room) {
        state.room.exits.push({ toAreaId: area.id, toRoomNumber: number, weight: cost } as Exit);
        routes.set(key(area.id, number), [[state.room.areaId, state.room.roomNumber], [area.id, number]]);
    }
    return room;
}
/** The matches the host hands an alias or trigger body: every numbered and named group, an
 *  optional group that did not take part reading "". */
function hostMatches(match: RegExpExecArray): Record<string, string> {
    const values: Record<string, string> = {};
    match.forEach((value, index) => { values[index] = value ?? ""; });
    for (const [name, value] of Object.entries(match.groups ?? {})) values[name] = value ?? "";
    return values;
}
function run(input: string) {
    const matched = ["speedwalk_tag", "speedwalk_area", "speedwalk_target"].map(name => aliases.get(name)!)
        .filter(alias => alias.pattern.test(input));
    assert.equal(matched.length, 1, `exactly one speedwalk alias handles ${input}`);
    const alias = matched[0];
    alias.run(hostMatches(alias.pattern.exec(input)!));
}
beforeEach(() => {
    rooms.clear(); areas.length = 0; routes.clear(); walks.length = 0; messages.length = 0; soloWalks.length = 0;
    globalSearches = 0; walkLength = 1; state.room = null;
    state.area = makeArea("home", "Home");
    state.room = makeRoom(state.area, 1, ["FOO", "DR_LOCAL"]);
});
afterEach(() => {
    for (const name of targetNames) targets.set({ name, location: null });
    targetNames.clear();
});
function setTarget(name: string, room: Room) {
    targetNames.add(name);
    targets.set({ name, location: { areaId: room.areaId, roomNumber: room.roomNumber } });
}

test(">foo@bar scopes the tag search and prefers an exact area name over a prefix", () => {
    const longer = makeArea("barley", "Barley");
    makeRoom(longer, 1, ["FOO"], 1);
    const bar = makeArea("bar", "Bar");
    const target = makeRoom(bar, 1, ["FOO"], 4);
    run(">foo@bAr");
    assert.deepEqual(walks, [target]);
    assert.equal(globalSearches, 0);
});

test("area prefixes and names containing spaces use the existing matching rule", () => {
    const area = makeArea("lodge", "Traveler's Lodge");
    const target = makeRoom(area, 1, ["INN"], 2);
    run(">inn@Traveler's L");
    assert.deepEqual(walks, [target]);
    assert.equal(findAreaByName(areas, "  travel  "), area);
});

test("each typed word can start the same word of an area name", () => {
    const valley = makeArea("valley", "Lost Valley");
    makeRoom(valley, 1, ["INN"], 1);
    const village = makeArea("village", "Lost Village");
    const target = makeRoom(village, 1, ["INN"], 2);
    run(">@l vi");
    run(">inn@lo  vil");
    run(">@L Vi a");
    assert.deepEqual(walks, [target, target, target]);
    assert.deepEqual(soloWalks, [false, false, true]);
    assert.equal(findAreaByName(areas, "vi"), undefined, "words match from the name's first");
    assert.equal(findAreaByName(areas, "l vi x"), undefined, "more words than the name has");
});

test("a name that starts with the text beats one matched word by word", () => {
    makeArea("hollow", "Muddy Hollow");
    const hut = makeArea("hut", "Mud Hut");
    assert.equal(findAreaByName(areas, "mud h"), hut);
    assert.equal(findAreaByName(areas, "mu ho")?.name, "Muddy Hollow");
});

test("compound filters require all tags and reject excluded tags", () => {
    const bar = makeArea("bar", "Bar");
    makeRoom(bar, 1, ["INN", "SHOP", "PEACE"], 1);
    makeRoom(bar, 2, ["INN"], 2);
    const target = makeRoom(bar, 3, ["INN", "SHOP"], 3);
    run(">inn.shop.!peace@bar");
    assert.deepEqual(walks, [target]);
});

test("tag abbreviations expand only in the target area and compare route costs", () => {
    const bar = makeArea("bar", "Bar");
    makeRoom(bar, 1, ["DRUID_GUILD"], 10);
    const target = makeRoom(bar, 99, ["DRUID_STUDY"], 2);
    run(">dr@bar");
    assert.deepEqual(walks, [target]);
    assert.deepEqual(messages, ["Matched DRUID_STUDY."]);
    assert.equal(globalSearches, 0);
});

test("unreachable and missing scoped matches do not fall back to global tags", () => {
    const bar = makeArea("bar", "Bar");
    makeRoom(bar, 1, ["FOO"]);
    run(">foo@bar");
    run(">inn@bar");
    run(">foo@missing");
    assert.deepEqual(walks, []);
    assert.equal(globalSearches, 0);
    assert.deepEqual(messages, [
        "No room matching >FOO@Bar is reachable from here.",
        "No room matching >INN@Bar is reachable from here.",
        'No area name starts with "missing".',
    ]);
});

test("an unscoped tag that matches nothing reports the tag, not a missing area", () => {
    run(">nothing");
    run(">nothing@ ");
    assert.deepEqual(walks, []);
    assert.deepEqual(messages, [
        "No room matching >NOTHING is reachable from here.",
        "No room matching >NOTHING is reachable from here.",
    ]);
});

test("a matching current room is eligible and unqualified aliases retain their behavior", () => {
    run(">foo@home");
    run(">foo");
    run(">@home");
    assert.deepEqual(walks, [state.room, state.room, state.room]);
    assert.equal(globalSearches, 1);
});

test("scoped searches choose the cheapest reachable tag match", () => {
    const bar = makeArea("bar", "Bar");
    makeRoom(bar, 1, ["FOO"], 8);
    makeRoom(bar, 2, ["FOO"]);
    const target = makeRoom(bar, 3, ["FOO"], 2);
    run(">foo@bar");
    assert.deepEqual(walks, [target]);
});

test("scoped tag lookup includes the area's source-owned rooms", () => {
    const bar = makeArea("bar", "Bar");
    const secret = makeArea("secret", "Hidden Bar");
    const target = makeRoom(secret, 1, ["FOO"], 2);
    bar.findRoomsWithTag = () => [target];
    assert.equal(findNearestRoomWithTagsInArea(mapper, state.room!, bar, ["FOO"], []), target);
});

test("all speedwalk forms accept every abbreviation of the final alone argument", () => {
    const bar = makeArea("bar", "Bar");
    const target = makeRoom(bar, 1, ["FOO", "DRUID_GUILD"], 2);
    for (const modifier of ["a", "al", "alo", "alon", "alone"]) {
        run(`>foo ${modifier}`);
        run(`>foo@bar ${modifier}`);
        run(`>@bar ${modifier}`);
        run(`>dr@bar ${modifier}`);
        assert.deepEqual(walks.slice(-4), [state.room, target, target, target]);
        assert.deepEqual(soloWalks.slice(-4), [true, true, true, true]);
    }
    run(">foo@bar");
    assert.equal(soloWalks.at(-1), false);
});

test("the alone modifier follows an entire area name, including spaces", () => {
    const lodge = makeArea("lodge", "Traveler's Lodge");
    const target = makeRoom(lodge, 1, ["INN"], 2);
    run(">inn@Traveler's Lodge alon");
    run(">@Traveler's Lodge a");
    assert.deepEqual(walks, [target, target]);
    assert.deepEqual(soloWalks, [true, true]);
});

test("$ speedwalks resolve full names and prefixes to the exact Map, Private, or Secret room", () => {
    for (const place of ["map", "private", "secret"]) {
        const area = makeArea(`${place}-area`, "Same display name");
        const target = makeRoom(area, 1, []);
        setTarget("Zurek", target);
        run(">$ZUREK");
        run(">$z");
        assert.deepEqual(walks.slice(-2), [target, target]);
        for (const modifier of ["a", "al", "alo", "alon", "alone"]) {
            run(`>$z ${modifier}`);
            assert.equal(walks.at(-1), target);
            assert.equal(soloWalks.at(-1), true);
        }
    }
    assert.equal(globalSearches, 0);
});

test("$ speedwalks report ambiguous, missing, unavailable, and unreachable targets", () => {
    const area = makeArea("other", "Other");
    const target = makeRoom(area, 1, []);
    setTarget("Zurek", target);
    setTarget("Zebra", target);
    run(">$z");
    run(">$missing");
    setTarget("gone", { areaId: "missing", roomNumber: 1 } as Room);
    run(">$gone");
    assert.equal(walks.length, 0);
    walkLength = 0;
    run(">$zurek");
    assert.deepEqual(messages, [
        'Target "$z" matches Zebra, Zurek. Use a longer name.',
        'No speedwalk target matches "$missing".',
        'Target "gone" refers to a room unavailable in this session.',
        'Target "Zurek" is not reachable from here.',
    ]);
});

test("$ speedwalks explain already-arrived and unknown-current-location cases", () => {
    setTarget("camp", state.room!);
    run(">$c");
    assert.deepEqual(messages, ["You're already at camp."]);
    state.room = null;
    run(">$c a");
    assert.equal(walks.length, 0);
    assert.match(messages.at(-1)!, /current room/i);
});
