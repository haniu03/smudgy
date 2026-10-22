import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

interface FakeConnection {
    id: string;
    endpointA: { roomNumber: number; side: string; portOffset: number; portMode: string; place?: string };
    endpointB: { roomNumber: number; side: string; portOffset: number; portMode: string; place?: string } | null;
    kind: string;
    routing: string;
    segmentShape: string;
    corner: string;
    routePoints: { x: number; y: number }[];
    color: string;
    thickness: number;
}

const AREA = "area-1";
const rooms = new Map<number, {
    x: number; y: number; level: number; tags: string[];
    exits: { fromDirection: string; connectionId: string }[];
    hasTag(tag: string): boolean; data(key: string): string | undefined;
}>();
let connections: FakeConnection[] = [];
let writes: [string, Record<string, unknown>][][] = [];
const area = {
    id: AREA, name: "Kagonesti", place: "map",
    get roomNumbers() { return [...rooms.keys()]; },
    room: (number: number) => rooms.get(number),
    get connections() { return connections; },
};
const mapper = {
    getAreaById(id: string) {
        if (id !== AREA) throw new Error("Area not found");
        return area;
    },
    async mutateArea(id: string, callback: Function) {
        assert.equal(id, AREA);
        const batch: [string, Record<string, unknown>][] = [];
        await callback({
            async setConnection(connectionId: string, updates: Record<string, unknown>) {
                batch.push([connectionId, updates]);
                Object.assign(connections.find((connection) => connection.id === connectionId)!, updates);
            },
        });
        writes.push(batch);
    },
};

(globalThis as any).__routesTest = { mapper };
const mapLayout = new URL("../../map-layout/index.ts", import.meta.url).href;
registerHooks({
    resolve(specifier, context, next) {
        if (specifier === "smudgy:core") return { url: "routes-test:core", shortCircuit: true };
        if (specifier === "smudgy:@map-layout") return { url: mapLayout, shortCircuit: true };
        return next(specifier, context);
    },
    load(url, context, next) {
        if (url === "routes-test:core") {
            return { format: "module", shortCircuit: true, source: "export const mapper = globalThis.__routesTest.mapper;" };
        }
        return next(url, context);
    },
});
const { routeArea, routeSummaryText } = await import("./routes.ts");
const { LINK_CALLOUT_THICKNESS: CALLOUT_THICKNESS, linkCalloutColor: calloutColor } = await import("../../map-layout/link-routes.ts");
const { paletteColor } = await import("./palette.ts");

function room(number: number, x: number, y: number, level = 0): void {
    const tags: string[] = [];
    rooms.set(number, {
        x, y, level, tags, exits: [],
        hasTag: (tag: string) => tags.includes(tag.toUpperCase()),
        data: () => undefined,
    });
}

/** A link from `from`'s `direction` exit, drawn between the walls the host would give it. */
function connect(id: string, from: number, direction: string, to: number, sides: [string, string], extra: Partial<FakeConnection> = {}): FakeConnection {
    rooms.get(from)!.exits.push({ fromDirection: direction, connectionId: id });
    const connection: FakeConnection = {
        id,
        endpointA: { roomNumber: from, side: sides[0], portOffset: 0.5, portMode: "AutoPinned" },
        endpointB: { roomNumber: to, side: sides[1], portOffset: 0.5, portMode: "AutoPinned" },
        kind: "Internal", routing: "Simple", segmentShape: "Direct", corner: "Sharp", routePoints: [],
        color: "#A4A4A4", thickness: 1,
        ...extra,
    };
    connections.push(connection);
    return connection;
}

beforeEach(() => {
    rooms.clear(); connections = []; writes = [];
    room(1, 0, 0);
    room(2, 0, 2);
    room(3, 3, 0);
});

test("a link leaving a wall that faces away is routed, and clean links are left alone", async () => {
    // Room 1's East exit leads to room 2, which lies south and takes it on its West wall.
    const bent = connect("bent", 1, "East", 2, ["East", "West"]);
    const clean = connect("clean", 1, "South", 2, ["South", "North"]);
    const summary = await routeArea(AREA);
    assert.equal(bent.routing, "Automatic");
    assert.equal(bent.corner, "Rounded");
    assert.ok(bent.routePoints.length > 0);
    assert.equal(clean.routing, "Simple");
    assert.deepEqual(writes.flat().map(([id]) => id), ["bent"]);
    assert.deepEqual(summary, { routed: 1, straightened: 0, calledOut: 0, upDownStraightened: 0 });
    assert.equal(routeSummaryText("Kagonesti", summary), "Routes in Kagonesti: 1 link routed.");
});

test("links between Up and Down exits are never routed, and a routed one is drawn straight", async () => {
    // Up drawn on one level, bent out of its walls, and carrying a route it never may.
    const upDown = connect("up", 1, "Up", 3, ["East", "West"], {
        routing: "Automatic", corner: "Rounded", routePoints: [{ x: 1, y: -1 }, { x: 2, y: -1 }],
    });
    const projected = connect("down", 3, "Down", 2, ["West", "East"]);
    const summary = await routeArea(AREA);
    assert.equal(upDown.routing, "Simple");
    assert.deepEqual(upDown.routePoints, []);
    assert.equal(projected.routing, "Simple");
    assert.deepEqual(projected.routePoints, []);
    assert.equal(summary.upDownStraightened, 1);
    assert.equal(summary.routed, 0);
});

test("hand-drawn routes stay unless asked to redraw them", async () => {
    const drawn = [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: -0.5, y: 1 }, { x: -0.5, y: 2 }];
    const manual = connect("manual", 1, "East", 2, ["East", "West"], { routing: "Manual", routePoints: drawn });
    await routeArea(AREA);
    assert.equal(manual.routing, "Manual");
    assert.deepEqual(manual.routePoints, drawn);
    assert.equal(writes.length, 0);
    await routeArea(AREA, { redrawManual: true });
    assert.equal(manual.routing, "Automatic");
    assert.notDeepEqual(manual.routePoints, drawn);
});

test("a link that no longer needs its route is drawn straight again, without its callout", async () => {
    const straight = connect("straight", 1, "South", 2, ["South", "North"], {
        routing: "Automatic", corner: "Rounded", routePoints: [{ x: 0.5, y: 1 }],
        color: calloutColor(AREA, 0), thickness: CALLOUT_THICKNESS,
    });
    straight.endpointA.portOffset = 0.7;
    const summary = await routeArea(AREA);
    assert.equal(straight.routing, "Simple");
    assert.deepEqual(straight.routePoints, []);
    assert.equal(straight.endpointA.portOffset, 0.5);
    assert.equal(straight.color, "#A4A4A4");
    assert.equal(straight.thickness, 1);
    assert.equal(summary.straightened, 1);
});

test("a second pass over a routed map writes nothing", async () => {
    connect("bent", 1, "East", 2, ["East", "West"]);
    connect("clean", 1, "South", 2, ["South", "North"]);
    await routeArea(AREA);
    assert.equal(writes.length, 1);
    await routeArea(AREA);
    assert.equal(writes.length, 1);
});

test("links anchored on another place's rooms are left alone", async () => {
    const other = connect("private", 1, "East", 2, ["East", "West"]);
    other.endpointB!.place = "private";
    await routeArea(AREA);
    assert.equal(other.routing, "Simple");
    assert.equal(writes.length, 0);
});

test("a reflow's moved rooms redraw their hand-drawn links, ports and all", async () => {
    const stale = [{ x: 5, y: 0 }, { x: 5, y: 3 }];
    const manual = connect("manual", 1, "East", 2, ["East", "West"], { routing: "Manual", routePoints: stale });
    manual.endpointA.portMode = "Manual";
    manual.endpointA.portOffset = 0.2;
    await routeArea(AREA, { moved: new Set([1]) });
    assert.equal(manual.routing, "Automatic");
    assert.notDeepEqual(manual.routePoints, stale);
    assert.equal(manual.endpointA.portMode, "AutoPinned");
    // Unmoved, the same link would have kept its hand-drawn route.
    const kept = connect("kept", 3, "South", 1, ["South", "North"], { routing: "Manual", routePoints: [{ x: 4, y: 1 }] });
    await routeArea(AREA, { moved: new Set([2]) });
    assert.equal(kept.routing, "Manual");
});

test("links at a locked room stay as they are drawn, moved or bent", async () => {
    rooms.get(2)!.tags.push("LAYOUT_LOCKED");
    const bent = connect("bent", 1, "East", 2, ["East", "West"]);
    const manual = connect("manual", 3, "West", 2, ["West", "East"], { routing: "Manual", routePoints: [{ x: 1, y: 0 }] });
    await routeArea(AREA, { moved: new Set([1, 2, 3]), redrawManual: true });
    assert.equal(bent.routing, "Simple");
    assert.equal(manual.routing, "Manual");
    assert.equal(writes.length, 0);
});

test("crowded links are called out in palette colors of their own, and an author's color stays", async () => {
    rooms.clear();
    room(10, 0, 0);
    const links = [1, 2, 3, 4, 5, 6].map((number) => {
        room(number, number * 2 - 7, 3);
        return connect(`s${number}`, number, "North", 10, ["North", "South"]);
    });
    links[0].color = "#123456";
    const summary = await routeArea(AREA);
    assert.ok(summary.calledOut > 0);
    const styled = links.filter((link) => link.thickness === CALLOUT_THICKNESS);
    assert.ok(styled.length > 0);
    assert.equal(new Set(styled.map((link) => link.color)).size, styled.length, "each callout has its own color");
    const palette = new Set(Array.from({ length: 30 }, (_, place) => calloutColor(AREA, place)));
    assert.ok(styled.every((link) => palette.has(link.color)));
    assert.equal(links[0].color, "#123456");
    assert.equal(links[0].thickness, 1);
});

test("callouts take the colors the map editor's Secret palette gives the map", () => {
    for (let place = 0; place < 30; place += 1) {
        assert.equal(calloutColor(AREA, place), paletteColor([AREA, "callout"], place).toUpperCase());
    }
});
