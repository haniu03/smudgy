/**
 * `map routes`: draws an area's links along map-layout's planned routes. A link
 * that leaves a wall facing away from its room, runs across a room or crosses
 * another link is routed around them on Automatic routing with rounded
 * corners; a link that no longer needs a route goes back to a straight line.
 * Links sharing a stretch no lane could separate are called out at double
 * width, each in a color of its own from the palette Secrets take theirs from.
 */

import { mapper } from "smudgy:core";
import {
    isLinkCalloutColor,
    LINK_CALLOUT_THICKNESS,
    linkCalloutColor,
    planLinkRoutes,
    type PlannedLinkRoute,
    type RouteLink,
} from "smudgy:@map-layout";
import { placeKey } from "./places.ts";

const DEFAULT_COLOR = "#A4A4A4";
const DEFAULT_THICKNESS = 1;

const CARDINAL = new Set<string>(["North", "East", "South", "West"]);

/** Whether the room keeps its place: the lock map-layout's reflow honors. */
function locked(room: Room): boolean {
    return room.hasTag("LAYOUT_LOCKED") || room.data("layoutLocked") === "true";
}

export interface RouteOptions {
    /** Also route links drawn by hand, which are otherwise left as they are. */
    redrawManual?: boolean;
    /**
     * Rooms a reflow just moved. Every link at one of them is routed afresh, a
     * hand-drawn one and its ports included, since they were drawn for where
     * the rooms were.
     */
    moved?: ReadonlySet<RoomNumber>;
}

export interface RouteSummary {
    /** Links now drawn along a route. */
    routed: number;
    /** Links drawn straight again. */
    straightened: number;
    /** Links called out. */
    calledOut: number;
    /** Links between Up and Down exits that carried a route, which they never may. */
    upDownStraightened: number;
}

function samePoints(a: readonly MapPoint[], b: readonly MapPoint[]): boolean {
    return a.length === b.length && a.every((point, index) =>
        Math.abs(point.x - b[index].x) < 1e-6 && Math.abs(point.y - b[index].y) < 1e-6);
}

interface Planned {
    connection: Connection;
    endpointB: ConnectionEndpoint;
    /** Ends whose ports the planner placed, which turn AutoPinned. */
    freeA: boolean;
    freeB: boolean;
}

/** The changes that draw a connection as `plan` says, or undefined when it already is. */
function updatesFor(
    { connection, endpointB, freeA, freeB }: Planned,
    plan: PlannedLinkRoute,
    mapId: AreaId,
): ConnectionUpdates | undefined {
    const updates: ConnectionUpdates = {};
    if (plan.points.length > 0) {
        if (connection.routing !== "Automatic") updates.routing = "Automatic";
        if (connection.corner !== "Rounded") updates.corner = "Rounded";
        if (connection.segmentShape !== "Direct") updates.segmentShape = "Direct";
        if (!samePoints(connection.routePoints, plan.points)) updates.routePoints = plan.points;
    } else if (connection.routing !== "Simple") {
        updates.routing = "Simple";
        updates.corner = "Sharp";
        updates.routePoints = [];
    }
    const endpoint = (current: ConnectionEndpoint, port: number, free: boolean): ConnectionEndpoint | undefined =>
        Math.abs(current.portOffset - port) > 1e-6 || (free && current.portMode !== "AutoPinned")
            ? { ...current, portOffset: port, ...(free ? { portMode: "AutoPinned" as const } : {}) }
            : undefined;
    const a = endpoint(connection.endpointA, plan.fromPort, freeA);
    const b = endpoint(endpointB, plan.toPort, freeB);
    if (a) updates.endpointA = a;
    if (b) updates.endpointB = b;

    // A link keeps a color or width of its author's own; one in the default
    // style or a callout's takes the style the plan gives it.
    const color = connection.color.toUpperCase();
    const ours = connection.thickness === LINK_CALLOUT_THICKNESS && isLinkCalloutColor(mapId, color);
    const plain = color === DEFAULT_COLOR && connection.thickness === DEFAULT_THICKNESS;
    if (plan.callout !== undefined && (plain || ours)) {
        const wanted = linkCalloutColor(mapId, plan.callout);
        if (color !== wanted) updates.color = wanted;
        if (connection.thickness !== LINK_CALLOUT_THICKNESS) updates.thickness = LINK_CALLOUT_THICKNESS;
    } else if (plan.callout === undefined && ours) {
        updates.color = DEFAULT_COLOR;
        updates.thickness = DEFAULT_THICKNESS;
    }
    return Object.keys(updates).length > 0 ? updates : undefined;
}

/**
 * Routes the links between the rooms of one area's own place. Links between Up
 * and Down exits are always drawn straight, a link at a locked room stays as
 * it is drawn, and links drawn by hand keep their routes unless `redrawManual`
 * is set or a reflow moved one of their rooms.
 */
export async function routeArea(areaId: AreaId, options: RouteOptions = {}): Promise<RouteSummary> {
    const area = mapper.getAreaById(areaId);
    const own = placeKey(area.place);
    const mapId = area.mapId ?? area.id;
    const positions = new Map<string, { x: number; y: number; level: number }>();
    const lockedRooms = new Set<RoomNumber>();
    const directions = new Map<string, Set<string>>();
    for (const number of area.roomNumbers) {
        const room = area.room(number);
        if (!room) continue;
        positions.set(String(number), { x: room.x, y: room.y, level: room.level });
        if (locked(room)) lockedRooms.add(number);
        for (const exit of room.exits) {
            if (!exit.connectionId) continue;
            const found = directions.get(exit.connectionId) ?? new Set<string>();
            found.add(exit.fromDirection);
            directions.set(exit.connectionId, found);
        }
    }
    const ownRoom = (endpoint: ConnectionEndpoint | null): endpoint is ConnectionEndpoint =>
        !!endpoint && (endpoint.place === undefined || endpoint.place === own) &&
        positions.has(String(endpoint.roomNumber));

    const links: RouteLink[] = [];
    const planned = new Map<string, Planned>();
    const updates: [ConnectionId, ConnectionUpdates][] = [];
    let upDownStraightened = 0;
    for (const connection of area.connections) {
        const endpointA = connection.endpointA;
        const endpointB = connection.endpointB;
        if (!ownRoom(endpointA) || !ownRoom(endpointB) || connection.routing === "Stub") continue;
        const members = [...(directions.get(connection.id) ?? [])];
        const upDown = members.some((direction) => direction === "Up" || direction === "Down");
        const drawn = connection.routing === "Manual" || connection.routing === "Automatic";
        if (upDown && drawn) {
            updates.push([connection.id, { routing: "Simple", corner: "Sharp", routePoints: [] }]);
            upDownStraightened += 1;
        }
        const held = lockedRooms.has(endpointA.roomNumber) || lockedRooms.has(endpointB.roomNumber);
        const moved = options.moved?.has(endpointA.roomNumber) === true || options.moved?.has(endpointB.roomNumber) === true;
        // Redrawn links are planned from scratch: their ports too.
        const redrawn = !held && (moved || options.redrawManual === true);
        const routable = connection.kind === "Internal" && !upDown && !held && members.length > 0 &&
            members.every((direction) => CARDINAL.has(direction)) &&
            (connection.routing !== "Manual" || redrawn);
        const fixedA = endpointA.portMode === "Manual" && !(routable && redrawn);
        const fixedB = endpointB.portMode === "Manual" && !(routable && redrawn);
        links.push({
            id: connection.id,
            from: String(endpointA.roomNumber),
            to: String(endpointB.roomNumber),
            fromSide: endpointA.side,
            toSide: endpointB.side,
            fromPort: endpointA.portOffset,
            toPort: endpointB.portOffset,
            fromPortFixed: fixedA,
            toPortFixed: fixedB,
            points: connection.routing === "Manual" && !upDown ? connection.routePoints : undefined,
            routable,
        });
        planned.set(connection.id, { connection, endpointB, freeA: !fixedA, freeB: !fixedB });
    }

    const summary: RouteSummary = { routed: 0, straightened: 0, calledOut: 0, upDownStraightened };
    for (const plan of planLinkRoutes(positions, links)) {
        const found = planned.get(plan.id);
        if (!found) continue;
        if (plan.points.length > 0) summary.routed += 1;
        if (plan.callout !== undefined) summary.calledOut += 1;
        const change = updatesFor(found, plan, mapId);
        if (!change) continue;
        if (change.routing === "Simple") summary.straightened += 1;
        updates.push([found.connection.id, change]);
    }
    if (updates.length > 0) {
        await mapper.mutateArea(areaId, async (mutation) => {
            for (const [id, change] of updates) await mutation.setConnection(id, change);
        }, { description: "Route Arctic map links" });
    }
    return summary;
}

/** One line saying what a routing pass did. */
export function routeSummaryText(name: string, summary: RouteSummary): string {
    const parts = [`${summary.routed} link${summary.routed === 1 ? "" : "s"} routed`];
    if (summary.straightened > 0) parts.push(`${summary.straightened} drawn straight again`);
    if (summary.calledOut > 0) parts.push(`${summary.calledOut} called out where they share a stretch`);
    if (summary.upDownStraightened > 0) {
        parts.push(`${summary.upDownStraightened} up/down link${summary.upDownStraightened === 1 ? "" : "s"} drawn straight`);
    }
    return `Routes in ${name}: ${parts.join(", ")}.`;
}
