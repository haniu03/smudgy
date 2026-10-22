import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";
import { measureIntegralLayoutQuality, type GridPosition, type IntegralLayoutPlan, type LayoutPlanner } from "../../map-layout/layout.ts";
import type { LayoutPlannerSnapshot } from "../../map-layout/planner-state.ts";
import { nukeFirePerfectConstraintRepairPolicy } from "../../nukefire-mapper/constraint-policy.ts";

interface FakeRoom {
    room_number: number;
    roomNumber: number;
    areaId: string;
    x: number;
    y: number;
    level: number;
    exits: { from_direction: string; to_area_id: string; to_room_number: number }[];
    hasTag(tag: string): boolean;
    data(key: string): string | undefined;
}
interface FakeConnection {
    id: string;
    endpointA: { roomNumber: number; place?: string };
    endpointB: { roomNumber: number; place?: string } | null;
    routing: string;
}

const AREA = "area-1";
const rooms = new Map<number, FakeRoom>();
let connections: FakeConnection[] = [];
let operations: string[] = [];
const kind = (connection: FakeConnection) =>
    connection.endpointB && rooms.get(connection.endpointA.roomNumber)!.level === rooms.get(connection.endpointB.roomNumber)!.level
        ? "Internal" : "CrossLevel";
const area = {
    id: AREA, name: "Solace", place: "map",
    get room_numbers() { return [...rooms.keys()]; },
    room: (number: number) => rooms.get(number),
    get connections() { return connections.map((connection) => ({ ...connection, kind: kind(connection) })); },
};
const mapper = {
    getAreaById(id: string) {
        if (id !== AREA) throw new Error("Area not found");
        return area;
    },
    async mutateArea(id: string, callback: Function) {
        assert.equal(id, AREA);
        await callback({
            async setConnection(connectionId: string, updates: { routing?: string }) {
                operations.push(`route ${connectionId} ${updates.routing}`);
                Object.assign(connections.find((connection) => connection.id === connectionId)!, updates);
            },
            async updateRooms(updates: [number, Partial<GridPosition>][]) {
                operations.push(`move ${updates.map(([number]) => number).join(",")}`);
                for (const [number, fields] of updates) Object.assign(rooms.get(number)!, fields);
            },
        });
        // The host refuses a drawn route between rooms on different levels.
        if (connections.some((connection) => connection.routing === "Manual" && kind(connection) === "CrossLevel")) {
            throw new Error("invalid_routing");
        }
    },
};

(globalThis as any).__polishTest = { mapper };
const mapLayout = new URL("../../map-layout/index.ts", import.meta.url).href;
registerHooks({
    resolve(specifier, context, next) {
        if (specifier === "smudgy:core") return { url: "polish-test:core", shortCircuit: true };
        if (specifier === "smudgy:@map-layout") return { url: mapLayout, shortCircuit: true };
        return next(specifier, context);
    },
    load(url, context, next) {
        if (url === "polish-test:core") {
            return { format: "module", shortCircuit: true, source: "export const mapper = globalThis.__polishTest.mapper;" };
        }
        return next(url, context);
    },
});
const { deepPolishPolicy, polishProgressLine, qualitySummary, startPolish, stopPolish } = await import("./polish.ts");

function addRoom(number: number, x: number, y: number, level: number, exits: [string, number][]) {
    rooms.set(number, {
        room_number: number, roomNumber: number, areaId: AREA, x, y, level,
        exits: exits.map(([from_direction, to_room_number]) => ({ from_direction, to_area_id: AREA, to_room_number })),
        hasTag: () => false, data: () => undefined,
    });
}

/** A plan putting room 2 at `second` (and room 1 at `first`), scored as the planner would. */
function planAt(second: GridPosition, first: GridPosition = { x: 0, y: 0, level: 0 }): IntegralLayoutPlan {
    const positions = new Map([["1", first], ["2", second]]);
    const edges = [...rooms.values()].flatMap((room) => room.exits.map((exit) =>
        ({ from: String(room.room_number), to: String(exit.to_room_number), direction: exit.from_direction as any })));
    return { positions, movedExisting: true, quality: measureIntegralLayoutQuality(positions, edges) };
}

const snapshot = { phase: "polish", status: "running", work: {} } as unknown as LayoutPlannerSnapshot;
let closed = 0;
let tournaments: { change: any; options: any }[] = [];
/** The tournament finds the map as it is unless the test gives it a layout. */
const unchanged = async (model: any) => ({
    positions: new Map(model.rooms.map((room: any) => [room.id, room.position])),
    quality: measureIntegralLayoutQuality(new Map(model.rooms.map((room: any) => [room.id, room.position])), model.edges),
});
function planner(
    plan: (options: any) => Promise<IntegralLayoutPlan>,
    tournament: (model: any, control: any) => Promise<any> = unchanged,
): () => LayoutPlanner {
    return () => ({
        planIntegral: (_request, options) => plan(options),
        planModel: (model, change, options, control) => {
            tournaments.push({ change, options });
            return tournament(model, control);
        },
        close: () => { closed += 1; },
    });
}

const until = async (done: () => boolean) => {
    for (let turn = 0; turn < 1_000 && !done(); turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(done(), "condition never held");
};
const aborted = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
});
let said: string[] = [];
const options = (createPlanner: () => LayoutPlanner, moved?: (rooms: readonly number[]) => void) => ({
    say: (line: string) => said.push(line), moved, createPlanner, minApplyIntervalMs: 0, progressIntervalMs: 60_000,
});

beforeEach(() => {
    rooms.clear(); connections = []; operations = []; said = []; closed = 0; tournaments = [];
    // Room 2 is east of room 1 by its exits but drawn three cells north.
    addRoom(1, 0, 0, 0, [["East", 2]]);
    addRoom(2, 0, -3, 0, [["West", 1]]);
});

test("the polish budgets are nf reflow perfect's", () => {
    for (const [residentCount, edgeCount] of [[1, 0], [40, 80], [94, 202], [256, 768], [1906, 4439]]) {
        assert.deepEqual(deepPolishPolicy({ residentCount, edgeCount }),
            nukeFirePerfectConstraintRepairPolicy({ residentCount, edgeCount }));
    }
    assert.equal(deepPolishPolicy({ residentCount: 10, edgeCount: 20 }).maxExtensionStates, 4_194_304);
    assert.equal(deepPolishPolicy({ residentCount: 300, edgeCount: 900 }).maxExtensionStates, 32_768);
});

test("each better layout goes on the map as it is found, and the last one stays", async () => {
    const wide = planAt({ x: 3, y: 0, level: 0 });
    const tight = planAt({ x: 1, y: 0, level: 0 });
    const moved: (readonly number[])[] = [];
    await startPolish(AREA, options(planner(async ({ onProgress }) => {
        onProgress({ snapshot, improvement: wide });
        await until(() => rooms.get(2)!.x === 3);
        onProgress({ snapshot, improvement: tight });
        return tight;
    }), (rooms) => moved.push(rooms)));
    assert.deepEqual([rooms.get(2)!.x, rooms.get(2)!.y], [1, 0]);
    assert.deepEqual(moved, [[2], [2]]);
    assert.equal(closed, 2, "both searches' planners close");
    assert.match(said[0], /^Polishing Solace: 2 rooms, 2 exits, now 2\/0\/0 .*"map stop"/);
    assert.match(said.at(-1)!, /^Polished Solace in 0:0\d: 2\/0\/0 -> 0\/0\/0\.$/);
});

test("the anchored tournament's layout goes on the map when it beats the deep search", async () => {
    const wide = planAt({ x: 3, y: 0, level: 0 });
    const tight = planAt({ x: 1, y: 0, level: 0 });
    await startPolish(AREA, { ...options(planner(async ({ onProgress }) => {
        onProgress({ snapshot, improvement: wide });
        return wide;
    }, async () => {
        await until(() => rooms.get(2)!.x === 3);
        return tight;
    })), anchor: 2 });
    assert.deepEqual(tournaments.map(({ change, options }) => [change, options.effort]),
        [[{ type: "reflow", anchor: "2" }, "thorough"]]);
    assert.deepEqual([rooms.get(2)!.x, rooms.get(2)!.y], [1, 0]);
    assert.match(said.at(-1)!, /^Polished Solace in 0:0\d: 2\/0\/0 -> 0\/0\/0\.$/);
});

test("a tournament anchor outside the polished area is left out", async () => {
    await startPolish(AREA, { ...options(planner(async () => planAt({ x: 1, y: 0, level: 0 }))), anchor: 9 });
    assert.deepEqual(tournaments[0].change, { type: "reflow", anchor: undefined });
});

test("a layout no better than the map's is never written", async () => {
    const worse = planAt({ x: 0, y: -6, level: 0 });
    await startPolish(AREA, options(planner(async ({ onProgress }) => {
        onProgress({ snapshot, improvement: worse });
        return worse;
    })));
    assert.deepEqual(operations, []);
    assert.match(said.at(-1)!, /^Solace needed nothing \(0:0\d\); it stays 2\/0\/0\.$/);
});

test("a stop keeps the best layout already on the map", async () => {
    const better = planAt({ x: 1, y: 0, level: 0 });
    const done = startPolish(AREA, options(planner(async ({ onProgress, signal }) => {
        onProgress({ snapshot, improvement: better });
        return aborted(signal);
    })));
    await until(() => rooms.get(2)!.x === 1);
    assert.equal(stopPolish(), true);
    await done;
    assert.equal(stopPolish(), false);
    assert.equal(rooms.get(2)!.y, 0);
    assert.match(said.at(-1)!, /^Stopped polishing Solace after 0:0\d; it keeps 0\/0\/0\.$/);
});

test("a map changed during the polish keeps what is on it", async () => {
    const wide = planAt({ x: 3, y: 0, level: 0 });
    const tight = planAt({ x: 1, y: 0, level: 0 });
    await startPolish(AREA, options(planner(async ({ onProgress }) => {
        onProgress({ snapshot, improvement: wide });
        await until(() => rooms.get(2)!.x === 3);
        rooms.get(1)!.y = 1; // the player moves a room
        onProgress({ snapshot, improvement: tight });
        return tight;
    })));
    assert.equal(rooms.get(2)!.x, 3);
    assert.match(said.at(-1)!, /^Solace changed while it was being polished; it keeps 0\/0\/0\. Type "map reflow"/);
});

test("one polish runs at a time", async () => {
    const done = startPolish(AREA, options(planner(async ({ signal }) => aborted(signal))));
    assert.equal(startPolish(AREA, options(planner(async () => assert.fail("a second polish ran")))), undefined);
    assert.match(said.at(-1)!, /^Already polishing Solace; type "map stop" to stop it\.$/);
    stopPolish();
    await done;
});

test("a drawn route at a room changing level goes straight first, and stays straight between levels", async () => {
    rooms.clear();
    addRoom(1, 0, 0, 0, [["Up", 2]]);
    addRoom(2, 1, 0, 0, [["Down", 1]]);
    connections = [{ id: "c1", endpointA: { roomNumber: 1 }, endpointB: { roomNumber: 2 }, routing: "Manual" }];
    const stacked = planAt({ x: 0, y: 0, level: 1 });
    await startPolish(AREA, options(planner(async ({ onProgress }) => {
        onProgress({ snapshot, improvement: stacked });
        return stacked;
    })));
    assert.deepEqual(operations, ["route c1 Simple", "move 2"]);
    assert.equal(rooms.get(2)!.level, 1);
});

test("a drawn route gets its routing back when its rooms change level together", async () => {
    connections = [
        { id: "c1", endpointA: { roomNumber: 1 }, endpointB: { roomNumber: 2 }, routing: "Manual" },
        // Private's rooms 1 and 2 are not this map's.
        { id: "c2", endpointA: { roomNumber: 1, place: "private" }, endpointB: { roomNumber: 2, place: "private" },
            routing: "Manual" },
    ];
    const raised = planAt({ x: 1, y: 0, level: 1 }, { x: 0, y: 0, level: 1 });
    await startPolish(AREA, options(planner(async () => raised)));
    assert.deepEqual(operations, ["route c1 Simple", "move 1,2", "route c1 Manual"]);
    assert.equal(connections[0].routing, "Manual");
});

test("progress names the stage, the best layout against the map, the work and what is on the map", () => {
    const line = polishProgressLine("Solace", 72_000, {
        phase: "constraint-search", status: "running",
        currentQuality: { cardinalRayViolations: 9, routingViolations: 4, linkCrossings: 2, levelViolations: 1 },
        bestQuality: { cardinalRayViolations: 1, routingViolations: 0, linkCrossings: 2 },
        work: { layoutsConsidered: 14, feasibilityChecks: 1, restarts: 0, crossingsConsidered: 0 },
    } as unknown as LayoutPlannerSnapshot, 2);
    assert.equal(line, "Solace 1:12 | constraint search | best 1/0/2 from 9/4/2 (1 on the wrong level) | " +
        "14 layouts, 1 check | 2 on the map");
    assert.equal(polishProgressLine("Solace", 500, undefined, 0), "Solace 0:00 | waiting for the planner");
    assert.equal(qualitySummary(undefined), "?");
});

test("progress shows the tournament's stage and its layout when it beats the planner's best", () => {
    const north = planAt({ x: 0, y: -3, level: 0 }).quality;
    const east = planAt({ x: 1, y: 0, level: 0 }).quality;
    const planned = {
        phase: "complete: ceiling", status: "complete", currentQuality: north, bestQuality: north,
        work: { layoutsConsidered: 0, feasibilityChecks: 0, restarts: 0, crossingsConsidered: 0 },
    } as unknown as LayoutPlannerSnapshot;
    assert.equal(polishProgressLine("Solace", 3_000, planned, 1, { stage: "anchored reflow", best: east }),
        "Solace 0:03 | anchored reflow | best 0/0/0 from 2/0/0 | 1 on the map");
    assert.equal(polishProgressLine("Solace", 3_000, { ...planned, bestQuality: east }, 0, { best: north }),
        "Solace 0:03 | complete: ceiling | best 0/0/0 from 2/0/0");
});
