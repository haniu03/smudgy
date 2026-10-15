import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as layoutModel from "../../map-layout/model.ts";
import * as layoutGeometry from "../../map-layout/layout.ts";
import { layoutSnapshotKey } from "../../map-layout/stable-snapshot.ts";
import { mapEvent } from "./events.ts";
import { RecordingPlaces } from "./recording-place.ts";

const areas = new Map<string, any>();
const writes: { area: string; kind: string; place?: MapPlace }[] = [];
const messages: string[] = [];
const aliases = new Map<string, Function>();
const layoutCalls: { area: string; change: any; options: any }[] = [];
let qualityMeasurements = 0;
let afterPlanning: (() => void) | undefined;
let sequence = 0;
let connectDecision: { type: string; roomNumber?: number } = { type: "create" };
let location: [string, number] | undefined;
let map: Area, secret: Secret, privateArea: Area, start: Room;

function makeArea(id: string, place: MapPlace, mapId?: string): Area {
    const rooms = new Map<number, any>();
    const area = { id, place, mapId, name: id, storage: "cloud", rooms,
        get roomNumbers() { return [...rooms.keys()]; },
        get nextRoomNumber() { return rooms.size + 1; },
        room: (number: number) => rooms.get(number),
    };
    areas.set(id, area);
    return area as unknown as Area;
}
function addRoom(area: Area, params: any): Room {
    const number = area.roomNumbers.length + 1;
    const room = { areaId: area.id, roomNumber: number, place: area.place,
        x: 0, y: 0, level: 0, title: "Room", description: "Description", ...params,
        exits: [], tags: [], data() {}, hasTag: () => false, combinedData: () => [],
        in: (place: MapPlace) => ({ createExit: async (exit: ExitArgs) => addExit(room as Room, place, exit) }),
    };
    areas.get(area.id).rooms.set(number, room);
    return room as Room;
}
function addExit(room: Room, place: MapPlace, args: ExitArgs): ExitId {
    const id = `exit-${++sequence}` as ExitId;
    writes.push({ area: room.areaId, kind: "exit", place });
    room.exits.push({ id, place, toAreaId: null, toRoomNumber: null, toDirection: null,
        door: null, ...args } as Exit);
    return id;
}
const mapper = {
    getCurrentLocation: () => undefined,
    getAreaById: (id: string) => { const area = areas.get(id); if (!area) throw new Error("Area not found"); return area; },
    setCurrentLocation: (area: string, room: number) => { location = [area, room]; },
    updateRooms: async (id: string, updates: [number, any][]) => {
        for (const [number, fields] of updates) Object.assign(areas.get(id).room(number), fields);
        writes.push({ area: id, kind: "layout" });
    },
    listRoomsByTitleAndDescription: (title: string, description: string) => [...areas.values()]
        .flatMap(area => [...area.rooms.values()]).filter(room => room.title === title && room.description === description),
    setRoomExit: async (id: string, number: number, exitId: string, update: ExitUpdates) => {
        const exit = areas.get(id).room(number).exits.find(e => e.id === exitId);
        assert.ok(exit); Object.assign(exit, update);
        writes.push({ area: id, kind: "update-exit", place: exit.place });
    },
    mutateArea: async (id: string, callback: Function) => {
        const area = mapper.getAreaById(id);
        await callback({
            createRoom: async (params: any) => {
                writes.push({ area: id, kind: "room" }); return addRoom(area, params).roomNumber;
            },
            createRoomExit: async (number: number, args: ExitArgs) => addExit(area.room(number), area.place, args),
            setRoomExit: (number: number, exitId: string, update: ExitUpdates) => mapper.setRoomExit(id, number, exitId, update),
            updateRooms: async (updates: [number, any][]) => {
                for (const [number, fields] of updates) Object.assign(area.room(number), fields);
                writes.push({ area: id, kind: "layout" });
            },
        });
    },
};
function loadLayoutModel(id: string) {
    const area = mapper.getAreaById(id);
    return layoutModel.resolveElevationGeometry({ areaId: id, rooms: area.roomNumbers.map(number => {
        const room = area.room(number);
        return { id: String(number), roomNumber: number, movable: !room.hasTag("LAYOUT_LOCKED"),
            position: { x: room.x, y: room.y, level: room.level } };
    }), edges: area.roomNumbers.flatMap(number => area.room(number).exits
        .filter(exit => exit.toAreaId === id && exit.toRoomNumber !== null)
        .map(exit => ({ from: String(number), to: String(exit.toRoomNumber), direction: exit.fromDirection }))) });
}
function plan(model: layoutModel.LayoutModel, change: any, options = {}) {
    layoutCalls.push({ area: model.areaId!, change, options });
    return layoutModel.planLayoutModel(model, change, options);
}
globalThis.__recordingFlow = {
    core: { mapper, echo: (message: string) => messages.push(message),
        createAlias: (_pattern: RegExp, callback: Function, options: any) => aliases.set(options.name, callback),
        createTrigger() {}, createHotkey() {}, send() {}, sendRaw() {}, capture() {}, buffer: {}, line: {},
        getSessions: () => [], session: { id: 1 },
    },
    params: { get: () => undefined }, events: { room: { on() {} } },
    prompt: { on() {} }, widgets: { extractMarkdownLinks: () => [] },
    widget: { requestExistingRoomConnection: async () => connectDecision },
    layout: { ...layoutModel, ...layoutGeometry, layoutSnapshotKey, loadLayoutModel, planLayoutModel: plan,
        measureIntegralLayoutQuality: (...args: Parameters<typeof layoutGeometry.measureIntegralLayoutQuality>) => {
            qualityMeasurements++;
            return layoutGeometry.measureIntegralLayoutQuality(...args);
        },
        planAreaChange: async (id: string, change: any, options: any) => {
            const model = loadLayoutModel(id);
            const result = { ...plan(model, change, options), sourceSnapshotKey: layoutSnapshotKey(model) };
            afterPlanning?.();
            return result;
        } },
};
const mocks = new Map([
    ["smudgy:core", "core"], ["smudgy:params", "params"], ["smudgy:events/map", "events"],
    ["smudgy:widgets", "widgets"], ["./widget.tsx", "widget"], ["smudgy:@map-layout", "layout"],
    ["smudgy:events/kapusniak/arctic-prompt/prompt", "prompt"],
]);
registerHooks({
    resolve(specifier, context, next) {
        const name = mocks.get(specifier);
        return name ? { url: `recording-flow:${name}`, shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
        if (url.startsWith("recording-flow:")) {
            const name = url.slice("recording-flow:".length);
            return { format: "module", shortCircuit: true, source: name === "prompt"
                ? "export default globalThis.__recordingFlow.prompt;"
                : Object.keys(globalThis.__recordingFlow[name]).map(key =>
                    `export const ${key} = globalThis.__recordingFlow.${name}.${key};`).join("\n") };
        }
        if (/\/(mapper|alias)\.ts$/.test(url)) return { format: "module", shortCircuit: true,
            source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" }) };
        return next(url, context);
    },
});
const { state, State, Direction, options, ZMode } = await import("./mapper.ts");
await import("./alias.ts");

beforeEach(() => {
    areas.clear(); writes.length = 0; messages.length = 0;
    layoutCalls.length = 0; qualityMeasurements = 0;
    afterPlanning = undefined;
    options.autoAdjustMapLayout = false; options.zMode = ZMode.Auto;
    connectDecision = { type: "create" }; location = undefined;
    map = makeArea(`map-${++sequence}`, "map");
    secret = { id: `secret-${sequence}`, name: "Exploration", actions: ["read", "add", "edit"], mapId: map.id } as Secret;
    Object.assign(secret, { area: makeArea(secret.id, secret, map.id) });
    privateArea = makeArea(`private-${sequence}`, "private", map.id);
    Object.assign(map, {
        places: ["map", secret, "private"],
        secrets: { get: (key: string) => { if (key === secret.id) return secret; throw new Error("Secret not found"); } },
        in: (place: MapPlace) => ({ area: place === "private" ? privateArea : place === "map" ? map : secret.area }),
    });
    start = addRoom(map, { title: "Entrance" });
    state.state = State.Following; state.area = map; state.room = start;
    state.state = State.Mapping; state.clearMoveQueue();
});
async function arrive(direction: string, title: string, exits = "NS") {
    state.captureMoveCommand(direction as any);
    mapEvent.emit("room", { title, description: ["Description"], exits, objects: [], mobs: [],
        line_number: 1, prompt_line_number: 2, prompt: "" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(messages.some(message => message.startsWith("Automatic map update failed")), false, messages.join("\n"));
}

test("recording creates its first room in the selected Secret and extends the Map stub intact", async () => {
    state.selectRecordingPlace(map, secret);
    const id = addExit(start, "map", { fromDirection: "North", door: { state: "locked", name: "gate", opensWith: "unlock gate;open gate" }, command: "enter gate", weight: 7 });
    await arrive(Direction.North, "Hidden room", "(S)N");
    assert.equal(state.room!.areaId, secret.id);
    assert.equal(state.room!.roomNumber, 1, "numbering is independent of map room 1");
    assert.equal(map.roomNumbers.length, 1);
    const forward = start.exits.find(exit => exit.id === id)!;
    assert.equal(forward.toAreaId, secret.id); assert.equal(forward.toRoomNumber, 1);
    assert.deepEqual(forward.door, { state: "locked", name: "gate", opensWith: "unlock gate;open gate" });
    assert.equal(forward.command, "enter gate"); assert.equal(forward.weight, 7);
    const back = state.room!.exits.find(exit => exit.fromDirection === "South")!;
    assert.equal(back.toAreaId, map.id); assert.equal(back.toRoomNumber, start.roomNumber);
    assert.equal(back.door?.state, "closed");
    assert.equal(writes.filter(write => write.kind === "room").every(write => write.area === secret.id), true);
});

test("new Private entrance exits belong to Private and the choice survives a return to Map", async () => {
    state.selectRecordingPlace(map, "private");
    await arrive(Direction.North, "Private room");
    assert.equal(state.room!.areaId, privateArea.id);
    assert.equal(start.exits[0].place, "private");
    await arrive(Direction.South, "Entrance");
    assert.equal(state.room!.areaId, map.id);
    await arrive(Direction.East, "Another private room", "W");
    assert.equal(state.room!.areaId, privateArea.id);
    assert.equal(privateArea.roomNumbers.length, 2);
    assert.equal(map.roomNumbers.length, 1);
});

test("a link out of a Secret's room into a new Map room belongs to the Secret", async () => {
    state.selectRecordingPlace(map, secret);
    // An unlisted way north leaves no stub to extend.
    await arrive(Direction.North, "Hidden room", "S");
    const hidden = state.room!;
    assert.equal(hidden.areaId, secret.id);
    state.selectRecordingPlace(map, "map");
    await arrive(Direction.North, "Courtyard", "S");
    assert.equal(state.room!.areaId, map.id);
    const forward = hidden.exits.find(exit => exit.fromDirection === "North" && exit.toRoomNumber !== null)!;
    assert.equal(forward.place, secret, "the Secret's room keeps its own exit");
    assert.equal(forward.toAreaId, map.id); assert.equal(forward.toRoomNumber, state.room!.roomNumber);
    assert.equal(writes.some(write => write.kind === "exit" && write.area === secret.id && write.place === "map"), false);
});

test("a link out of a Private room into a new Secret room belongs to Private", async () => {
    state.selectRecordingPlace(map, "private");
    await arrive(Direction.North, "Private room", "S");
    const mine = state.room!;
    assert.equal(mine.areaId, privateArea.id);
    state.selectRecordingPlace(map, secret);
    await arrive(Direction.North, "Hidden room", "S");
    assert.equal(state.room!.areaId, secret.id);
    const forward = mine.exits.find(exit => exit.fromDirection === "North" && exit.toRoomNumber !== null)!;
    assert.equal(forward.place, "private");
    assert.equal(forward.toAreaId, secret.id);
});

test("switching the dropdown redirects later rooms without moving existing rooms", async () => {
    state.selectRecordingPlace(map, secret);
    await arrive(Direction.North, "Secret room");
    state.selectRecordingPlace(map, "map");
    await arrive(Direction.East, "Public room", "W");
    assert.equal(state.room!.areaId, map.id);
    assert.equal(map.roomNumbers.length, 2);
    assert.equal(secret.area.roomNumbers.length, 1);
});

test("subsequent rooms and their existing stubs stay in the selected Secret", async () => {
    state.selectRecordingPlace(map, secret);
    await arrive(Direction.North, "Secret entrance");
    const entrance = state.room!;
    const stub = entrance.exits.find(exit => exit.fromDirection === "North")!;
    await arrive(Direction.North, "Secret corridor");
    assert.equal(state.room!.areaId, secret.id);
    assert.equal(entrance.exits.find(exit => exit.id === stub.id)!.toRoomNumber, state.room!.roomNumber);
    assert.equal(entrance.exits.filter(exit => exit.fromDirection === "North").length, 1);
    assert.equal(map.roomNumbers.length, 1);
});

test("connecting an existing room across places does not create a duplicate or conflate room numbers", async () => {
    state.selectRecordingPlace(map, secret);
    const existing = addRoom(secret.area, { title: "Known secret", x: 5, y: 0 });
    addExit(existing, secret, { fromDirection: "South" });
    connectDecision = { type: "connect", roomNumber: existing.roomNumber };
    await arrive(Direction.North, "Known secret");
    assert.equal(state.room, existing);
    assert.equal(secret.area.roomNumbers.length, 1);
    assert.equal(start.exits[0].toAreaId, secret.id);
    assert.equal(existing.exits[0].toAreaId, map.id);
});

test("refresh bootstraps an unknown room in the chosen place and updates the location marker", async () => {
    state.room = null;
    state.selectRecordingPlace(map, "private");
    aliases.get("mapper")!({ args: "refresh" });
    await arrive("look", "Private starting room");
    assert.equal(state.room!.areaId, privateArea.id);
    assert.deepEqual(location, [privateArea.id, 1]);
    assert.equal(map.roomNumbers.length, 1);
    assert.equal(messages.some(message => message.startsWith("Map refresh failed")), false, messages.join("\n"));
});

test("selection rejects read-only or missing places and does not silently reset to Map", () => {
    state.selectRecordingPlace(map, secret);
    const selected = new RecordingPlaces();
    const readOnly = { ...secret, actions: ["read"] } as Secret;
    assert.throws(() => selected.select(map, readOnly), /permission to add and edit/);
    map.secrets.get = () => { throw new Error("Secret not found"); };
    assert.throws(() => state.recordingDestination(), /Secret not found/);
    state.selectRecordingPlace(map, "map");
    assert.equal(state.recordingDestination().area.id, map.id);
});

test("an ambiguous entrance fails before creating an orphan room in another place", async () => {
    state.selectRecordingPlace(map, "private");
    addExit(start, "map", { fromDirection: "North" });
    addExit(start, "private", { fromDirection: "North" });
    state.captureMoveCommand(Direction.North);
    mapEvent.emit("room", { title: "Unmapped", description: ["Description"], exits: "S", objects: [], mobs: [],
        line_number: 1, prompt_line_number: 2, prompt: "" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(privateArea.roomNumbers.length, 0);
    assert.ok(messages.some(message => message.includes("Multiple unlinked North exits")), messages.join("\n"));
});

const position = (room: Room) => ({ x: room.x, y: room.y, level: room.level });

test("automatic adjustment off records past an occupied cell without scoring or moving residents", async () => {
    const occupant = addRoom(map, { title: "Other room", x: 0, y: -1 });
    const stub = addExit(start, "map", { fromDirection: "North", command: "climb steps" });
    await arrive(Direction.North, "New room");
    assert.deepEqual(position(state.room!), { x: 0, y: -2, level: 0 });
    assert.deepEqual(position(start), { x: 0, y: 0, level: 0 });
    assert.deepEqual(position(occupant), { x: 0, y: -1, level: 0 });
    assert.equal(start.exits.find(exit => exit.id === stub)!.toRoomNumber, state.room!.roomNumber);
    assert.equal(start.exits[0].command, "climb steps");
    assert.equal(qualityMeasurements, 0);
    assert.equal(layoutCalls.length, 0);
    assert.equal(writes.some(write => write.kind === "layout"), false);
});

test("clean growth does not invoke the planner even with automatic adjustment enabled", async () => {
    options.autoAdjustMapLayout = true;
    await arrive(Direction.North, "Corridor");
    await arrive(Direction.North, "Corridor end");
    assert.deepEqual(position(state.room!), { x: 0, y: -2, level: 0 });
    assert.equal(qualityMeasurements, 4);
    assert.equal(layoutCalls.length, 0, "a larger footprint alone must not trigger adjustment");
    assert.equal(writes.some(write => write.kind === "layout"), false);
});

test("existing layout defects alone do not trigger adjustment when a new room does not worsen them", async () => {
    const a = addRoom(map, { x: 5, y: 0 });
    const b = addRoom(map, { x: 4, y: 0 });
    addExit(a, "map", { fromDirection: "East", toAreaId: map.id, toRoomNumber: b.roomNumber });
    options.autoAdjustMapLayout = true;
    await arrive(Direction.North, "Clean branch");
    assert.equal(layoutCalls.length, 0);
    assert.deepEqual(position(a), { x: 5, y: 0, level: 0 });
    assert.deepEqual(position(b), { x: 4, y: 0, level: 0 });
});

test("a new obstruction triggers one add-room plan when adjustment is enabled", async () => {
    const occupant = addRoom(map, { title: "Other room", x: 0, y: -1 });
    options.autoAdjustMapLayout = true;
    await arrive(Direction.North, "New room");
    assert.equal(layoutCalls.length, 1);
    assert.equal(layoutCalls[0].change.type, "add-room");
    assert.equal(map.roomNumbers.length, 3);
    assert.notDeepEqual(position(occupant), position(state.room!));
    const model = loadLayoutModel(map.id);
    const quality = layoutGeometry.measureIntegralLayoutQuality(
        new Map(model.rooms.map(room => [room.id, room.position])), model.edges);
    assert.equal(quality.routingViolations, 0, "the accepted plan clears the new blocked route");
});

test("placing a new room on an existing connection triggers adjustment even when its cell was empty", async () => {
    const west = addRoom(map, { x: -2, y: -1 });
    const east = addRoom(map, { x: 2, y: -1 });
    addExit(west, "map", { fromDirection: "East", toAreaId: map.id, toRoomNumber: east.roomNumber });
    addExit(east, "map", { fromDirection: "West", toAreaId: map.id, toRoomNumber: west.roomNumber });
    options.autoAdjustMapLayout = true;
    await arrive(Direction.North, "Room on the route");
    assert.equal(layoutCalls.length, 1);
    const model = loadLayoutModel(map.id);
    const quality = layoutGeometry.measureIntegralLayoutQuality(
        new Map(model.rooms.map(room => [room.id, room.position])), model.edges);
    assert.equal(quality.roomObstructions, 0);
});

test("turning adjustment off while planning is pending records without moving existing rooms", async () => {
    const occupant = addRoom(map, { title: "Other room", x: 0, y: -1 });
    options.autoAdjustMapLayout = true;
    afterPlanning = () => { options.autoAdjustMapLayout = false; };
    await arrive(Direction.North, "New room");
    assert.equal(layoutCalls.length, 1);
    assert.deepEqual(position(occupant), { x: 0, y: -1, level: 0 });
    assert.deepEqual(position(state.room!), { x: 0, y: -2, level: 0 });
    assert.equal(writes.some(write => write.kind === "layout"), false);
});

test("a concurrent edit invalidates an adjustment and recomputes a free recording position", async () => {
    addRoom(map, { title: "Other room", x: 0, y: -1 });
    options.autoAdjustMapLayout = true;
    afterPlanning = () => { addRoom(map, { title: "Added in another session", x: 0, y: -2 }); };
    await arrive(Direction.North, "New room");
    assert.equal(layoutCalls.length, 1);
    assert.deepEqual(position(state.room!), { x: 0, y: -3, level: 0 });
    assert.equal(writes.some(write => write.kind === "layout"), false);
});

test("automatic adjustment across places leaves all existing rooms fixed", async () => {
    const occupant = addRoom(secret.area, { title: "Other secret room", x: 0, y: -1 });
    state.selectRecordingPlace(map, secret);
    options.autoAdjustMapLayout = true;
    await arrive(Direction.North, "New secret room");
    assert.equal(layoutCalls.length, 1);
    assert.equal(layoutCalls[0].area, secret.id);
    assert.equal(layoutCalls[0].options.allowExistingMoves, false);
    assert.deepEqual(position(start), { x: 0, y: 0, level: 0 });
    assert.deepEqual(position(occupant), { x: 0, y: -1, level: 0 });
    assert.equal(writes.some(write => write.kind === "layout"), false);
});

test("known links and matching rooms at the destination skip scoring and planning", async () => {
    const existing = addRoom(map, { title: "Known room", x: 0, y: -1 });
    const stub = addExit(start, "map", { fromDirection: "North" });
    options.autoAdjustMapLayout = true;
    await arrive(Direction.North, "Known room");
    assert.equal(state.room, existing);
    assert.equal(start.exits.find(exit => exit.id === stub)!.toRoomNumber, existing.roomNumber);
    await arrive(Direction.South, "Entrance");
    assert.equal(state.room, start);
    assert.equal(qualityMeasurements, 0);
    assert.equal(layoutCalls.length, 0);
});

test("manual reflow and explicitly connecting an existing room remain available with adjustment off", async () => {
    aliases.get("mapper")!({ args: "reflow" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(layoutCalls[0].change.type, "reflow");
    assert.equal(layoutCalls[0].options.effort, "thorough");
    const existing = addRoom(map, { title: "Known room", x: 5, y: 0 });
    addExit(existing, "map", { fromDirection: "South" });
    connectDecision = { type: "connect", roomNumber: existing.roomNumber };
    await arrive(Direction.North, "Known room");
    assert.equal(layoutCalls[1].change.type, "connect-rooms");
    assert.equal(state.room, existing);
});

test("unadjusted vertical placement keeps projected direction and Auto inference", async () => {
    const west = addRoom(map, { x: -1, y: 0 });
    addExit(start, "map", { fromDirection: "West", toAreaId: map.id, toRoomNumber: west.roomNumber });
    options.zMode = ZMode.Isometric;
    await arrive(Direction.Up, "Upper projection", "UD");
    assert.deepEqual(position(state.room!), { x: 1, y: -1, level: 0 });
    options.zMode = ZMode.Auto;
    options.autoAdjustMapLayout = true;
    await arrive(Direction.Up, "Next projection", "D");
    assert.deepEqual(position(state.room!), { x: 2, y: -2, level: 0 });
    assert.equal(layoutCalls.length, 0);
});

test("unadjusted normal vertical placement skips occupied levels without moving rooms", async () => {
    const upstairs = addRoom(map, { title: "Other upstairs room", level: 1 });
    options.zMode = ZMode.Normal;
    await arrive(Direction.Up, "New upstairs room", "D");
    assert.deepEqual(position(state.room!), { x: 0, y: 0, level: 2 });
    assert.deepEqual(position(upstairs), { x: 0, y: 0, level: 1 });
    assert.equal(layoutCalls.length, 0);
});
