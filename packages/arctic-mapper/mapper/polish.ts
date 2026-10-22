/**
 * `map reflow`: polishes one whole area with map-layout's deep search, the
 * constraint repair nukefire-mapper's `nfmap tidy` runs, beside the anchored
 * reflow tournament. Both run on planner Workers of their own, so new-room
 * planning never waits behind them, and every better layout either finds goes
 * on the map while they continue.
 */

import { mapper } from "smudgy:core";
import {
    compareLayoutQuality,
    createLayoutModel,
    createLayoutPlanner,
    layoutSnapshotKey,
    loadLayoutModel,
    measureIntegralLayoutQuality,
    resolveElevationGeometry,
    type ConstraintRepairOptions,
    type GridPosition,
    type IntegralLayoutPlan,
    type LayoutModel,
    type LayoutPlanner,
    type LayoutPlannerSnapshot,
    type LayoutQuality,
} from "smudgy:@map-layout";
import { LatestValueQueue } from "./latest-value-queue.ts";
import { placeKey } from "./places.ts";

export interface PolishScale {
    residentCount: number;
    edgeCount: number;
}

type RepairLimits = Required<Omit<ConstraintRepairOptions, "when" | "maxDurationMs">>;

/** Budgets the smallest maps receive. */
const SMALL_MAP_CEILINGS: RepairLimits = {
    maxRestarts: 100_000,
    maxLayouts: 8,
    maxPolishTournaments: 16,
    maxPolishPasses: 16,
    maxExtensionStates: 4_194_304,
    maxLiveSearchNodes: 32_768,
    maxMaskDiversifications: 512,
    maxCrossingWork: 4_096,
};

/** Budgets every map at or beyond the largest planned shape receives. */
const LARGEST_MAP_FLOORS: RepairLimits = {
    maxRestarts: 32_768,
    maxLayouts: 2,
    maxPolishTournaments: 2,
    maxPolishPasses: 3,
    maxExtensionStates: 32_768,
    maxLiveSearchNodes: 4_096,
    maxMaskDiversifications: 64,
    maxCrossingWork: 512,
};

/** 256 rooms with three exits each: 256 × (256 + 768). */
const LARGEST_MAP_PRESSURE = 262_144;

/**
 * The search budgets of nukefire-mapper's `nf reflow perfect`. There is no
 * wall deadline; each work ceiling scales with the reciprocal of
 * rooms × (rooms + exits) between its floor and ceiling, so neighboring map
 * sizes receive neighboring budgets and the result does not depend on the
 * machine's speed.
 */
export function deepPolishPolicy(scale: Readonly<PolishScale>): ConstraintRepairOptions {
    const residents = Math.max(1, Math.floor(scale.residentCount));
    const edges = Math.max(0, Math.floor(scale.edgeCount));
    const pressure = residents * Math.max(1, residents + edges);
    const budget = (key: keyof RepairLimits): number => Math.min(
        SMALL_MAP_CEILINGS[key],
        Math.max(LARGEST_MAP_FLOORS[key], Math.floor((LARGEST_MAP_FLOORS[key] * LARGEST_MAP_PRESSURE) / pressure)),
    );
    return {
        when: "always",
        maxDurationMs: Number.POSITIVE_INFINITY,
        maxRestarts: budget("maxRestarts"),
        maxLayouts: budget("maxLayouts"),
        maxPolishTournaments: budget("maxPolishTournaments"),
        maxPolishPasses: budget("maxPolishPasses"),
        maxExtensionStates: budget("maxExtensionStates"),
        maxLiveSearchNodes: budget("maxLiveSearchNodes"),
        maxMaskDiversifications: budget("maxMaskDiversifications"),
        maxCrossingWork: budget("maxCrossingWork"),
    };
}

/**
 * A layout quality as wrong exits / blocked routes / crossings, and how many
 * of the wrong exits join rooms on the wrong levels when any do.
 */
export function qualitySummary(quality: Readonly<LayoutQuality> | undefined): string {
    if (!quality) return "?";
    const summary = `${quality.cardinalRayViolations}/${quality.routingViolations}/${quality.linkCrossings}`;
    const level = quality.levelViolations ?? 0;
    return level > 0 ? `${summary} (${level} on the wrong level)` : summary;
}

/** Elapsed time as minutes and seconds. */
export function elapsedClock(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** `count` of `noun`, which takes an s for any count but one. */
export function counted(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The planner's first stages, which build the layouts it starts from. */
const STARTING_STAGES = new Set(["stable", "golden", "exact-new", "chart-reflow", "all-candidates"]);

function plannerStage(snapshot: Readonly<LayoutPlannerSnapshot>): string {
    const stage = snapshot.phase || snapshot.status;
    return STARTING_STAGES.has(stage) ? "starting layouts" : stage.replaceAll("-", " ");
}

export interface PolishProgressOverrides {
    /** What the polish is doing, in place of the planner's stage. */
    stage?: string;
    /** A better layout than the planner's best, found by another search. */
    best?: Readonly<LayoutQuality>;
}

/**
 * One line of a running polish: its map and time, what the planner is doing,
 * the best layout found so far against the map as it started, the work behind
 * it, and how many layouts are on the map.
 */
export function polishProgressLine(
    map: string,
    elapsedMs: number,
    snapshot: Readonly<LayoutPlannerSnapshot> | undefined,
    applied: number,
    overrides: PolishProgressOverrides = {},
): string {
    const parts = [`${map} ${elapsedClock(elapsedMs)}`];
    if (!snapshot) {
        parts.push(overrides.stage ?? "waiting for the planner");
    } else {
        parts.push(overrides.stage ?? plannerStage(snapshot));
        const planned = snapshot.bestQuality ?? snapshot.standardQuality;
        const best = planned && overrides.best && compareLayoutQuality(overrides.best, planned) > 0
            ? overrides.best
            : planned ?? overrides.best;
        parts.push(best
            ? `best ${qualitySummary(best)} from ${qualitySummary(snapshot.currentQuality)}`
            : `now ${qualitySummary(snapshot.currentQuality)}`);
        const { work } = snapshot;
        const counts = [
            work.layoutsConsidered > 0 ? counted(work.layoutsConsidered, "layout") : "",
            work.feasibilityChecks > 0 ? counted(work.feasibilityChecks, "check") : "",
            work.restarts > 0 ? counted(work.restarts, "restart") : "",
            work.crossingsConsidered > 0 ? `${counted(work.crossingsConsidered, "crossing")} tried` : "",
        ].filter((count) => count !== "");
        if (counts.length > 0) parts.push(counts.join(", "));
    }
    if (applied > 0) parts.push(`${applied} on the map`);
    return parts.join(" | ");
}

function samePosition(a: GridPosition, b: GridPosition): boolean {
    return a.x === b.x && a.y === b.y && a.level === b.level;
}

/**
 * The model `loadLayoutModel` reads once `positions` are on the map: Up/Down
 * geometry resolves from the levels the rooms end on.
 */
function modelAt(model: LayoutModel, positions: ReadonlyMap<string, GridPosition>): LayoutModel {
    return resolveElevationGeometry(createLayoutModel({
        areaId: model.areaId,
        rooms: model.rooms.map((room) => ({ ...room, position: positions.get(room.id) ?? room.position })),
        edges: model.edges.map(({ constraintVector: _resolved, ...edge }) => edge),
    }));
}

/**
 * Moves the area's rooms from where `from` has them to `positions`, and
 * returns the rooms that moved. The host refuses a drawn route between rooms
 * on different levels, so a Manual or Automatic route at a room that changes
 * level is drawn straight while the rooms move, and gets its routing back
 * once both of its rooms share a level again.
 */
export async function moveRooms(
    areaId: AreaId,
    from: LayoutModel,
    positions: ReadonlyMap<string, GridPosition>,
): Promise<RoomNumber[]> {
    const updates: [RoomNumber, UpdateRoomParams][] = [];
    const relevelled = new Set<RoomNumber>();
    for (const room of from.rooms) {
        const next = positions.get(room.id);
        if (room.roomNumber === undefined || !next || samePosition(room.position, next)) continue;
        updates.push([room.roomNumber, { x: next.x, y: next.y, level: next.level }]);
        if (next.level !== room.position.level) relevelled.add(room.roomNumber);
    }
    if (updates.length === 0) return [];

    const area = mapper.getAreaById(areaId);
    const own = placeKey(area.place);
    const relevels = (endpoint: ConnectionEndpoint | null): boolean => !!endpoint &&
        (endpoint.place === undefined || endpoint.place === own) && relevelled.has(endpoint.roomNumber);
    const drawn = relevelled.size === 0 ? [] : area.connections.filter((connection) =>
        (connection.routing === "Manual" || connection.routing === "Automatic") &&
        (relevels(connection.endpointA) || relevels(connection.endpointB)));
    await mapper.mutateArea(areaId, async (mutation) => {
        for (const connection of drawn) await mutation.setConnection(connection.id, { routing: "Simple" });
        await mutation.updateRooms(updates);
    }, { description: "Polish Arctic map layout" });

    if (drawn.length > 0) {
        const kinds = new Map(mapper.getAreaById(areaId).connections.map((connection) => [connection.id, connection.kind]));
        const restored = drawn.filter((connection) => kinds.get(connection.id) === "Internal");
        if (restored.length > 0) {
            await mapper.mutateArea(areaId, async (mutation) => {
                for (const connection of restored) {
                    await mutation.setConnection(connection.id, { routing: connection.routing });
                }
            }, { description: "Restore drawn Arctic map routes" });
        }
    }
    return updates.map(([roomNumber]) => roomNumber);
}

class MapChangedError extends Error {
    constructor() {
        super("The map changed while it was being polished.");
        this.name = "MapChangedError";
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

type Candidate = Pick<IntegralLayoutPlan, "positions" | "quality">;

export interface PolishOptions {
    say(line: string): void;
    /** Called after each layout goes on the map, with the rooms it moved. */
    moved?(rooms: readonly RoomNumber[]): void;
    /** The room the tournament tries as its first anchor, usually the player's. */
    anchor?: RoomNumber;
    createPlanner?: () => LayoutPlanner;
    /** Time between progress lines. */
    progressIntervalMs?: number;
    /** Least time between two layouts going on the map; the first and the last never wait. */
    minApplyIntervalMs?: number;
}

const PROGRESS_INTERVAL_MS = 10_000;
const MIN_APPLY_INTERVAL_MS = 1_500;

/**
 * Polishes one whole area and says how it went. Each better layout goes on the
 * map as the search finds it, paced so a fast-improving search reads as
 * improvement rather than churn; one arriving meanwhile replaces the one
 * waiting. A stop keeps the best layout already on the map, and so does a map
 * that changes while it is polished: the polish only ever writes over the map
 * it planned from.
 */
async function polishArea(areaId: AreaId, signal: AbortSignal, options: PolishOptions): Promise<void> {
    const { say } = options;
    const name = mapper.getAreaById(areaId).name;
    const source = loadLayoutModel(areaId);
    const residents = source.rooms.map((room) => ({ id: room.id, position: room.position, movable: room.movable }));
    const edges = source.edges;
    if (!residents.some((resident) => resident.movable) || edges.length === 0) {
        say(`${name}: nothing to polish.`);
        return;
    }
    const before = measureIntegralLayoutQuality(
        new Map(residents.map((resident) => [resident.id, resident.position])),
        edges,
    );
    say(`Polishing ${name}: ${counted(residents.length, "room")}, ${counted(edges.length, "exit")}, ` +
        `now ${qualitySummary(before)} (wrong exits/blocked routes/crossings). Type "map stop" to stop.`);

    const policy = deepPolishPolicy({ residentCount: residents.length, edgeCount: edges.length });
    const startedAt = performance.now();
    let expected = layoutSnapshotKey(source);
    let onMap: Readonly<LayoutQuality> = before;
    let applied = 0;
    let latest: Readonly<LayoutPlannerSnapshot> | undefined;
    let failure: unknown;
    const planning = new AbortController();
    const stopPlanning = (): void => planning.abort();
    signal.addEventListener("abort", stopPlanning, { once: true });
    if (signal.aborted) planning.abort();

    const apply = async (plan: Candidate): Promise<void> => {
        if (planning.signal.aborted || compareLayoutQuality(plan.quality, onMap) <= 0) return;
        const live = loadLayoutModel(areaId);
        if (layoutSnapshotKey(live) !== expected) throw new MapChangedError();
        const moved = await moveRooms(areaId, live, plan.positions);
        expected = layoutSnapshotKey(modelAt(live, plan.positions));
        onMap = plan.quality;
        applied += 1;
        options.moved?.(moved);
    };
    const writes = new LatestValueQueue<Candidate>(apply, (error) => {
        failure = error;
        planning.abort();
    }, { minIntervalMs: options.minApplyIntervalMs ?? MIN_APPLY_INTERVAL_MS });
    let offered: Readonly<LayoutQuality> = before;
    const offer = (plan: Candidate): void => {
        if (compareLayoutQuality(plan.quality, offered) <= 0) return;
        offered = plan.quality;
        writes.push(plan);
    };
    let stage: string | undefined;
    const progress = setInterval(
        () => say(polishProgressLine(name, performance.now() - startedAt, latest, applied, { stage, best: offered })),
        options.progressIntervalMs ?? PROGRESS_INTERVAL_MS,
    );
    const planners: LayoutPlanner[] = [];
    const planner = (): LayoutPlanner => {
        const created = (options.createPlanner ?? createLayoutPlanner)();
        planners.push(created);
        return created;
    };
    // Two searches run side by side, each on Workers of its own. The deep search
    // starts from the standard plan; the tournament tries anchors from the map as
    // it is, and finds layouts the deep search can miss.
    let deepDone = false;
    let tournamentDone = false;
    const deep = (async () => {
        offer(await planner().planIntegral({ residents, nodes: [], edges, allowExistingMoves: true }, {
            signal: planning.signal,
            currentQuality: before,
            constraintRepair: policy,
            plannerContext: { source: "arctic-mapper:reflow", areaId, areaName: name },
            onProgress: (update) => {
                latest = update.snapshot;
                if (update.improvement) offer(update.improvement);
            },
        }));
    })().finally(() => {
        deepDone = true;
        if (!tournamentDone) stage = "anchored reflow";
    });
    const anchor = options.anchor !== undefined && source.rooms.some((room) => room.roomNumber === options.anchor)
        ? String(options.anchor)
        : undefined;
    const tournament = (async () => {
        offer(await planner().planModel(source, { type: "reflow", anchor }, { effort: "thorough" }, {
            signal: planning.signal,
        }));
    })().finally(() => {
        tournamentDone = true;
        if (deepDone) stage = undefined;
    });
    const outcomes = await Promise.allSettled([deep, tournament]);
    clearInterval(progress);
    signal.removeEventListener("abort", stopPlanning);
    for (const created of planners) created.close();
    const plannerError = outcomes.find((outcome) => outcome.status === "rejected")?.reason;
    const searched = outcomes.every((outcome) => outcome.status === "fulfilled");
    // A stop writes nothing more; a write already under way finishes.
    if (signal.aborted) writes.discardPending();
    try {
        await writes.flush();
    } catch {
        // `failure` holds it.
    }

    const elapsed = elapsedClock(performance.now() - startedAt);
    const kept = `it keeps ${qualitySummary(onMap)}`;
    if (signal.aborted) {
        say(`Stopped polishing ${name} after ${elapsed}; ${kept}.`);
    } else if (failure !== undefined) {
        say(failure instanceof MapChangedError
            ? `${name} changed while it was being polished; ${kept}. Type "map reflow" to polish it again.`
            : `Polishing ${name} failed: ${message(failure)}; ${kept}.`);
    } else if (!searched) {
        say(`The search for ${name} stopped after ${elapsed}: ${message(plannerError)}; ${kept}.`);
    } else {
        say(applied > 0
            ? `Polished ${name} in ${elapsed}: ${qualitySummary(before)} -> ${qualitySummary(onMap)}.`
            : `${name} needed nothing (${elapsed}); it stays ${qualitySummary(onMap)}.`);
    }
}

let running: { name: string; stop: AbortController } | undefined;

/** Starts polishing `areaId` unless a polish is already running. */
export function startPolish(areaId: AreaId, options: PolishOptions): Promise<void> | undefined {
    if (running) {
        options.say(`Already polishing ${running.name}; type "map stop" to stop it.`);
        return undefined;
    }
    const current = { name: mapper.getAreaById(areaId).name, stop: new AbortController() };
    running = current;
    return polishArea(areaId, current.stop.signal, options)
        .catch((error) => options.say(`Polishing ${current.name} failed: ${message(error)}`))
        .finally(() => {
            if (running === current) running = undefined;
        });
}

/** Stops the running polish; false when none is running. */
export function stopPolish(): boolean {
    if (!running) return false;
    running.stop.abort();
    return true;
}
