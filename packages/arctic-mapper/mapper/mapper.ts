import { mapper, sendRaw, echo } from 'smudgy:core';
import { get } from 'smudgy:params';
import { idsMatch } from './ids.ts';
import { defaultOpenCommand, openCommandFor } from './doors.ts';
import { extendExit, linkNeedsOtherPlace } from './links.ts';
import { room as locationChanged } from 'smudgy:events/map';
import { RecordingPlaces, recordingArea } from "./recording-place.ts";

export { idsMatch } from './ids.ts';

export enum Direction {
    North = 'North',
    East = 'East',
    South = 'South',
    West = 'West',
    Up = 'Up',
    Down = 'Down',
};

export const SingleCharExit: Record<string, Direction> = {
    N: Direction.North,
    S: Direction.South,
    E: Direction.East,
    W: Direction.West,
    U: Direction.Up,
    D: Direction.Down,
};

export const OppositeDirection: Record<Direction, Direction> = {
    [Direction.North]: Direction.South,
    [Direction.East]: Direction.West,
    [Direction.South]: Direction.North,
    [Direction.West]: Direction.East,
    [Direction.Up]: Direction.Down,
    [Direction.Down]: Direction.Up,
}

export type MoveCommand = Direction | "look";

export const MoveCommands: Record<string, MoveCommand> = {
    n: Direction.North,
    no: Direction.North,
    nor: Direction.North,
    nort: Direction.North,
    north: Direction.North,
    e: Direction.East,
    ea: Direction.East,
    eas: Direction.East,
    east: Direction.East,
    s: Direction.South,
    sou: Direction.South,
    sout: Direction.South,
    south: Direction.South,
    w: Direction.West,
    we: Direction.West,
    wes: Direction.West,
    west: Direction.West,
    u: Direction.Up,
    up: Direction.Up,
    d: Direction.Down,
    ["do"]: Direction.Down,
    dow: Direction.Down,
    down: Direction.Down,
    l: "look",
    lo: "look",
    loo: "look",
    look: "look",
}

export const MoveCoordinates = {
    [Direction.North]: [0, -1, 0],
    [Direction.East]: [1, 0, 0],
    [Direction.South]: [0, 1, 0],
    [Direction.West]: [-1, 0, 0],
    [Direction.Up]: [0, 0, 1],
    [Direction.Down]: [0, 0, -1]
};

export const IsometricZMoveCoordinates = {
    [Direction.North]: [0, -1, 0],
    [Direction.East]: [1, 0, 0],
    [Direction.South]: [0, 1, 0],
    [Direction.West]: [-1, 0, 0],
    [Direction.Up]: [1, -1, 0],
    [Direction.Down]: [-1, 1, 0]
};

export enum ZMode {
    Auto,
    Normal,
    Isometric,
}

export enum Confidence {
    Full,
    Partial,
    None,
}

export enum State {
    Off,
    Following,
    Mapping,
    /** Following, plus movement commands open doors / use exit commands. */
    Active,
}

// --- Load-time configuration (smudgy:params) --------------------------------
// These read this package's configured options once at load. smudgy applies
// param changes on reload, so there are no live setters for them — `mode` keeps
// its existing `map off/follow/active` commands, but Z mode and text size are
// load-time only. Each falls back to its prior built-in default when unset or
// holding an unrecognized value.

/** A param's value as a string, or undefined when unset / not a string. */
function paramString(key: string): string | undefined {
    const value = get(key);
    return typeof value === "string" ? value : undefined;
}

/** The `mode` param (active/follow/off) -> the State the mapper starts in. */
const MODE_BY_PARAM: Record<string, State> = {
    active: State.Active,
    follow: State.Following,
    off: State.Off,
};
function configuredMode(): State {
    return MODE_BY_PARAM[paramString("mode") ?? ""] ?? State.Active;
}

/** The `zMode` param is a creation preference; existing links encode their own style. */
const ZMODE_BY_PARAM: Record<string, ZMode> = {
    auto: ZMode.Auto,
    normal: ZMode.Normal,
    levels: ZMode.Normal,
    isometric: ZMode.Isometric,
    projected: ZMode.Isometric,
};
function configuredZMode(): ZMode {
    return ZMODE_BY_PARAM[paramString("zMode") ?? ""] ?? ZMode.Auto;
}

/**
 * Named map-panel text sizes (pixels) for the `textSize` param. `medium` is the
 * prior built-in default (16 — Markdown's default, and the base the old
 * hard-coded flag size of 12 sat a quarter below).
 */
const TEXT_SIZES: Record<string, number> = {
    "x-small": 12,
    "small": 14,
    "medium": 16,
    "large": 20,
    "x-large": 24,
};
function configuredTextSize(): number {
    return TEXT_SIZES[paramString("textSize") ?? "small"] ?? TEXT_SIZES.medium;
}

/**
 * Side length (px) of the square map widget, from the numeric `widgetSize` param.
 * 350 is the default (the prior built-in size). A non-positive or non-numeric value
 * falls back to the default rather than collapsing the panel.
 */
const DEFAULT_WIDGET_SIZE = 225;
function configuredWidgetSize(): number {
    const value = get("widgetSize");
    return typeof value === "number" && value > 0 ? value : DEFAULT_WIDGET_SIZE;
}

export const DirectionLetter: Record<Direction, string> = {
    [Direction.North]: "n",
    [Direction.East]: "e",
    [Direction.South]: "s",
    [Direction.West]: "w",
    [Direction.Up]: "u",
    [Direction.Down]: "d",
};

/**
 * Speedwalk from `from` (default: the mapper's current room) to `to` along the
 * mapped shortest path, one hop at a time. ArcticMUD movement lives here rather
 * than in the host so each MUD owns its own conventions: per hop we first send
 * the exit's open command (its door's `opensWith`, or `open <name-or-door> <d>` when the door
 * is mapped closed), then the exit's `command` if set, else the direction
 * letter. Commands go out with `sendRaw` so the emitted directions do NOT
 * re-fire the movement-capture alias. With `alone`, directional movement commands
 * gain the `alone` argument; door and other custom commands keep their arguments.
 * Returns the number of hops walked.
 */
export function speedwalk(to: Room, from: Room | null = state.room, alone = false): number {
    if (!from) {
        return 0;
    }

    const path = mapper.getPathBetweenRooms(
        from.areaId,
        from.roomNumber,
        to.areaId,
        to.roomNumber,
    );
    if (path.length < 2) {
        return 0;
    }

    // Split on ";" and raw-send each command (an open command may be compound,
    // e.g. "unlock n;open n").
    const sendCommands = (raw: string, moveAlone = false) => {
        for (const part of raw.split(";")) {
            const command = part.trim();
            if (command) {
                const intent = MoveCommands[command.toLowerCase()];
                const modifier = moveAlone && intent && intent !== "look" ? " alone" : "";
                sendRaw(command + modifier + "\n");
            }
        }
    };

    let steps = 0;
    for (let i = 0; i < path.length - 1; i++) {
        const [stepAreaId, stepRoomNumber] = path[i];
        const [nextAreaId, nextRoomNumber] = path[i + 1];
        const room = mapper.getAreaById(stepAreaId).room(stepRoomNumber);
        if (!room) {
            continue;
        }
        const exit = room.exits.find((e) =>
            e.toRoomNumber === nextRoomNumber &&
            !!e.toAreaId && idsMatch(e.toAreaId, nextAreaId)
        );
        if (!exit) {
            continue;
        }

        const direction = exit.fromDirection as Direction;
        const letter = DirectionLetter[direction] ?? exit.fromDirection.toLowerCase();

        // Open the exit's door before stepping through it.
        const openCommand = openCommandFor(exit, defaultOpenCommand(exit, letter));
        if (openCommand) {
            sendCommands(openCommand);
        }

        // Move: an explicit exit command (e.g. "enter hole"), else the direction.
        sendCommands(exit.command && exit.command !== "" ? exit.command : letter, alone);
        steps++;
    }

    return steps;
}

function findAreaByName(name: string): Area {
    return mapper.areas.find((a) =>
        a.name.toLowerCase() === name.toLowerCase()
    );
}

type AreaChangedListener = (area: Area | null) => void;
const areaChangedListeners: AreaChangedListener[] = [];

/** Register a callback fired whenever the current area changes. */
export function onAreaChanged(listener: AreaChangedListener) {
    areaChangedListeners.push(listener);
}

type RoomChangedListener = (room: Room | null) => void;
const roomChangedListeners: RoomChangedListener[] = [];

/** Register a callback fired whenever the current room changes. */
export function onRoomChanged(listener: RoomChangedListener) {
    roomChangedListeners.push(listener);
}

const modeChangedListeners: ((mode: State) => void)[] = [];
export function onModeChanged(listener: (mode: State) => void) {
    modeChangedListeners.push(listener);
}

const infoChangedListeners: (() => void)[] = [];
export function onInfoChanged(listener: () => void) {
    infoChangedListeners.push(listener);
}
function infoChanged() {
    for (const listener of infoChangedListeners) listener();
}

export class MapState {
    readonly recordingPlaces = new RecordingPlaces();

    recordingDestination(): { map: Area; place: MapPlace; area: Area } {
        if (!this.area) throw new Error("Select a map before choosing a recording place.");
        const map = mapper.getAreaById(this.area.mapId ?? this.area.id);
        const place = this.recordingPlaces.place(map, this.area.place);
        return { map, place, area: recordingArea(map, place) };
    }

    selectRecordingPlace(map: Area, place: MapPlace): void {
        this.recordingPlaces.select(map, place);
        infoChanged();
    }
    #area: Area | null = null;
    #room: Room | null = null;
    possibleRooms: Room[] = [];
    #state: State = configuredMode();
    moveQueue: MoveCommand[] = [];
    lastMoveCommand = new Date();
    /** Exits from the most recent prompt; value is true when shown closed (parenthesized). Null when unknown. */
    seenExits: Map<Direction, boolean> | null = null;

    get state(): State { return this.#state; }
    set state(value: State) {
        if (this.#state === value) return;
        if (value === State.Mapping && this.area) {
            const map = mapper.getAreaById(this.area.mapId ?? this.area.id);
            this.recordingPlaces.place(map, this.area.place);
        }
        this.#state = value;
        for (const listener of modeChangedListeners) listener(value);
        infoChanged();
    }

    get area(): Area | null {
        return this.#area;
    }

    set area(value: Area | null) {
        const changed = !idsMatch(value?.id, this.#area?.id) || value?.name !== this.#area?.name;
        this.#area = value;
        infoChanged();
        if (changed) {
            for (const listener of areaChangedListeners) {
                listener(value);
            }
        }
    }

    get room(): Room | null {
        return this.#room;
    }

    set room(value: Room | null) {
        const changed = value?.roomNumber !== this.#room?.roomNumber
            || !idsMatch(value?.areaId, this.#room?.areaId);
        this.#room = value;
        infoChanged();
        if (changed) {
            for (const listener of roomChangedListeners) {
                listener(value);
            }
        }
    }

    setCurrentRoom(room: Room) {
        this.area = mapper.getAreaById(room.areaId);
        this.room = this.area.room(room.roomNumber);
        mapper.setCurrentLocation(room.areaId, room.roomNumber);
    }

    setCurrentPossibleRooms(rooms: Room[]) {
        this.possibleRooms = rooms;
    }

    clearMoveQueue() {
        this.moveQueue = [];
    }

    captureMoveCommand(command: MoveCommand, prepend: boolean = false) {
        if (prepend) {
            this.moveQueue.unshift(command);
        } else {
            // if the last move command is over ten seconds old, clear the queue
            if (this.lastMoveCommand.getTime() + 10000 < new Date().getTime()) {
                this.clearMoveQueue();
            }
            this.moveQueue.push(command);
            this.lastMoveCommand = new Date();
        }
    }

    popMoveCommand(): MoveCommand | undefined {
        return this.moveQueue.shift();
    }

    refreshRoomAndArea() {
        if (this.area) {
            this.area = mapper.getAreaById(this.area.id);

            if (this.room) {
                this.room = this.area.room(this.room.roomNumber);
            }
        }
    }

    getRoomFromRoomTag(key: string): Room | null {
        if (/^\d+$/.test(key)) {
            return this.area?.room(parseInt(key)) ?? null;
        }

        const match = /^(.+)#(\d+)$/.exec(key);
        if (match) {
            const areaName = match[1];
            const roomNumber = parseInt(match[2]);
            return findAreaByName(areaName)?.room(roomNumber) ?? null;
        }

        return null;
    }
}

export class MapOptions {
    debug: boolean = false;
    debugRaw: boolean = false;
    /** Session-only opt-in to repair layout defects introduced by new rooms. */
    autoAdjustMapLayout: boolean = false;
    /** Creation preference for new U/D links; Auto infers the nearby section. */
    zMode: ZMode = configuredZMode();
    /** Base text size (px) for the map panel's text/button/markdown widgets (the `textSize` param). */
    textSize: number = configuredTextSize();
    /** Side length (px) of the square map widget (the `widgetSize` param). */
    widgetSize: number = configuredWidgetSize();
    /** First note link: Ctrl+Enter locally, +Alt in all sessions, +Shift in other sessions. */
    noteLinkHotkeys: boolean = get("noteLinkHotkeys") !== false;
    /** Insert the first room note link's label into the game's prompt. */
    noteLinkPromptHint: boolean = get("noteLinkPromptHint") !== false;

    get moveCoordinates() {
        // Coordinate-only legacy operations have no topology to infer from.
        // Auto therefore uses levels; room creation infers the nearby section.
        return this.zMode === ZMode.Isometric ? IsometricZMoveCoordinates : MoveCoordinates;
    }
}

export const state = new MapState();
export const options = new MapOptions();

// Editor moves between Map, Private and Secrets can renumber a room. The host's
// location event already carries its new address; don't keep a stale Room handle.
function adoptLocation(areaId: AreaId, roomNumber: RoomNumber | null) {
    state.area = mapper.getAreaById(areaId);
    state.room = roomNumber === null ? null : state.area.room(roomNumber) ?? null;
}
locationChanged.on(({ areaId, roomNumber }) => adoptLocation(areaId, roomNumber));
const initialLocation = mapper.getCurrentLocation();
if (initialLocation) adoptLocation(initialLocation.area, initialLocation.room ?? null);

/** Echo a diagnostic line when `map debug` is on. */
export function debugLog(message: string) {
    if (options.debug) {
        echo(`[mapper] ${message}`);
    }
}

export const EXIT_MASK = {
    [Direction.North]: 0b100000,
    [Direction.East]: 0b010000,
    [Direction.South]: 0b001000,
    [Direction.West]: 0b000100,
    [Direction.Up]: 0b000010,
    [Direction.Down]: 0b000001,
}

export interface ExitObservation {
    direction: Direction;
    /** True when the exit appeared parenthesized in the prompt — a closed door. */
    closed: boolean;
}

/** Parse a prompt exit list like "(E)S" or "(ES)" — parenthesized exits are closed. */
export function parseRoomExitsDetailed(exits: string | undefined): ExitObservation[] {
    const result: ExitObservation[] = [];
    let inParens = false;
    for (const c of exits ?? "") {
        if (c === "(") {
            inParens = true;
        } else if (c === ")") {
            inParens = false;
        } else {
            const direction = SingleCharExit[c as keyof typeof SingleCharExit];
            if (direction) {
                result.push({ direction, closed: inParens });
            }
        }
    }
    return result;
}

export function parseRoomExits(exits: string | undefined): Direction[] {
    return parseRoomExitsDetailed(exits).map((e) => e.direction);
}

export async function linkRooms(from: Room, to: Room, direction: Direction, createReturnExit: boolean = true): Promise<ExitId[]> {
    const opposite = OppositeDirection[direction];
    const destination = (target: Room, leaving: Direction, arriving: Direction): ExitArgs & { toAreaId: AreaId; toRoomNumber: RoomNumber } => ({
        fromDirection: leaving, toDirection: arriving,
        toAreaId: target.areaId, toRoomNumber: target.roomNumber,
    });
    const forward = destination(to, direction, opposite);
    const reverse = destination(from, opposite, direction);
    const foreignForward = linkNeedsOtherPlace(from, forward);
    const foreignReverse = createReturnExit && linkNeedsOtherPlace(to, reverse);
    if (idsMatch(from.areaId, to.areaId) && !foreignForward && !foreignReverse) {
        const ids: ExitId[] = [];
        await mapper.mutateArea(from.areaId, async mutation => {
            ids.push(await extendExit(mutation, from, forward));
            if (createReturnExit) ids.push(await extendExit(mutation, to, reverse));
        }, { description: "Link Arctic rooms" });
        if (ids.length === 2) await pairReciprocalExits(from.areaId, from.roomNumber, ids[0], to.roomNumber, ids[1]);
        return ids;
    }
    const writer = (area: AreaId) => ({
        createRoomExit: (room: Room | RoomNumber, exit: ExitArgs) => mapper.createRoomExit(area, room, exit),
        setRoomExit: async (room: Room | RoomNumber, id: ExitIdLike, exit: ExitUpdates) => {
            await mapper.setRoomExit(area, room, id, exit);
        },
    });
    // Individual exit updates route by exit identity to its own place, including
    // Secret/Private doors attached to map rooms.
    const ids = [await extendExit(writer(from.areaId), from, forward)];
    if (createReturnExit) ids.push(await extendExit(writer(to.areaId), to, reverse));
    return ids;
}

/**
 * Joins two reciprocal exits of one area into one two-way link. The host pairs
 * an exit with its partner's Connection only when the exit is created, so two
 * existing stubs pointed at each other stay two one-way links until paired.
 */
export async function pairReciprocalExits(
    areaId: AreaId,
    from: RoomNumber,
    forward: ExitId,
    to: RoomNumber,
    back: ExitId,
): Promise<void> {
    const area = mapper.getAreaById(areaId);
    const kept = area.room(from)?.exits.find((exit) => exit.id === forward)?.connectionId;
    const merged = area.room(to)?.exits.find((exit) => exit.id === back)?.connectionId;
    if (kept && merged && kept !== merged) await mapper.pairConnections(areaId, kept, merged);
}

export function findRoomsAt(x: number, y: number, level: number, area: Area | null = state.area): Room[] {
    const radius = 0.25;

    const rooms: Room[] = [];

    if (!area) {
        return rooms;
    }

    for (const roomNumber of area.roomNumbers) {
        const room = area.room(roomNumber);
        const roomX = room.x;
        const roomY = room.y;
        const roomLevel = room.level;

        if (Math.abs(roomX - x) <= radius && Math.abs(roomY - y) <= radius && roomLevel === level) {
            rooms.push(room);
        }
    }

    return rooms;
}

export function findRoomsInRect(x1: number, y1: number, x2: number, y2: number, level: number): Room[] {
    const rooms: Room[] = [];

    if (!state.area) {
        return rooms;
    }

    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    for (const roomNumber of state.area.roomNumbers) {
        const room = state.area.room(roomNumber);
        if (room.level === level && room.x >= minX && room.x <= maxX && room.y >= minY && room.y <= maxY) {
            rooms.push(room);
        }
    }

    return rooms;
}

function linesIntersect(xa1, ya1, xa2, ya2, xb1, yb1, xb2, yb2) {
    const det = (xa2 - xa1) * (yb2 - yb1) - (xb2 - xb1) * (ya2 - ya1);
    if (det === 0) {
        return false;
    } else {
        const lambda = ((yb2 - yb1) * (xb2 - xa1) + (xb1 - xb2) * (yb2 - ya1)) / det;
        const gamma = ((ya1 - ya2) * (xb2 - xa1) + (xa2 - xa1) * (yb2 - ya1)) / det;
        return (0 < lambda && lambda < 1) && (0 < gamma && gamma < 1);
    }
};

export function distanceBetweenRooms(a: Room, b: Room) {
    if (!a || !b) {
        return Number.MAX_VALUE;
    }
    return Math.sqrt(Math.abs(a.x - b.x) ** 2 + Math.abs(a.y - b.y) ** 2 + Math.abs(a.level - b.level) ** 2);
}

export function findRoomsWithExitsThrough(x1: number, y1: number, x2: number, y2: number, level: number): Room[] {
    const result = [];
    const seenRoomNumbers = new Set<number>();

    if (!state.area) {
        return result;
    }

    for (const roomNumber of state.area.roomNumbers) {
        const room = state.area.room(roomNumber);
        if (room.level !== level) {
            continue;
        }

        for (const exit of room.exits) {
            if (typeof exit.toRoomNumber === "number" && exit.toAreaId && idsMatch(exit.toAreaId, exit.fromAreaId)) {
                const to_room = state.area.room(exit.toRoomNumber);
                if (to_room.level !== level) {
                    continue;
                }

                const from_x = room.x;
                const from_y = room.y;
                const to_x = to_room.x;
                const to_y = to_room.y;

                if (linesIntersect(x1, y1, x2, y2, from_x, from_y, to_x, to_y)) {
                    if (!seenRoomNumbers.has(room.roomNumber)) {
                        result.push(room);
                        seenRoomNumbers.add(room.roomNumber);
                    }
                    if (!seenRoomNumbers.has(to_room.roomNumber)) {
                        result.push(to_room);
                        seenRoomNumbers.add(to_room.roomNumber);
                    }
                }
            }
        }
    }

    return result;
}


export function roomsImpactedByPush(room: Room, direction: Direction, found: Set<RoomNumber> = new Set()): RoomNumber[] {
    const recurseTo = [];

    found.add(room.roomNumber);

    // rooms impacted by the push are the rooms that are near where we are pushing to, and any rooms connected perpendicular to
    // the room itself or to any affected rooms

    const offset = options.moveCoordinates[direction];

    const exitsToFollow = direction === Direction.North ? [Direction.East, Direction.West, Direction.Up, Direction.Down] :
        direction === Direction.East ? [Direction.North, Direction.South, Direction.Up, Direction.Down] :
            direction === Direction.South ? [Direction.East, Direction.West, Direction.Up, Direction.Down] :
                direction === Direction.West ? [Direction.North, Direction.South, Direction.Up, Direction.Down] :
                    [];


    for (const exit of room.exits) {
        if (typeof exit.toRoomNumber === "number" && exitsToFollow.includes(exit.fromDirection as Direction) && exit.toAreaId && idsMatch(exit.fromAreaId, exit.toAreaId)) {
            if (!found.has(exit.toRoomNumber)) {
                const toRoom = state.area.room(exit.toRoomNumber);

                if (toRoom && toRoom.level === room.level) {
                    recurseTo.push(exit.toRoomNumber);

                    // if the exit will move across any rooms during the push, push those rooms too
                    const roomsToAdd = findRoomsInRect(room.x, room.y, toRoom.x + offset[0] * 1.5, toRoom.y + offset[1] * 1.5, room.level);
                    for (const room of roomsToAdd) {
                        if (!found.has(room.roomNumber)) {
                            recurseTo.push(room.roomNumber);
                        }
                    }
                }
            }
        }
    }

    const willCollideWith = findRoomsAt(room.x + offset[0], room.y + offset[1], room.level + offset[2]);

    for (const room of willCollideWith) {
        if (!found.has(room.roomNumber)) {
            recurseTo.push(room.roomNumber);
        }
    }

    const intersectX = room.x + offset[0] * 1.5;
    const intersectY = room.y + offset[1] * 1.5;
    const willIntersectWith = findRoomsWithExitsThrough(room.x, room.y, intersectX, intersectY, room.level);

    for (const room of willIntersectWith) {
        if (!found.has(room.roomNumber)) {
            recurseTo.push(room.roomNumber);
        }
    }

    for (const roomNumber of recurseTo) {
        found.add(roomNumber);
    }

    const foundThroughRecursion = recurseTo.flatMap((roomNumber) => roomsImpactedByPush(state.area.room(roomNumber), direction, found));

    for (const roomNumber of foundThroughRecursion) {
        found.add(roomNumber);
    }

    return [...found.values()];
}
