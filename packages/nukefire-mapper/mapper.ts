import { echo, mapper, type EventSubscription } from "smudgy:core";
import {
  nukefire,
  onMessage,
  watchMessage,
  type NukeFireMapLink,
  type NukeFireMapLocal,
  type NukeFireMapRoom,
  type RoomInfo,
} from "smudgy://kapusniak/nukefire-gmcp";
import {
  directionSide,
  externalRoomId,
  isFiniteCoordinate,
  isUsableVnum,
  mapDirection,
  terrainColor,
  type MappedDirection,
} from "./model.ts";
import {
  planIntegralLayout,
  type GridPosition,
  type LayoutDirection,
  type LayoutEdge,
  type LayoutNode,
  type LayoutResident,
  type LayoutTraceEvent,
} from "./layout.ts";
import {
  DEFAULT_DECISION_LOG_FILE,
  MappingDecisionLogger,
  type DecisionLogRecord,
} from "./decision-log.ts";
import {
  directRoomObstructions,
  routeAroundRooms,
  routeEndSide,
  routeStartSide,
  routeTurnPoints,
  type RouteSide,
} from "./routing.ts";

const AREA_ZONE_PROPERTY = "nukefire.zone";
const AREA_SOURCE_PROPERTY = "nukefire.mapper";
const ROOM_ZONE_PROPERTY = "nukefire.zone";
const ROOM_TERRAIN_PROPERTY = "terrain";
const ROOM_LAYOUT_LOCK_PROPERTY = "nukefire.layout.locked";
const SOURCE_NAME = "NukeFire.Map.Local";

export interface NukeFireMapperOptions {
  /** Prefix used when Room.Info has not supplied the zone's display name. */
  areaPrefix?: string;
  /** Explicit storage for newly managed areas. Defaults to local. */
  storage?: MapStorage;
  /**
   * @deprecated Supported through Smudgy 0.7.x; removed in 0.8.0.
   * Use `storage: "session"` instead.
   */
  ephemeral?: boolean;
  /** Allow the integral-grid planner to reflow existing NukeFire rooms. Default true. */
  updateCoordinates?: boolean;
  /** Append structured decisions beneath package $DATA, or false to disable. */
  decisionLogFile?: string | false;
}

interface Assignment {
  source: NukeFireMapRoom;
  area: AreaMirror;
  room?: RoomMirror;
  position?: GridPosition;
  positionApplied?: boolean;
}

interface ExitMirror {
  /** Missing only for traversals just created atomically with a connection. */
  id?: ExitId;
  fromDirection: ExitDirection;
  toDirection: ExitDirection | null;
  toAreaId: AreaId | null;
  toRoomNumber: RoomNumber | null;
  hidden: boolean;
  closed: boolean;
  locked: boolean;
  weight: number;
  command: string | null;
}

interface RoomMirror {
  areaId: AreaId;
  roomNumber: RoomNumber;
  vnum?: number;
  externalId?: string;
  title: string;
  color: string;
  position: GridPosition;
  layoutLocked: boolean;
  zone?: string;
  terrain?: string;
  exits: ExitMirror[];
}

interface ConnectionMirror {
  id: ConnectionId;
  endpointA: ConnectionEndpoint;
  endpointB: ConnectionEndpoint | null;
  routing: ConnectionRouting;
  segmentShape: ConnectionSegmentShape;
  routePoints: MapPoint[];
}

interface AreaMirror {
  id: AreaId;
  name: string;
  storage: MapStorage;
  zone?: string;
  source?: string;
  roomsByNumber: Map<RoomNumber, RoomMirror>;
  connections: Map<string, ConnectionMirror>;
}

interface DesiredConnectionGeometry {
  endpoint_a: ConnectionEndpoint;
  endpoint_b: ConnectionEndpoint;
  routing: ConnectionRouting;
  segment_shape: ConnectionSegmentShape;
  route_points: MapPoint[];
}

function clone<T>(value: Readonly<T>): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function areaKey(area: { id: AreaId }): string {
  return areaIdKey(area.id);
}

function areaIdKey(areaId: AreaId): string {
  return `${areaId[0]}:${areaId[1]}`;
}

function sameAreaId(a: AreaId, b: AreaId): boolean {
  return areaIdKey(a) === areaIdKey(b);
}

function residentId(roomNumber: RoomNumber): string {
  return `room:${roomNumber}`;
}

function newRoomId(vnum: number): string {
  return `vnum:${vnum}`;
}

function geometrySignature(geometry: DesiredConnectionGeometry): string {
  return JSON.stringify({
    a: geometry.endpoint_a,
    b: geometry.endpoint_b,
    routing: geometry.routing,
    shape: geometry.segment_shape,
    points: geometry.route_points,
  });
}

function connectionSignature(connection: ConnectionMirror): string {
  if (!connection.endpointB) return "";
  return geometrySignature({
    endpoint_a: connection.endpointA,
    endpoint_b: connection.endpointB,
    routing: connection.routing,
    segment_shape: connection.segmentShape,
    route_points: connection.routePoints,
  });
}

function roomVnum(room: Room | RoomMirror): number | undefined {
  if ("vnum" in room) return room.vnum;
  const raw = room.externalId?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return isUsableVnum(value) && String(value) === raw ? value : undefined;
}

function roundedPosition(x: number, y: number, level: number): GridPosition {
  return { x: Math.round(x), y: Math.round(y), level: Math.round(level) };
}

function serializedPositions(positions: ReadonlyMap<string, GridPosition>): {
  id: string;
  x: number;
  y: number;
  level: number;
}[] {
  return [...positions]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, position]) => ({ id, ...position }));
}

function validRoom(room: NukeFireMapRoom): boolean {
  return isUsableVnum(room.vnum) &&
    isFiniteCoordinate(room.x) &&
    isFiniteCoordinate(room.y) &&
    isFiniteCoordinate(room.z) &&
    Number.isSafeInteger(room.zone);
}

function commandKey(command: string | null): string {
  return (command ?? "").trim().toLowerCase();
}

function matchingExit(room: RoomMirror, mapped: MappedDirection): ExitMirror | undefined {
  if (mapped.direction === "Special") {
    return room.exits.find((exit) =>
      exit.fromDirection === "Special" && commandKey(exit.command) === mapped.command
    );
  }
  return room.exits.find((exit) => exit.fromDirection === mapped.direction);
}

function exitLeadsTo(exit: ExitMirror | undefined, destination: RoomMirror | undefined): boolean {
  return !!exit && !!destination && exit.toAreaId !== null && exit.toRoomNumber !== null &&
    sameAreaId(exit.toAreaId, destination.areaId) &&
    exit.toRoomNumber === destination.roomNumber;
}

function topologyTraversalKey(from: number, to: number, command: string): string {
  return `${from}>${to}:${command}`;
}

function copyEndpoint(endpoint: ConnectionEndpoint): ConnectionEndpoint {
  return {
    room_number: endpoint.room_number,
    side: endpoint.side,
    port_offset: endpoint.port_offset,
    port_mode: endpoint.port_mode,
  };
}

function copyExit(exit: Exit): ExitMirror {
  return {
    id: exit.id,
    fromDirection: exit.from_direction,
    toDirection: exit.to_direction,
    toAreaId: exit.to_area_id,
    toRoomNumber: exit.to_room_number,
    hidden: exit.is_hidden,
    closed: exit.is_closed,
    locked: exit.is_locked,
    weight: exit.weight,
    command: exit.command,
  };
}

function exitFromFields(fields: ExitArgs, id?: ExitId): ExitMirror {
  return {
    id,
    fromDirection: fields.from_direction,
    toDirection: fields.to_direction ?? null,
    toAreaId: fields.to_area_id ?? null,
    toRoomNumber: fields.to_room_number ?? null,
    hidden: fields.is_hidden ?? false,
    closed: fields.is_closed ?? false,
    locked: fields.is_locked ?? false,
    weight: fields.weight ?? 1,
    command: fields.command ?? null,
  };
}

function sameOptionalArea(a: AreaId | null, b: AreaId | undefined): boolean {
  return a === null ? b === undefined : b !== undefined && sameAreaId(a, b);
}

function exitMatchesFields(exit: ExitMirror, fields: ExitArgs): boolean {
  return exit.fromDirection === fields.from_direction &&
    exit.toDirection === (fields.to_direction ?? null) &&
    sameOptionalArea(exit.toAreaId, fields.to_area_id) &&
    exit.toRoomNumber === (fields.to_room_number ?? null) &&
    exit.hidden === (fields.is_hidden ?? false) &&
    exit.closed === (fields.is_closed ?? false) &&
    exit.locked === (fields.is_locked ?? false) &&
    exit.weight === (fields.weight ?? 1) &&
    commandKey(exit.command) === commandKey(fields.command ?? null);
}

function applyExitFields(exit: ExitMirror, fields: ExitArgs): void {
  exit.fromDirection = fields.from_direction;
  exit.toDirection = fields.to_direction ?? null;
  exit.toAreaId = fields.to_area_id ?? null;
  exit.toRoomNumber = fields.to_room_number ?? null;
  exit.hidden = fields.is_hidden ?? false;
  exit.closed = fields.is_closed ?? false;
  exit.locked = fields.is_locked ?? false;
  exit.weight = fields.weight ?? 1;
  exit.command = fields.command ?? null;
}

function copyConnection(connection: Connection): ConnectionMirror {
  return {
    id: connection.id,
    endpointA: copyEndpoint(connection.endpoint_a),
    endpointB: connection.endpoint_b ? copyEndpoint(connection.endpoint_b) : null,
    routing: connection.routing,
    segmentShape: connection.segment_shape,
    routePoints: connection.route_points.map((point) => ({ x: point.x, y: point.y })),
  };
}

function connectionMirrorKey(id: ConnectionId): string {
  return `${id[0]}:${id[1]}`;
}

/**
 * Reconciles NukeFire's authoritative local map snapshots into Smudgy areas.
 * Calls are serialized because mapper mutations acknowledge asynchronously.
 */
export class NukeFireMapper {
  readonly #options: Required<Omit<NukeFireMapperOptions, "ephemeral" | "storage">> & {
    storage: MapStorage;
  };
  readonly #decisionLogger: MappingDecisionLogger;
  readonly #subscriptions: EventSubscription[] = [];
  readonly #zoneAreas = new Map<number, AreaMirror>();
  readonly #areasById = new Map<string, AreaMirror>();
  readonly #roomsByVnum = new Map<number, RoomMirror>();
  #lastRoomInfo: RoomInfo | undefined;
  #lastSnapshot: NukeFireMapLocal | undefined;
  readonly #pending: NukeFireMapLocal[] = [];
  /** Traversals already allowed to trigger one expensive geometry reflow. */
  readonly #plannedTopology = new Set<string>();
  #running = false;
  #started = false;
  #currentLocation = "";
  #lastError = "";
  #lastDecisionLogError = "";

  constructor(options: NukeFireMapperOptions = {}) {
    this.#options = {
      areaPrefix: options.areaPrefix ?? "NukeFire Zone",
      storage: options.storage ?? (options.ephemeral ? "session" : "local"),
      updateCoordinates: options.updateCoordinates ?? true,
      decisionLogFile: options.decisionLogFile ?? DEFAULT_DECISION_LOG_FILE,
    };
    this.#decisionLogger = new MappingDecisionLogger(this.#options.decisionLogFile, (error) => {
      if (error === this.#lastDecisionLogError) return;
      this.#lastDecisionLogError = error;
      echo(`[nukefire-mapper] ${error}`);
    });
  }

  #registerRoom(area: AreaMirror, room: RoomMirror): void {
    area.roomsByNumber.set(room.roomNumber, room);
    if (room.vnum !== undefined) this.#roomsByVnum.set(room.vnum, room);
  }

  #registerArea(area: AreaMirror): AreaMirror {
    this.#areasById.set(areaIdKey(area.id), area);
    const zone = Number(area.zone);
    if (Number.isSafeInteger(zone)) this.#zoneAreas.set(zone, area);
    return area;
  }

  /**
   * Copy one immutable Smudgy area snapshot into ordinary VM-owned records.
   * This is the only full-area read path; steady-state mapping uses the mirror.
   */
  #hydrateArea(source: Area, force = false): AreaMirror {
    const id = source.id;
    const key = areaIdKey(id);
    const known = this.#areasById.get(key);
    if (known && !force) return known;
    if (known) {
      for (const room of known.roomsByNumber.values()) {
        if (room.vnum !== undefined && this.#roomsByVnum.get(room.vnum) === room) {
          this.#roomsByVnum.delete(room.vnum);
        }
      }
    }

    const area: AreaMirror = {
      id,
      name: source.name,
      storage: source.storage,
      zone: source.data(AREA_ZONE_PROPERTY),
      source: source.data(AREA_SOURCE_PROPERTY),
      roomsByNumber: new Map(),
      connections: new Map(),
    };
    for (const roomNumber of source.room_numbers) {
      const room = source.room(roomNumber);
      if (!room) continue;
      const externalId = room.externalId;
      const mirrored: RoomMirror = {
        areaId: id,
        roomNumber: room.room_number,
        vnum: roomVnum(room),
        externalId,
        title: room.title,
        color: room.color,
        position: roundedPosition(room.x, room.y, room.level),
        layoutLocked: room.data(ROOM_LAYOUT_LOCK_PROPERTY)?.trim().toLowerCase() === "true",
        zone: room.data(ROOM_ZONE_PROPERTY),
        terrain: room.data(ROOM_TERRAIN_PROPERTY),
        exits: room.exits.map(copyExit),
      };
      this.#registerRoom(area, mirrored);
    }
    for (const connection of source.connections) {
      const mirrored = copyConnection(connection);
      area.connections.set(connectionMirrorKey(mirrored.id), mirrored);
    }
    return this.#registerArea(area);
  }

  get started(): boolean {
    return this.#started;
  }

  /** Absolute runtime path of the JSONL decision log, when enabled. */
  get decisionLogPath(): string | undefined {
    return this.#decisionLogger.path;
  }

  #logDecision(record: DecisionLogRecord): void {
    const error = this.#decisionLogger.append(record);
    if (!error) {
      this.#lastDecisionLogError = "";
      return;
    }
    if (error === this.#lastDecisionLogError) return;
    this.#lastDecisionLogError = error;
    echo(`[nukefire-mapper] ${error}`);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;

    this.#logDecision({
      kind: "session-start",
      options: { ...this.#options },
    });
    if (this.#decisionLogger.path) {
      echo(`[nukefire-mapper] mapping decisions: ${this.#decisionLogger.path}`);
    }

    this.#subscriptions.push(
      watchMessage("Room.Info", (info) => {
        this.#lastRoomInfo = info ? clone(info) : undefined;
        if (info && this.#lastSnapshot?.center === info.num) {
          this.#enqueue(this.#lastSnapshot);
        }
      }),
      onMessage("NukeFire.Map.Local", (snapshot) => {
        const stable = clone(snapshot);
        this.#lastSnapshot = stable;
        this.#enqueue(stable);
      }),
    );

    // onMessage preserves every future arrival but intentionally has no
    // replay. Seed from the current tree when this package starts late.
    const currentRoom = nukefire.value?.Room?.Info;
    if (currentRoom && !this.#lastRoomInfo) this.#lastRoomInfo = clone(currentRoom);
    const current = nukefire.value?.NukeFire?.Map?.Local;
    if (current) {
      const stable = clone(current);
      this.#lastSnapshot = stable;
      this.#enqueue(stable);
    }
  }

  stop(): void {
    for (const subscription of this.#subscriptions.splice(0)) subscription.off();
    this.#pending.length = 0;
    this.#zoneAreas.clear();
    this.#areasById.clear();
    this.#roomsByVnum.clear();
    this.#plannedTopology.clear();
    this.#currentLocation = "";
    this.#started = false;
  }

  #enqueue(snapshot: NukeFireMapLocal): void {
    const stable = snapshot;
    const last = this.#pending.at(-1);
    if (last?.center === stable.center) {
      // GPS overlays and door changes can republish the same neighborhood.
      // Only the newest unprocessed version of one center is useful.
      this.#pending[this.#pending.length - 1] = stable;
    } else {
      // Preserve movement through distinct centers: an intermediate local grid
      // may contain rooms that the next one no longer exposes.
      this.#pending.push(stable);
    }
    if (!this.#running) void this.#drain();
  }

  async #drain(): Promise<void> {
    this.#running = true;
    try {
      while (this.#pending.length > 0 && this.#started) {
        const snapshot = this.#pending.shift();
        if (!snapshot) continue;
        try {
          await this.#syncSnapshot(snapshot);
          this.#lastError = "";
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          if (message !== this.#lastError) {
            this.#lastError = message;
            echo(`[nukefire-mapper] ${message}`);
            this.#logDecision({
              kind: "mapping-error",
              snapshot,
              error: {
                message,
                stack: caught instanceof Error ? caught.stack : undefined,
              },
            });
          }
        }
      }
    } finally {
      this.#running = false;
      if (this.#pending.length > 0 && this.#started) void this.#drain();
    }
  }

  async #syncSnapshot(snapshot: NukeFireMapLocal): Promise<void> {
    if (!isUsableVnum(snapshot.center)) {
      throw new Error(`ignored Map.Local with invalid center ${snapshot.center}`);
    }

    const byVnum = new Map<number, NukeFireMapRoom>();
    for (const room of snapshot.rooms) {
      if (validRoom(room)) byVnum.set(room.vnum, room);
    }
    const centerSource = byVnum.get(snapshot.center);
    if (!centerSource) {
      throw new Error(`Map.Local omitted its center room #${snapshot.center}`);
    }

    const sources = [...byVnum.values()];
    const existing = new Map<number, RoomMirror>();
    for (const source of sources) {
      const room = this.#roomsByVnum.get(source.vnum);
      const area = room && this.#areasById.get(areaIdKey(room.areaId));
      if (room && area?.storage === this.#options.storage) existing.set(source.vnum, room);
    }

    // Hydrate an existing matching area at most once. Subsequent snapshots use
    // #roomsByVnum and never repeat these atomic host reads.
    if (existing.size < sources.length) {
      for (const source of sources) {
        if (existing.has(source.vnum)) continue;
        const cached = this.#roomsByVnum.get(source.vnum);
        const cachedArea = cached && this.#areasById.get(areaIdKey(cached.areaId));
        if (cached && cachedArea?.storage === this.#options.storage) {
          existing.set(source.vnum, cached);
          continue;
        }
        const hostRoom = mapper.findRoomByExternalId(externalRoomId(source.vnum));
        if (!hostRoom) continue;
        const hostArea = mapper.getAreaById(hostRoom.area_id);
        if (hostArea.storage !== this.#options.storage) continue;
        this.#hydrateArea(hostArea);
        const room = this.#roomsByVnum.get(source.vnum);
        if (room) existing.set(source.vnum, room);
      }
    }
    // The global external-id index returns one of potentially several maps. If
    // it chose the other storage mode, scan matching areas once and mirror them.
    if (existing.size < sources.length) {
      const wanted = new Set(sources.map((source) => source.vnum));
      for (const hostArea of mapper.areas) {
        if (existing.size >= wanted.size) break;
        if (hostArea.storage !== this.#options.storage) continue;
        const area = this.#hydrateArea(hostArea);
        for (const room of area.roomsByNumber.values()) {
          if (room.vnum !== undefined && wanted.has(room.vnum) && !existing.has(room.vnum)) {
            existing.set(room.vnum, room);
          }
        }
      }
    }

    const knownAreaByZone = new Map<number, AreaMirror>();
    const currentExisting = existing.get(snapshot.center);
    if (currentExisting) {
      const area = this.#areasById.get(areaIdKey(currentExisting.areaId));
      if (area) knownAreaByZone.set(centerSource.zone, area);
    }
    for (const source of sources) {
      const room = existing.get(source.vnum);
      if (room && !knownAreaByZone.has(source.zone)) {
        const area = this.#areasById.get(areaIdKey(room.areaId));
        if (area) knownAreaByZone.set(source.zone, area);
      }
    }

    const preferredCenterName = this.#lastRoomInfo?.num === snapshot.center
      ? this.#lastRoomInfo.area.trim()
      : "";
    const areaByZone = new Map<number, AreaMirror>();
    for (const zone of new Set(sources.map((room) => room.zone))) {
      const preferredName = zone === centerSource.zone ? preferredCenterName : "";
      areaByZone.set(zone, await this.#resolveArea(zone, knownAreaByZone.get(zone), preferredName));
    }

    const assignments: Assignment[] = sources.map((source) => {
      const room = existing.get(source.vnum);
      const area = room ? this.#areasById.get(areaIdKey(room.areaId)) : areaByZone.get(source.zone);
      if (!area) throw new Error(`could not resolve an area for NukeFire zone ${source.zone}`);
      return { source, area, room };
    });

    await this.#planAssignments(assignments, snapshot, centerSource);

    const rooms = new Map<number, RoomMirror>();
    for (const assignment of assignments) {
      const mapped = await this.#syncRoom(assignment);
      rooms.set(assignment.source.vnum, mapped);
    }

    const current = rooms.get(snapshot.center);
    if (current) {
      const key = `${areaIdKey(current.areaId)}:${current.roomNumber}`;
      if (key !== this.#currentLocation) {
        mapper.setCurrentLocation(current.areaId, current.roomNumber);
        this.#currentLocation = key;
      }
    }

    await this.#syncLinks(snapshot.links, rooms);
  }

  async #resolveArea(
    zone: number,
    known: AreaMirror | undefined,
    preferredName: string,
  ): Promise<AreaMirror> {
    let area = known?.storage === this.#options.storage
      ? known
      : this.#zoneAreas.get(zone);
    if (!area) {
      const source = mapper.areas.find((candidate) =>
        candidate.storage === this.#options.storage &&
        candidate.data(AREA_ZONE_PROPERTY) === String(zone)
      );
      if (source) area = this.#hydrateArea(source);
    }
    if (!area && preferredName) {
      const source = mapper.areas.find((candidate) =>
        candidate.storage === this.#options.storage &&
        candidate.name.localeCompare(preferredName, undefined, { sensitivity: "accent" }) === 0
      );
      if (source) area = this.#hydrateArea(source);
    }
    if (!area) {
      const source = await mapper.createArea(
        preferredName || `${this.#options.areaPrefix} ${zone}`,
        { storage: this.#options.storage },
      );
      area = this.#registerArea({
        id: source.id,
        name: source.name,
        storage: source.storage,
        roomsByNumber: new Map(),
        connections: new Map(),
      });
    }

    this.#zoneAreas.set(zone, area);
    if (!area.zone) {
      await mapper.setAreaProperty(area.id, AREA_ZONE_PROPERTY, String(zone));
      area.zone = String(zone);
    }
    if (area.source !== SOURCE_NAME) {
      await mapper.setAreaProperty(area.id, AREA_SOURCE_PROPERTY, SOURCE_NAME);
      area.source = SOURCE_NAME;
    }

    const placeholder = `${this.#options.areaPrefix} ${zone}`;
    if (preferredName && area.name === placeholder && area.name !== preferredName) {
      await mapper.renameArea(area.id, preferredName);
      area.name = preferredName;
    }
    return area;
  }

  async #planAssignments(
    assignments: Assignment[],
    snapshot: Readonly<NukeFireMapLocal>,
    centerSource: Readonly<NukeFireMapRoom>,
  ): Promise<void> {
    const groups = new Map<string, Assignment[]>();
    for (const assignment of assignments) {
      const key = areaKey(assignment.area);
      const group = groups.get(key) ?? [];
      group.push(assignment);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const area = group[0].area;
      const groupVnums = new Set(group.map((assignment) => assignment.source.vnum));
      const assignmentByVnum = new Map(group.map((assignment) => [assignment.source.vnum, assignment]));
      const residentRooms = new Map(area.roomsByNumber);
      for (const assignment of group) {
        if (assignment.room && sameAreaId(assignment.room.areaId, area.id)) {
          residentRooms.set(assignment.room.roomNumber, assignment.room);
        }
      }

      const assignmentIds = new Map<number, string>();
      for (const assignment of group) {
        assignmentIds.set(
          assignment.source.vnum,
          assignment.room ? residentId(assignment.room.roomNumber) : newRoomId(assignment.source.vnum),
        );
      }

      const residents: LayoutResident[] = [];
      const roomById = new Map<string, RoomMirror>();
      const idByRoomNumber = new Map<RoomNumber, string>();
      for (const room of residentRooms.values()) {
        const id = residentId(room.roomNumber);
        idByRoomNumber.set(room.roomNumber, id);
        roomById.set(id, room);
        residents.push({
          id,
          position: room.position,
          movable: room.vnum !== undefined && !room.layoutLocked,
        });
      }

      const introducesRoom = group.some((assignment) => !assignment.room);
      const introducedTopology = new Set<string>();
      for (const link of snapshot.links) {
        if (!groupVnums.has(link.from) || !groupVnums.has(link.to)) continue;
        const from = assignmentByVnum.get(link.from)?.room;
        const to = assignmentByVnum.get(link.to)?.room;
        const mapped = mapDirection(link.direction);
        const forwardKey = topologyTraversalKey(link.from, link.to, mapped.command);
        if (!this.#plannedTopology.has(forwardKey) && !exitLeadsTo(from && matchingExit(from, mapped), to)) {
          introducedTopology.add(forwardKey);
        }

        if (link.bidirectional && mapped.opposite && mapped.reverseCommand) {
          const reverseMapped = {
            direction: mapped.opposite,
            command: mapped.reverseCommand,
            opposite: mapped.direction,
            reverseCommand: mapped.command,
          } satisfies MappedDirection;
          const reverseKey = topologyTraversalKey(link.to, link.from, reverseMapped.command);
          if (!this.#plannedTopology.has(reverseKey) && !exitLeadsTo(to && matchingExit(to, reverseMapped), from)) {
            introducedTopology.add(reverseKey);
          }
        }
      }
      const topologyGrowth = introducesRoom || introducedTopology.size > 0;

      let plan: Pick<ReturnType<typeof planIntegralLayout>, "positions" | "movedExisting">;
      if (!topologyGrowth) {
        // The common walking path is intentionally O(residents): no edge graph,
        // candidate generation, scoring, or routing search is needed.
        plan = {
          positions: new Map(residents.map((resident) => [resident.id, resident.position])),
          movedExisting: new Set<string>(),
        };
      } else {
        const nodes: LayoutNode[] = group.map((assignment) => ({
          id: assignmentIds.get(assignment.source.vnum) as string,
          relative: roundedPosition(
            assignment.source.x - centerSource.x,
            assignment.source.y - centerSource.y,
            assignment.source.z - centerSource.z,
          ),
        }));

        const edges: LayoutEdge[] = [];
        const edgeKeys = new Set<string>();
        const pushEdge = (from: string, to: string, direction: LayoutDirection): void => {
          const key = `${from}>${to}:${direction}`;
          if (edgeKeys.has(key)) return;
          edgeKeys.add(key);
          edges.push({ from, to, direction });
        };

        for (const room of residentRooms.values()) {
          const from = idByRoomNumber.get(room.roomNumber);
          if (!from || room.vnum === undefined) continue;
          for (const exit of room.exits) {
            if (!exit.toAreaId || exit.toRoomNumber === null || !sameAreaId(exit.toAreaId, area.id)) continue;
            const to = idByRoomNumber.get(exit.toRoomNumber);
            const toRoom = residentRooms.get(exit.toRoomNumber);
            if (to && toRoom && toRoom.vnum !== undefined) {
              pushEdge(from, to, exit.fromDirection as LayoutDirection);
            }
          }
        }

        for (const link of snapshot.links) {
          if (!groupVnums.has(link.from) || !groupVnums.has(link.to)) continue;
          const from = assignmentIds.get(link.from);
          const to = assignmentIds.get(link.to);
          if (!from || !to) continue;
          const mapped = mapDirection(link.direction);
          pushEdge(from, to, mapped.direction as LayoutDirection);
          if (link.bidirectional && mapped.opposite) {
            pushEdge(to, from, mapped.opposite as LayoutDirection);
          }
        }

        const centerId = assignmentIds.get(snapshot.center);
        const trace: LayoutTraceEvent[] = [];
        const identities = new Map<string, {
          id: string;
          vnum?: number;
          roomNumber?: RoomNumber;
          title: string;
        }>();
        for (const room of residentRooms.values()) {
          const id = residentId(room.roomNumber);
          identities.set(id, {
            id,
            vnum: room.vnum,
            roomNumber: room.roomNumber,
            title: room.title,
          });
        }
        for (const assignment of group) {
          const id = assignmentIds.get(assignment.source.vnum) as string;
          identities.set(id, {
            id,
            vnum: assignment.source.vnum,
            roomNumber: assignment.room?.roomNumber,
            title: assignment.source.name,
          });
        }
        const diagnosticContext = {
          area: {
            id: area.id,
            name: area.name,
            zone: group[0].source.zone,
          },
          trigger: {
            introducesRoom,
            introducedRooms: group
              .filter((assignment) => !assignment.room)
              .map((assignment) => assignment.source.vnum)
              .sort((a, b) => a - b),
            introducedTopology: [...introducedTopology].sort(),
          },
          identities: [...identities.values()].sort((a, b) => a.id.localeCompare(b.id)),
          snapshot,
          request: {
            centerId,
            allowExistingMoves: this.#options.updateCoordinates,
            nodes,
            residents,
            edges,
          },
        };
        try {
          const planned = planIntegralLayout({
            nodes,
            residents,
            edges,
            centerId,
            allowExistingMoves: this.#options.updateCoordinates,
            trace: (event) => trace.push(event),
          });
          plan = planned;
          this.#logDecision({
            kind: "layout-decision",
            ...diagnosticContext,
            trace,
            result: {
              quality: planned.quality,
              movedExisting: [...planned.movedExisting].sort(),
              positions: serializedPositions(planned.positions),
            },
          });
        } catch (caught) {
          this.#logDecision({
            kind: "layout-error",
            ...diagnosticContext,
            trace,
            error: {
              message: caught instanceof Error ? caught.message : String(caught),
              stack: caught instanceof Error ? caught.stack : undefined,
            },
          });
          throw caught;
        }
      }

      for (const assignment of group) {
        const id = assignmentIds.get(assignment.source.vnum) as string;
        const position = plan.positions.get(id);
        if (!position) throw new Error(`layout omitted room #${assignment.source.vnum}`);
        assignment.position = position;
      }

      const updates: [RoomNumber, UpdateRoomParams][] = [];
      for (const id of plan.movedExisting) {
        const room = roomById.get(id);
        const position = plan.positions.get(id);
        if (!room || !position) continue;
        updates.push([room.roomNumber, {
          x: position.x,
          y: position.y,
          level: position.level,
        }]);
      }
      if (updates.length > 0) {
        await mapper.updateRooms(area.id, updates);
        for (const [number, fields] of updates) {
          const room = residentRooms.get(number);
          if (!room) continue;
          room.position = roundedPosition(
            fields.x ?? room.position.x,
            fields.y ?? room.position.y,
            fields.level ?? room.position.level,
          );
        }
      }

      if (topologyGrowth || updates.length > 0) {
        await this.#syncAreaConnectionRoutes(area, residentRooms, plan.positions);
      }

      for (const key of introducedTopology) this.#plannedTopology.add(key);

      for (const assignment of group) {
        const id = assignmentIds.get(assignment.source.vnum) as string;
        assignment.positionApplied = assignment.room !== undefined && plan.movedExisting.has(id);
      }
    }
  }

  #desiredConnectionGeometry(
    roomA: RoomNumber,
    roomB: RoomNumber,
    positionA: GridPosition,
    positionB: GridPosition,
    occupied: readonly GridPosition[],
    preferredStart: RouteSide,
    preferredEnd: RouteSide,
    endpointA?: ConnectionEndpoint,
    endpointB?: ConnectionEndpoint,
    knownObstructed?: boolean,
  ): DesiredConnectionGeometry {
    const baseA: ConnectionEndpoint = endpointA ?? {
      room_number: roomA,
      side: preferredStart,
      port_offset: 0.5,
      port_mode: "AutoPinned",
    };
    const baseB: ConnectionEndpoint = endpointB ?? {
      room_number: roomB,
      side: preferredEnd,
      port_offset: 0.5,
      port_mode: "AutoPinned",
    };
    const obstructed = knownObstructed ??
      directRoomObstructions(positionA, positionB, occupied).length > 0;
    if (obstructed) {
      const path = routeAroundRooms(positionA, positionB, occupied, preferredStart, preferredEnd);
      if (path) {
        return {
          endpoint_a: { ...baseA, side: routeStartSide(path) ?? preferredStart },
          endpoint_b: { ...baseB, side: routeEndSide(path) ?? preferredEnd },
          routing: "Manual",
          segment_shape: "Orthogonal",
          route_points: routeTurnPoints(path),
        };
      }
    }
    return {
      endpoint_a: { ...baseA, side: preferredStart },
      endpoint_b: { ...baseB, side: preferredEnd },
      routing: "Automatic",
      segment_shape: "Direct",
      route_points: [],
    };
  }

  async #syncAreaConnectionRoutes(
    area: AreaMirror,
    residentRooms: ReadonlyMap<RoomNumber, RoomMirror>,
    positions: ReadonlyMap<string, GridPosition>,
  ): Promise<void> {
    const byRoomNumber = new Map<RoomNumber, GridPosition>();
    for (const number of residentRooms.keys()) {
      const position = positions.get(residentId(number));
      if (position) byRoomNumber.set(number, position);
    }
    // Include planned rooms which have not been created yet. They can obstruct
    // an older connection during the same topology-growth transaction.
    const occupied = [...positions.values()];
    const changes: unknown[] = [];

    for (const connection of area.connections.values()) {
      const endpointB = connection.endpointB;
      if (!endpointB) continue;
      const roomA = residentRooms.get(connection.endpointA.room_number);
      const roomB = residentRooms.get(endpointB.room_number);
      if (!roomA || !roomB || roomA.vnum === undefined || roomB.vnum === undefined) continue;
      const positionA = byRoomNumber.get(roomA.roomNumber);
      const positionB = byRoomNumber.get(roomB.roomNumber);
      if (!positionA || !positionB || roomA.roomNumber === roomB.roomNumber || positionA.level !== positionB.level) {
        continue;
      }
      const deltaX = positionB.x - positionA.x;
      const deltaY = positionB.y - positionA.y;
      const exitA = roomA.exits.find((exit) =>
        exit.toAreaId && sameAreaId(exit.toAreaId, area.id) &&
        exit.toRoomNumber === roomB.roomNumber
      );
      const exitB = roomB.exits.find((exit) =>
        exit.toAreaId && sameAreaId(exit.toAreaId, area.id) &&
        exit.toRoomNumber === roomA.roomNumber
      );
      const preferredStart = directionSide(exitA?.fromDirection ?? "Other", deltaX, deltaY) as RouteSide;
      const preferredEnd = directionSide(exitB?.fromDirection ?? "Other", -deltaX, -deltaY) as RouteSide;
      const obstructions = directRoomObstructions(positionA, positionB, occupied);
      const desired = this.#desiredConnectionGeometry(
        roomA.roomNumber,
        roomB.roomNumber,
        positionA,
        positionB,
        occupied,
        preferredStart,
        preferredEnd,
        connection.endpointA,
        endpointB,
        obstructions.length > 0,
      );
      const desiredSignature = geometrySignature(desired);
      if (connectionSignature(connection) === desiredSignature) {
        continue;
      }
      const before = {
        endpoint_a: copyEndpoint(connection.endpointA),
        endpoint_b: copyEndpoint(endpointB),
        routing: connection.routing,
        segment_shape: connection.segmentShape,
        route_points: connection.routePoints.map((point) => ({ ...point })),
      };
      await mapper.setConnection(area.id, connection.id, desired);
      connection.endpointA = copyEndpoint(desired.endpoint_a);
      connection.endpointB = copyEndpoint(desired.endpoint_b);
      connection.routing = desired.routing;
      connection.segmentShape = desired.segment_shape;
      connection.routePoints = desired.route_points.map((point) => ({ ...point }));
      changes.push({
        connectionId: connection.id,
        roomA: {
          roomNumber: roomA.roomNumber,
          vnum: roomA.vnum,
          position: positionA,
          direction: exitA?.fromDirection,
        },
        roomB: {
          roomNumber: roomB.roomNumber,
          vnum: roomB.vnum,
          position: positionB,
          direction: exitB?.fromDirection,
        },
        preferredStart,
        preferredEnd,
        obstructions,
        reason: desired.routing === "Manual"
          ? "direct-segment-crosses-room"
          : obstructions.length > 0
          ? "no-orthogonal-route-found"
          : "direct-segment-clear",
        before,
        after: desired,
      });
    }
    if (changes.length > 0) {
      this.#logDecision({
        kind: "routing-decisions",
        area: { id: area.id, name: area.name },
        changes,
      });
    }
  }

  async #syncRoom(assignment: Assignment): Promise<RoomMirror> {
    const source = assignment.source;
    const position = assignment.position;
    if (!position) throw new Error(`layout omitted room #${source.vnum}`);
    const { x, y, level } = position;
    const color = terrainColor(source.terrain);
    let room = assignment.room;
    const created = !room;

    if (!room) {
      const number = await mapper.createRoom(assignment.area.id, {
        title: source.name,
        level,
        x,
        y,
        color,
        externalId: externalRoomId(source.vnum),
      });
      room = {
        areaId: assignment.area.id,
        roomNumber: number,
        vnum: source.vnum,
        externalId: externalRoomId(source.vnum),
        title: source.name,
        color,
        position: { ...position },
        layoutLocked: false,
        exits: [],
      };
      this.#registerRoom(assignment.area, room);
      assignment.room = room;
    }

    const updates: UpdateRoomParams = {};
    if (source.name && room.title !== source.name) updates.title = source.name;
    if (room.color !== color) updates.color = color;
    if (!assignment.positionApplied && (this.#options.updateCoordinates || created)) {
      if (room.position.level !== level) updates.level = level;
      if (room.position.x !== x) updates.x = x;
      if (room.position.y !== y) updates.y = y;
    }
    if (Object.keys(updates).length > 0) {
      await mapper.updateRoom(room.areaId, room.roomNumber, updates);
      if (updates.title !== undefined) room.title = updates.title;
      if (updates.color !== undefined) room.color = updates.color;
      room.position = roundedPosition(
        updates.x ?? room.position.x,
        updates.y ?? room.position.y,
        updates.level ?? room.position.level,
      );
    }

    if (room.zone !== String(source.zone)) {
      await mapper.setRoomProperty(room.areaId, room.roomNumber, ROOM_ZONE_PROPERTY, String(source.zone));
      room.zone = String(source.zone);
    }
    if (room.terrain !== source.terrain) {
      await mapper.setRoomProperty(room.areaId, room.roomNumber, ROOM_TERRAIN_PROPERTY, source.terrain);
      room.terrain = source.terrain;
    }
    return room;
  }

  async #syncLinks(links: readonly NukeFireMapLink[], rooms: Map<number, RoomMirror>): Promise<void> {
    const processed = new Set<string>();
    for (const link of links) {
      if (!isUsableVnum(link.from) || !isUsableVnum(link.to)) continue;
      const mapped = mapDirection(link.direction);
      const key = `${link.from}>${link.to}:${mapped.command}`;
      if (processed.has(key)) continue;
      processed.add(key);
      if (link.bidirectional && mapped.reverseCommand) {
        processed.add(`${link.to}>${link.from}:${mapped.reverseCommand}`);
      }

      const from = rooms.get(link.from) ?? this.#roomsByVnum.get(link.from);
      if (!from) continue;
      const to = rooms.get(link.to) ?? this.#roomsByVnum.get(link.to);
      await this.#syncLink(link, from, to, mapped);
    }
  }

  async #syncLink(
    link: Readonly<NukeFireMapLink>,
    from: RoomMirror,
    to: RoomMirror | undefined,
    mapped: MappedDirection,
  ): Promise<void> {
    const fromExit = matchingExit(from, mapped);
    const reverseMapped = mapped.opposite && mapped.reverseCommand
      ? {
          direction: mapped.opposite,
          command: mapped.reverseCommand,
          opposite: mapped.direction,
          reverseCommand: mapped.command,
        } satisfies MappedDirection
      : undefined;
    const reverseExit = link.bidirectional && to && reverseMapped
      ? matchingExit(to, reverseMapped)
      : undefined;

    if (!fromExit && !reverseExit && to && sameAreaId(from.areaId, to.areaId)) {
      try {
        await this.#createLocalLink(link, from, to, mapped, reverseMapped);
        return;
      } catch {
        // An unusual/duplicate topology can reject atomic pairing. The
        // traversal fallback below still records the server-authoritative exits.
      }
    }

    await this.#ensureTraversal(from, to, mapped, fromExit, link.closed, link.locked);
    if (link.bidirectional && to && reverseMapped) {
      await this.#ensureTraversal(to, from, reverseMapped, reverseExit, link.closed, link.locked);
    }
  }

  async #createLocalLink(
    link: Readonly<NukeFireMapLink>,
    from: RoomMirror,
    to: RoomMirror,
    mapped: MappedDirection,
    reverse: MappedDirection | undefined,
  ): Promise<void> {
    const positionA = from.position;
    const positionB = to.position;
    const deltaX = positionB.x - positionA.x;
    const deltaY = positionB.y - positionA.y;
    const preferredStart = directionSide(mapped.direction, deltaX, deltaY) as RouteSide;
    const preferredEnd = directionSide(mapped.opposite ?? "Other", -deltaX, -deltaY) as RouteSide;
    const area = this.#areasById.get(areaIdKey(from.areaId));
    if (!area) throw new Error(`missing mirrored area for room #${from.vnum ?? from.roomNumber}`);
    const occupied = [...area.roomsByNumber.values()].map((room) => room.position);
    const geometry = this.#desiredConnectionGeometry(
      from.roomNumber,
      to.roomNumber,
      positionA,
      positionB,
      occupied,
      preferredStart,
      preferredEnd,
    );
    const traversals: LinkTraversalArgs[] = [
      {
        room_number: from.roomNumber,
        from_direction: mapped.direction,
        ...(mapped.opposite ? { to_direction: mapped.opposite } : {}),
        to_area_id: to.areaId,
        to_room_number: to.roomNumber,
        is_closed: link.closed,
        is_locked: link.locked,
        weight: 1,
        command: mapped.command,
      },
    ];
    if (link.bidirectional && reverse) {
      traversals.push({
        room_number: to.roomNumber,
        from_direction: reverse.direction,
        to_direction: mapped.direction,
        to_area_id: from.areaId,
        to_room_number: from.roomNumber,
        is_closed: link.closed,
        is_locked: link.locked,
        weight: 1,
        command: reverse.command,
      });
    }

    const connectionId = await mapper.createLink(from.areaId, {
      ...geometry,
      traversals,
    });
    area.connections.set(connectionMirrorKey(connectionId), {
      id: connectionId,
      endpointA: copyEndpoint(geometry.endpoint_a),
      endpointB: copyEndpoint(geometry.endpoint_b),
      routing: geometry.routing,
      segmentShape: geometry.segment_shape,
      routePoints: geometry.route_points.map((point) => ({ ...point })),
    });
    from.exits.push(exitFromFields(traversals[0]));
    if (traversals[1]) to.exits.push(exitFromFields(traversals[1]));
  }

  async #ensureTraversal(
    from: RoomMirror,
    to: RoomMirror | undefined,
    mapped: MappedDirection,
    existing: ExitMirror | undefined,
    closed: boolean,
    locked: boolean,
  ): Promise<void> {
    const destination = to
      ? {
          ...(mapped.opposite ? { to_direction: mapped.opposite } : {}),
          to_area_id: to.areaId,
          to_room_number: to.roomNumber,
        }
      : {};
    const fields: ExitArgs = {
      from_direction: mapped.direction,
      ...destination,
      is_closed: closed,
      is_locked: locked,
      weight: 1,
      command: mapped.command,
    };

    if (existing && exitMatchesFields(existing, fields)) return;
    if (existing) {
      if (!existing.id) {
        // createLink returns its Connection id but not its traversal ids. Read
        // this one room only if a later door/topology change actually needs an
        // id; the common unchanged path above remains entirely VM-local.
        const source = mapper.getAreaById(from.areaId).room(from.roomNumber);
        const hostExit = source && (mapped.direction === "Special"
          ? source.exits.find((exit) =>
            exit.from_direction === "Special" && commandKey(exit.command) === mapped.command
          )
          : source.exits.find((exit) => exit.from_direction === mapped.direction));
        if (!hostExit) return;
        existing.id = hostExit.id;
      }
      await mapper.setRoomExit(from.areaId, from.roomNumber, existing.id, fields);
      applyExitFields(existing, fields);
    } else {
      const id = await mapper.createRoomExit(from.areaId, from.roomNumber, fields);
      from.exits.push(exitFromFields(fields, id));
    }
  }
}
