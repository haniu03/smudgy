import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as layoutModel from "../../map-layout/model.ts";
import * as layoutGeometry from "../../map-layout/layout.ts";
import { layoutSnapshotKey } from "../../map-layout/stable-snapshot.ts";

const aliases = new Map<string, { pattern: RegExp; run: Function }>();
const hotkeys = new Map<string, Function>();
const noteSends: [number, string][] = [];
const sessions = [11, 22, 33].map(id => ({ id, send: (command: string) => noteSends.push([id, command]) }));
const currentSession = sessions[1];
let noteEntries: RoomPlaceData[] = [];
const noteLinks = new Map<string, { label: string; url: string }[]>();
const sent: string[] = [], captures: boolean[] = [];
const rooms = [1, 2, 3].map(roomNumber => ({
    areaId: "area", roomNumber, title: `Room ${roomNumber}`, exits: [], combinedData: () => noteEntries,
} as unknown as Room));
const area = { id: "area", name: "Area", room: (number: number) => rooms[number - 1] } as Area;
let path: [string, number][] = [];
globalThis.__movementTest = {
    core: {
        mapper: { getCurrentLocation: () => undefined, getAreaById: () => area, getPathBetweenRooms: () => path },
        echo() {}, send: currentSession.send, sendRaw: (command: string) => sent.push(command),
        getSessions: () => sessions, session: currentSession,
        capture: (value: boolean) => captures.push(value), buffer: {}, line: {},
        createAlias: (pattern: string | RegExp, run: Function, options: { name: string }) =>
            aliases.set(options.name, { pattern: typeof pattern === "string" ? new RegExp(pattern) : pattern, run }),
        createTrigger() {}, createHotkey: (key: { key: string; modifiers: string[] }, run: Function) =>
            hotkeys.set([...key.modifiers, key.key].join("+"), run),
    },
    params: { get: () => undefined },
    events: { room: { on() {} } },
    prompt: { on() {} },
    widgets: { extractMarkdownLinks: (text: string) => noteLinks.get(text) ?? [] },
    widget: { requestExistingRoomConnection() {} },
    layout: { ...layoutModel, ...layoutGeometry, layoutSnapshotKey, planAreaChange() {}, loadLayoutModel() {} },
};
const mocks = new Map([
    ["smudgy:core", "core"], ["smudgy:params", "params"], ["smudgy:events/map", "events"],
    ["smudgy:events/kapusniak/arctic-prompt/prompt", "prompt"],
    ["smudgy:widgets", "widgets"], ["./widget.tsx", "widget"], ["smudgy:@map-layout", "layout"],
]);
registerHooks({
    resolve(specifier, context, next) {
        const name = mocks.get(specifier);
        return name ? { url: `movement-test:${name}`, shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
        if (url.startsWith("movement-test:")) {
            const name = url.slice("movement-test:".length);
            const source = name === "prompt" ? "export default globalThis.__movementTest.prompt;"
                : Object.keys(globalThis.__movementTest[name]).map(key =>
                    `export const ${key} = globalThis.__movementTest.${name}.${key};`).join("\n");
            return { format: "module", source, shortCircuit: true };
        }
        if (/\/(mapper|alias)\.ts$/.test(url)) return { format: "module", shortCircuit: true,
            source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" }) };
        return next(url, context);
    },
});
const { state, State, Direction, MoveCommands, speedwalk } = await import("./mapper.ts");
await import("./alias.ts");

/** The matches the host hands an alias or trigger body: every numbered and named group, an
 *  optional group that did not take part reading "". */
function hostMatches(match: RegExpExecArray): Record<string, string> {
    const values: Record<string, string> = {};
    match.forEach((value, index) => { values[index] = value ?? ""; });
    for (const [name, value] of Object.entries(match.groups ?? {})) values[name] = value ?? "";
    return values;
}
function move(input: string) {
    const alias = aliases.get("mapper_captureMovements")!;
    const match = alias.pattern.exec(input);
    if (!match) return false;
    alias.run(hostMatches(match));
    return true;
}
const exit = (fromDirection: string, toRoomNumber: number, extra = {}) => ({
    fromDirection, toAreaId: "area", toRoomNumber, door: null, command: null, ...extra,
}) as Exit;
beforeEach(() => {
    sent.length = 0; captures.length = 0; path = [];
    noteSends.length = 0; noteEntries = []; noteLinks.clear();
    for (const room of rooms) room.exits.length = 0;
    state.clearMoveQueue(); state.state = State.Following;
    state.area = area; state.room = rooms[0]; state.seenExits = null;
});

test("note hotkeys send the initiating room's first link locally, to all, or to other sessions", () => {
    noteEntries = [{ source: "map", data: "public" }, { source: "private", data: "personal" }];
    noteLinks.set("public", [{ label: "Public link", url: "east" }]);
    noteLinks.set("personal", [{ label: "Private link", url: "open gate;north" }]);
    const command = "open gate;north";
    hotkeys.get("ctrl+Enter")!();
    assert.deepEqual(noteSends, [[22, command]]);
    noteSends.length = 0;
    hotkeys.get("ctrl+alt+Enter")!();
    assert.deepEqual(noteSends, [[11, command], [22, command], [33, command]]);
    noteSends.length = 0;
    hotkeys.get("ctrl+shift+Enter")!();
    assert.deepEqual(noteSends, [[11, command], [33, command]]);
    noteSends.length = 0;
    aliases.get("mapper")!.run({ args: "send_link" });
    assert.deepEqual(noteSends, [[22, command]], "map send_link remains local");
});

test("note hotkeys send nothing to any session when the room has no links", () => {
    for (const key of ["ctrl+Enter", "ctrl+alt+Enter", "ctrl+shift+Enter"]) hotkeys.get(key)!();
    assert.deepEqual(noteSends, []);
});

test("the reported direction commands queue their direction and pass through", () => {
    const inputs = ["north alone", "n a", "nor alo", "n alon", "nort al", "d a", "down", "up", "u", "s", "e"];
    for (const input of inputs) assert.ok(move(input), input);
    assert.deepEqual(state.moveQueue, [Direction.North, Direction.North, Direction.North, Direction.North,
        Direction.North, Direction.Down, Direction.Down, Direction.Up, Direction.Up, Direction.South, Direction.East]);
    assert.deepEqual(captures, inputs.map(() => false));
    assert.deepEqual(sent, []);
});

test("every supported direction abbreviation accepts each alone abbreviation", () => {
    for (const [command, intent] of Object.entries(MoveCommands)) {
        if (intent === "look") continue;
        for (const modifier of ["a", "al", "alo", "alon", "alone"]) {
            assert.ok(move(`${command} ${modifier}`));
            assert.equal(state.popMoveCommand(), intent);
        }
    }
    assert.ok(move("n\talo  "));
    assert.equal(state.popMoveCommand(), Direction.North);
});

test("look arguments and unrelated movement arguments are not captured", () => {
    for (const input of ["look alone", "l a", "n around", "n alone now", "northward", "n alonely"]) {
        assert.equal(move(input), false, input);
    }
    for (const input of ["l", "lo", "loo", "look"]) assert.ok(move(input));
    assert.deepEqual(state.moveQueue, ["look", "look", "look", "look"]);
});

test("active mode opens the door and preserves explicit solo movement", () => {
    state.state = State.Active;
    rooms[0].exits.push(exit("North", 2, {
        door: { state: "closed", name: "gate", opensWith: "unlock gate;open gate" }, command: "enter gate",
    }));
    assert.ok(move("n a"));
    assert.deepEqual(state.moveQueue, [Direction.North]);
    assert.deepEqual(sent, ["unlock gate\n", "open gate\n"]);
    assert.deepEqual(captures, [false]);
    sent.length = 0; captures.length = 0;
    assert.ok(move("n"));
    assert.deepEqual(sent, ["unlock gate\n", "open gate\n", "enter gate\n"]);
    assert.deepEqual(captures, []);
});

test("solo speedwalks apply alone to each direction without changing door commands", () => {
    rooms[0].exits.push(exit("North", 2, { door: { state: "closed", name: "gate", opensWith: null } }));
    rooms[1].exits.push(exit("Up", 3));
    path = [["area", 1], ["area", 2], ["area", 3]];
    assert.equal(speedwalk(rooms[2], rooms[0], true), 2);
    assert.deepEqual(sent, ["open gate n\n", "n alone\n", "u alone\n"]);
});

test("solo speedwalks preserve custom commands and modify only bare directions within them", () => {
    rooms[0].exits.push(exit("North", 2, { command: "say ready;n;enter hole;down alone;look" }));
    path = [["area", 1], ["area", 2]];
    speedwalk(rooms[1], rooms[0], true);
    assert.deepEqual(sent, ["say ready\n", "n alone\n", "enter hole\n", "down alone\n", "look\n"]);
    sent.length = 0;
    speedwalk(rooms[1], rooms[0]);
    assert.deepEqual(sent, ["say ready\n", "n\n", "enter hole\n", "down alone\n", "look\n"]);
});
