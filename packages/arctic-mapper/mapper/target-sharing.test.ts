import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SetTargetRequest, TargetLocation } from "../index.ts";

// Load the real entry point and sharing/registry code once per simulated session.
// The host bus is mocked; aliases and panes have their own integration tests.
const fixtures = new Map<number, any>();
globalThis.__targetSharingTest = fixtures;
registerHooks({
    resolve(specifier, context, next) {
        const id = context.parentURL?.startsWith("file:")
            ? new URL(context.parentURL).searchParams.get("targetSession") : null;
        if (!id) return next(specifier, context);
        const mocks = {
            "smudgy:core": "core",
            "smudgy:events/sessions": "lifecycle",
            "smudgy:state/@arctic-mapper": "consumer",
            "./mapper.ts": "mapper", "./mapper/mapper.ts": "mapper",
            "./mapper/events.ts": "events",
            "./mapper/alias.ts": "empty", "./mapper/room-capturer.ts": "empty", "./mapper/widget.tsx": "empty",
        };
        if (mocks[specifier]) return { url: `target-sharing-test:${id}/${mocks[specifier]}`, shortCircuit: true };
        if (specifier.startsWith(".")) {
            const url = new URL(specifier, context.parentURL);
            url.searchParams.set("targetSession", id);
            return { url: url.href, shortCircuit: true };
        }
        return next(specifier, context);
    },
    load(url, context, next) {
        if (url.startsWith("target-sharing-test:")) {
            const [id, name] = url.slice("target-sharing-test:".length).split("/");
            const source = Object.keys(fixtures.get(Number(id))[name]).map(key =>
                `export const ${key} = globalThis.__targetSharingTest.get(${id}).${name}.${key};`).join("\n");
            return { format: "module", source, shortCircuit: true };
        }
        if (url.startsWith("file:") && new URL(url).searchParams.has("targetSession")) {
            return { format: "module", shortCircuit: true,
                source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" }) };
        }
        return next(url, context);
    },
});

type SessionHandle = { id: number; connected: boolean; profile: { name: string } };
let nextId = 1;
let sessions: Map<number, SessionHandle>;
let snapshots: Map<number, SetTargetRequest>;
let watchers: Map<number, Set<Function>>;
let lifecycle: Map<string, Function[]>;
let writes: number;
beforeEach(() => {
    sessions = new Map(); snapshots = new Map(); watchers = new Map(); lifecycle = new Map(); writes = 0;
});
function emit(event: string, session: SessionHandle) {
    for (const listener of lifecycle.get(event) ?? []) listener(session);
}
async function loadSession(name: string, room: TargetLocation | null) {
    const handle = { id: nextId++, connected: true, profile: { name } };
    sessions.set(handle.id, handle);
    emit("created", handle);
    const state = { room };
    const roomListeners: Function[] = [];
    const procedures = new Map<string, Function>();
    const fixture = {
        empty: {}, events: { mapEvent: {} },
        core: {
            session: handle, getSessions: () => [...sessions.values()],
            createProcedure: (name: string, callback: Function) => { procedures.set(name, callback); return {}; },
            createState: (name: string) => {
                assert.equal(name, "sessionTarget");
                return { set: (value: SetTargetRequest) => {
                    writes++;
                    snapshots.set(handle.id, structuredClone(value));
                    for (const callback of watchers.get(handle.id) ?? []) callback(structuredClone(value));
                } };
            },
        },
        mapper: {
            state, onRoomChanged: (callback: Function) => roomListeners.push(callback),
            onAreaChanged() {}, onModeChanged() {}, speedwalk() {}, options: {},
            State: {}, Direction: {}, DirectionLetter: {}, MoveCommands: {}, RoomFlags: {},
        },
        consumer: { sessionTarget: { from: (other: SessionHandle) => ({
            get value() { return snapshots.get(other.id); },
            watch(callback: Function) {
                if (!watchers.has(other.id)) watchers.set(other.id, new Set());
                watchers.get(other.id)!.add(callback);
                return { off: () => watchers.get(other.id)!.delete(callback) };
            },
        }) } },
        lifecycle: Object.fromEntries(["created", "connected", "disconnected", "destroyed"].map(event => [event, {
            on(callback: Function) {
                if (!lifecycle.has(event)) lifecycle.set(event, []);
                lifecycle.get(event)!.push(callback);
            },
        }])),
    };
    fixtures.set(handle.id, fixture);
    await import(`../index.ts?targetSession=${handle.id}`);
    const { targets } = await import(`./targets.ts?targetSession=${handle.id}`);
    return {
        handle, targets,
        post: (request: SetTargetRequest) => procedures.get("setTarget")!(structuredClone(request)),
        move: (room: TargetLocation | null) => {
            state.room = room;
            for (const listener of roomListeners) listener();
        },
    };
}

const kapRoom = { areaId: "map-area", roomNumber: 4 };
const zurRoom = { areaId: "private-area", roomNumber: 7 };

test("sessions discover stationary peers on load and broadcast new locations without feedback", async () => {
    const kap = await loadSession("Kapusniak", kapRoom);
    const zur = await loadSession("Zurek", zurRoom);
    assert.deepEqual(zur.targets.find("k").location, kapRoom);
    assert.deepEqual(kap.targets.find("z").location, zurRoom);
    assert.throws(() => kap.targets.find("k"), /No speedwalk target/);
    assert.equal(writes, 2);
    const secretRoom = { areaId: "secret-area", roomNumber: 7 };
    zur.move(secretRoom);
    assert.deepEqual(kap.targets.find("z").location, secretRoom);
    assert.equal(writes, 3, "receiving another session's location must not republish it");
    const third = await loadSession("Observer", null);
    assert.deepEqual(third.targets.find("z").location, secretRoom);
    assert.deepEqual(third.targets.find("k").location, kapRoom);
    assert.throws(() => kap.targets.find("o"), /No speedwalk target/);
});

test("unknown locations, disconnects, reconnects and closed sessions clear or refresh targets", async () => {
    const kap = await loadSession("Kapusniak", kapRoom);
    const zur = await loadSession("Zurek", zurRoom);
    zur.move(null);
    assert.throws(() => kap.targets.find("z"), /No speedwalk target/);
    zur.move(zurRoom);
    zur.handle.connected = false;
    emit("disconnected", zur.handle);
    assert.throws(() => kap.targets.find("z"), /No speedwalk target/);
    zur.handle.connected = true;
    emit("connected", zur.handle);
    assert.deepEqual(kap.targets.find("z").location, zurRoom);
    assert.equal(watchers.get(zur.handle.id)!.size, 1, "reconnect must not add another watcher");
    emit("destroyed", zur.handle);
    assert.throws(() => kap.targets.find("z"), /No speedwalk target/);
    assert.equal(watchers.get(zur.handle.id)!.size, 0);
});

test("profile names are refreshed when publishing and replace their old target", async () => {
    const kap = await loadSession("Kapusniak", kapRoom);
    const zur = await loadSession("Zurek", zurRoom);
    zur.handle.profile.name = "Renamed";
    zur.move({ ...zurRoom, roomNumber: 8 });
    assert.throws(() => kap.targets.find("z"), /No speedwalk target/);
    assert.equal(kap.targets.find("r").location.roomNumber, 8);
});

test("the exported setTarget procedure creates, updates and removes only the recipient's target", async () => {
    const kap = await loadSession("Kapusniak", kapRoom);
    const zur = await loadSession("Zurek", zurRoom);
    kap.post({ name: "camp", location: zurRoom });
    assert.deepEqual(kap.targets.find("c").location, zurRoom);
    assert.throws(() => zur.targets.find("c"), /No speedwalk target/);
    zur.post({ name: "camp", location: kapRoom });
    assert.deepEqual(zur.targets.find("c").location, kapRoom);
    kap.post({ name: "camp", location: kapRoom });
    assert.deepEqual(kap.targets.find("c").location, kapRoom);
    kap.post({ name: "camp", location: null });
    assert.throws(() => kap.targets.find("c"), /No speedwalk target/);
    assert.deepEqual(zur.targets.find("c").location, kapRoom);
    assert.equal(writes, 2, "procedure targets are not automatic location broadcasts");
});
