/**
 * Routes for the links of a finished layout. A link drawn straight from wall to
 * wall can leave a wall that faces away from the room it joins, run across a
 * room, or cross another link, and some maps leave no layout without such
 * links: two exits of one room that lead to the same room cannot both point
 * at it. `planLinkRoutes` gives each of those links an orthogonal route out of
 * its own walls through the space between rooms. Routes run on a lattice of
 * half cells, so one can pass between two neighbouring rooms, and every
 * crossing and every stretch shared with another link costs the route, so
 * routes keep to lanes of their own. Parallel stretches that links still
 * share are splayed into offset lanes, sliding free ports along their walls
 * to match; a stretch whose corridor has no room for another lane is called
 * out instead.
 */

import type { GridPosition } from "./layout.ts";
import { PALETTE_LENGTH, paletteColor } from "./palette.ts";

export type RouteSide = "North" | "East" | "South" | "West";

export interface RoutePoint {
  x: number;
  y: number;
}

/** One link between two rooms, as the route planner sees it. */
export interface RouteLink {
  /** The caller's identity for the link, such as its Connection id. */
  id: string;
  /** The rooms it joins: keys of the planner's room positions. */
  from: string;
  to: string;
  /** The wall each end attaches to. */
  fromSide: RouteSide;
  toSide: RouteSide;
  /** Where each end attaches along its wall, from 0 to 1; the middle when omitted. */
  fromPort?: number;
  toPort?: number;
  /** An end whose port the planner leaves where it is. */
  fromPortFixed?: boolean;
  toPortFixed?: boolean;
  /** The points the link is drawn through now, between its stub tips; straight when omitted or empty. */
  points?: readonly RoutePoint[];
  /** Whether the planner chooses this link's route. Every link is avoided either way. */
  routable: boolean;
}

/** The planner's choice for one routable link. */
export interface PlannedLinkRoute {
  id: string;
  /** Points between the two stub tips; empty to draw the link straight. */
  points: RoutePoint[];
  fromPort: number;
  toPort: number;
  /**
   * Present when the link shares a stretch with links its corridor has no
   * lanes to separate: its place among them, from 0, so each can be drawn in
   * a color of its own.
   */
  callout?: number;
}

/** The stroke width, against the default 1, of links called out where they crowd a stretch. */
export const LINK_CALLOUT_THICKNESS = 2;

/**
 * The color of the link at `callout` place among those crowding a stretch of
 * `mapId`'s map: the sequence the map editor colors Secrets with, seeded by the
 * map, so each link sharing the stretch takes a color of its own.
 */
export function linkCalloutColor(mapId: string, callout: number): string {
  return paletteColor([mapId, "callout"], callout).toUpperCase();
}

/** Whether `color` is one the links of `mapId`'s map take when called out. */
export function isLinkCalloutColor(mapId: string, color: string): boolean {
  const wanted = color.toUpperCase();
  for (let place = 0; place < PALETTE_LENGTH; place += 1) {
    if (linkCalloutColor(mapId, place) === wanted) return true;
  }
  return false;
}

// Smudgy's connection geometry (smudgy_cloud::connection_geometry), in cells.
const ROOM_SIZE = 0.5;
const ROOM_HALF = ROOM_SIZE / 2;
const STUB_LENGTH = 0.15;
const CORNER_INSET = 0.2;
/** How far a port slides from the middle of its wall before the wall curves. */
const PORT_TRAVEL = (0.5 - CORNER_INSET) * ROOM_SIZE;

/** Search costs per half-cell step. */
const STEP_COST = 5;
const TURN_COST = 10;
/** Two cells of route: a clean crossing reads better than a long loop around a map. */
const CROSSING_COST = 20;
const SHARED_COST = 4;
/** Cells of slack around a link for its route search, and the most lattice nodes one search may hold. */
const ENVELOPE_MARGIN = 4;
const MAX_ENVELOPE_NODES = 40_000;

/** Defect weights deciding whether a route beats the straight line. */
const BENT_WEIGHT = 8;
const ROOM_WEIGHT = 8;
const CROSSING_WEIGHT = 3;
/** Cells longer than its straight line a route may run when it only avoids crossings. */
const CROSSING_DETOUR_ALLOWANCE = 6;

/**
 * Distance between splayed lanes, the least it may shrink to before a crowded
 * stretch is called out, and how far a lane may move in a corridor between
 * rooms or through empty cells.
 */
const LANE_SPACING = 0.1;
const MIN_LANE_SPACING = 0.07;
const HALF_LANE_TRAVEL = 0.15;
const CELL_LANE_TRAVEL = 0.3;
/**
 * The least distance, in cells from a room's center, at which a route turns
 * after leaving it or before entering it: half a cell, past the wall and the
 * stub drawn out of it, so a turn never doubles back over the stub.
 */
const TURN_CLEARANCE = 0.5;

const EPSILON = 1e-9;

const NORMALS: Record<RouteSide, { x: number; y: number }> = {
  North: { x: 0, y: -1 },
  East: { x: 1, y: 0 },
  South: { x: 0, y: 1 },
  West: { x: -1, y: 0 },
};

/** Lattice steps in North, East, South, West order: the deterministic expansion order. */
const STEPS = [
  { u: 0, v: -1 },
  { u: 1, v: 0 },
  { u: 0, v: 1 },
  { u: -1, v: 0 },
] as const;

function sideIndex(side: RouteSide): number {
  return side === "North" ? 0 : side === "East" ? 1 : side === "South" ? 2 : 3;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

interface Segment {
  link: string;
  a: RoutePoint;
  b: RoutePoint;
}

interface Drawing {
  link: RouteLink;
  points: RoutePoint[];
  /** The two rooms' centers, near which links that share the room may meet. */
  rooms: readonly GridPosition[];
}

/** The point on `side`'s wall a port at `offset` attaches to, along the wall's flat part. */
function portPoint(room: GridPosition, side: RouteSide, offset: number): RoutePoint {
  const along = Math.max(-PORT_TRAVEL, Math.min(PORT_TRAVEL, (offset - 0.5) * ROOM_SIZE));
  switch (side) {
    case "North":
      return { x: room.x + along, y: room.y - ROOM_HALF };
    case "South":
      return { x: room.x + along, y: room.y + ROOM_HALF };
    case "East":
      return { x: room.x + ROOM_HALF, y: room.y + along };
    case "West":
      return { x: room.x - ROOM_HALF, y: room.y + along };
  }
}

function tipPoint(port: RoutePoint, side: RouteSide): RoutePoint {
  const normal = NORMALS[side];
  return { x: port.x + normal.x * STUB_LENGTH, y: port.y + normal.y * STUB_LENGTH };
}

/** The polyline a link is drawn along: port, stub tip, its points, the other tip and port. */
function polyline(
  from: GridPosition,
  to: GridPosition,
  link: RouteLink,
  points: readonly RoutePoint[],
  fromPort: number,
  toPort: number,
): RoutePoint[] {
  const portA = portPoint(from, link.fromSide, fromPort);
  const portB = portPoint(to, link.toSide, toPort);
  const line = [portA, tipPoint(portA, link.fromSide), ...points, tipPoint(portB, link.toSide), portB];
  return line.filter((point, index) =>
    index === 0 || Math.abs(point.x - line[index - 1].x) > EPSILON || Math.abs(point.y - line[index - 1].y) > EPSILON
  );
}

function orientation(a: RoutePoint, b: RoutePoint, c: RoutePoint): number {
  const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(value) < EPSILON ? 0 : value > 0 ? 1 : -1;
}

function onSegment(point: RoutePoint, a: RoutePoint, b: RoutePoint): boolean {
  return Math.min(a.x, b.x) - EPSILON <= point.x && point.x <= Math.max(a.x, b.x) + EPSILON &&
    Math.min(a.y, b.y) - EPSILON <= point.y && point.y <= Math.max(a.y, b.y) + EPSILON;
}

interface Contact {
  /** 1 for a crossing through both segments, 0.5 where one only touches the other. */
  crossing: number;
  /** Length the two run along together. */
  shared: number;
  /** Where they meet, for a crossing or touch. */
  at?: RoutePoint;
}

const NO_CONTACT: Contact = { crossing: 0, shared: 0 };

/** How segment p–q meets segment a–b. */
function contact(p: RoutePoint, q: RoutePoint, a: RoutePoint, b: RoutePoint): Contact {
  const o1 = orientation(p, q, a);
  const o2 = orientation(p, q, b);
  const o3 = orientation(a, b, p);
  const o4 = orientation(a, b, q);
  if (o1 === 0 && o2 === 0) {
    // Collinear: the length they share, if any.
    const horizontal = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y);
    const [p0, p1] = horizontal ? [Math.min(p.x, q.x), Math.max(p.x, q.x)] : [Math.min(p.y, q.y), Math.max(p.y, q.y)];
    const [a0, a1] = horizontal ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    const shared = Math.min(p1, a1) - Math.max(p0, a0);
    return shared > EPSILON ? { crossing: 0, shared } : NO_CONTACT;
  }
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) {
    const t = ((a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x)) /
      ((q.x - p.x) * (b.y - a.y) - (q.y - p.y) * (b.x - a.x));
    return { crossing: 1, shared: 0, at: { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) } };
  }
  // One touches the other at an end.
  if (o1 === 0 && onSegment(a, p, q)) return { crossing: 0.5, shared: 0, at: a };
  if (o2 === 0 && onSegment(b, p, q)) return { crossing: 0.5, shared: 0, at: b };
  if (o3 === 0 && onSegment(p, a, b)) return { crossing: 0.5, shared: 0, at: p };
  if (o4 === 0 && onSegment(q, a, b)) return { crossing: 0.5, shared: 0, at: q };
  return NO_CONTACT;
}

/** Whether a segment passes over a room's square, kept a little larger so lines do not graze it. */
function segmentHitsRoom(a: RoutePoint, b: RoutePoint, room: GridPosition): boolean {
  const half = ROOM_HALF + 0.05;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let enter = 0;
  let leave = 1;
  for (const [p, q] of [
    [-dx, a.x - (room.x - half)],
    [dx, room.x + half - a.x],
    [-dy, a.y - (room.y - half)],
    [dy, room.y + half - a.y],
  ] as const) {
    if (Math.abs(p) < EPSILON) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) enter = Math.max(enter, ratio);
    else leave = Math.min(leave, ratio);
    if (enter > leave) return false;
  }
  return true;
}

/** Segments bucketed by the cells their bounds cover. */
class SegmentIndex {
  readonly #buckets = new Map<string, Segment[]>();
  readonly #byLink = new Map<string, Segment[]>();

  #cells(segment: Segment): string[] {
    const keys: string[] = [];
    const minX = Math.floor(Math.min(segment.a.x, segment.b.x) - EPSILON);
    const maxX = Math.floor(Math.max(segment.a.x, segment.b.x) + EPSILON);
    const minY = Math.floor(Math.min(segment.a.y, segment.b.y) - EPSILON);
    const maxY = Math.floor(Math.max(segment.a.y, segment.b.y) + EPSILON);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) keys.push(`${x},${y}`);
    }
    return keys;
  }

  set(link: string, points: readonly RoutePoint[]): void {
    for (const segment of this.#byLink.get(link) ?? []) {
      for (const key of this.#cells(segment)) {
        const bucket = this.#buckets.get(key);
        if (!bucket) continue;
        const index = bucket.indexOf(segment);
        if (index >= 0) bucket.splice(index, 1);
      }
    }
    const segments: Segment[] = [];
    for (let index = 1; index < points.length; index += 1) {
      segments.push({ link, a: points[index - 1], b: points[index] });
    }
    this.#byLink.set(link, segments);
    for (const segment of segments) {
      for (const key of this.#cells(segment)) {
        const bucket = this.#buckets.get(key);
        if (bucket) bucket.push(segment);
        else this.#buckets.set(key, [segment]);
      }
    }
  }

  /** Every other link's segments near segment p–q. */
  near(p: RoutePoint, q: RoutePoint, except: string): Segment[] {
    const found = new Set<Segment>();
    for (const key of this.#cells({ link: except, a: p, b: q })) {
      for (const segment of this.#buckets.get(key) ?? []) {
        if (segment.link !== except) found.add(segment);
      }
    }
    return [...found];
  }
}

/** Whether two links meeting at `at` do so next to a room they share, where their ports and stubs meet. */
function nearSharedRoom(at: RoutePoint | undefined, mine: Drawing, theirs: Drawing): boolean {
  if (!at) return false;
  return mine.rooms.some((room) =>
    theirs.rooms.some((other) => other.x === room.x && other.y === room.y && other.level === room.level) &&
    Math.abs(at.x - room.x) <= 0.5 + EPSILON && Math.abs(at.y - room.y) <= 0.5 + EPSILON
  );
}

interface Defects {
  crossings: number;
  shared: number;
  roomHits: number;
}

/** The planner's state for one level: rooms, every drawing, and an index of their segments. */
class Level {
  readonly drawings = new Map<string, Drawing>();
  readonly index = new SegmentIndex();
  readonly occupied = new Set<string>();
  readonly rooms: readonly GridPosition[];

  constructor(rooms: readonly GridPosition[]) {
    this.rooms = rooms;
    for (const room of rooms) this.occupied.add(`${room.x * 2},${room.y * 2}`);
  }

  draw(drawing: Drawing): void {
    this.drawings.set(drawing.link.id, drawing);
    this.index.set(drawing.link.id, drawing.points);
  }

  /** How a polyline for `drawing`'s link meets the rooms and every other link. */
  defects(drawing: Drawing, points: readonly RoutePoint[]): Defects {
    let crossings = 0;
    let shared = 0;
    let roomHits = 0;
    const [from, to] = drawing.rooms;
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1];
      const b = points[index];
      const stub = index === 1 || index === points.length - 1;
      for (const room of this.rooms) {
        const endpoint = (room.x === from.x && room.y === from.y) || (room.x === to.x && room.y === to.y);
        // A route's own stubs leave its rooms; anything else over a room is drawn across it.
        if (endpoint && stub) continue;
        if (segmentHitsRoom(a, b, room)) roomHits += 1;
      }
      for (const segment of this.index.near(a, b, drawing.link.id)) {
        const met = contact(a, b, segment.a, segment.b);
        if (met.crossing > 0 && !nearSharedRoom(met.at, drawing, this.drawings.get(segment.link)!)) {
          crossings += met.crossing;
        }
        shared += met.shared;
      }
    }
    return { crossings, shared, roomHits };
  }
}

/** One straight run of a route on the lattice: a lane and the stretch of it the run covers. */
interface Run {
  /** "h" runs along x at lattice row `lane`; "v" runs along y at lattice column `lane`. */
  axis: "h" | "v";
  lane: number;
  lo: number;
  hi: number;
}

interface LatticeRoute {
  runs: Run[];
  /** Lattice nodes from one room's center to the other's. */
  nodes: { u: number; v: number }[];
}

/** Whether a link drawn straight runs out of both walls along one line. */
function runsStraight(from: GridPosition, to: GridPosition, link: RouteLink): boolean {
  const normal = NORMALS[link.fromSide];
  const back = NORMALS[link.toSide];
  if (normal.x !== -back.x || normal.y !== -back.y) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return normal.x === 0 ? dx === 0 && dy * normal.y > 0 : dy === 0 && dx * normal.x > 0;
}

function runsOf(nodes: readonly { u: number; v: number }[]): Run[] {
  const runs: Run[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const a = nodes[index - 1];
    const b = nodes[index];
    const axis = a.v === b.v ? "h" : "v";
    const lane = axis === "h" ? a.v : a.u;
    const [p, q] = axis === "h" ? [a.u, b.u] : [a.v, b.v];
    const last = runs[runs.length - 1];
    if (last && last.axis === axis && last.lane === lane) {
      last.lo = Math.min(last.lo, p, q);
      last.hi = Math.max(last.hi, p, q);
    } else {
      runs.push({ axis, lane, lo: Math.min(p, q), hi: Math.max(p, q) });
    }
  }
  return runs;
}

/** Corner points of consecutive runs, each run at its lane plus its offset, in cells. */
function cornerPoints(runs: readonly Run[], offsets: readonly number[]): RoutePoint[] {
  const points: RoutePoint[] = [];
  for (let index = 1; index < runs.length; index += 1) {
    const before = runs[index - 1];
    const after = runs[index];
    const beforeAt = before.lane / 2 + offsets[index - 1];
    const afterAt = after.lane / 2 + offsets[index];
    points.push(before.axis === "v"
      ? { x: round(beforeAt), y: round(afterAt) }
      : { x: round(afterAt), y: round(beforeAt) });
  }
  return points;
}

interface SearchNode {
  u: number;
  v: number;
  direction: number;
  cost: number;
  priority: number;
  sequence: number;
  parent?: SearchNode;
}

/** Binary min-heap over (priority, cost, sequence). */
class Frontier {
  readonly #values: SearchNode[] = [];

  get size(): number {
    return this.#values.length;
  }

  static #before(a: SearchNode, b: SearchNode): boolean {
    return (a.priority - b.priority || a.cost - b.cost || a.sequence - b.sequence) < 0;
  }

  push(value: SearchNode): void {
    const values = this.#values;
    values.push(value);
    let index = values.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!Frontier.#before(value, values[parent])) break;
      values[index] = values[parent];
      index = parent;
    }
    values[index] = value;
  }

  pop(): SearchNode | undefined {
    const values = this.#values;
    const first = values[0];
    const last = values.pop();
    if (first === undefined || last === undefined || values.length === 0) return first;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= values.length) break;
      const right = left + 1;
      const child = right < values.length && Frontier.#before(values[right], values[left]) ? right : left;
      if (!Frontier.#before(values[child], last)) break;
      values[index] = values[child];
      index = child;
    }
    values[index] = last;
    return first;
  }
}

/**
 * The cheapest lattice route for a link: out of its first wall, through free
 * lattice nodes, and into its second wall, charging steps, turns, crossings
 * and stretches shared with other links.
 */
function searchRoute(level: Level, drawing: Drawing): LatticeRoute | undefined {
  const link = drawing.link;
  const [from, to] = drawing.rooms;
  const startNormal = NORMALS[link.fromSide];
  const endNormal = NORMALS[link.toSide];
  const origin = { u: from.x * 2, v: from.y * 2 };
  const target = { u: to.x * 2, v: to.y * 2 };
  const start = { u: origin.u + startNormal.x, v: origin.v + startNormal.y };
  const goal = { u: target.u + endNormal.x, v: target.v + endNormal.y };
  const inward = sideIndex(link.toSide) ^ 2;

  const margin = ENVELOPE_MARGIN * 2;
  const minU = Math.min(origin.u, target.u) - margin;
  const maxU = Math.max(origin.u, target.u) + margin;
  const minV = Math.min(origin.v, target.v) - margin;
  const maxV = Math.max(origin.v, target.v) + margin;
  const width = maxU - minU + 1;
  if (width * (maxV - minV + 1) > MAX_ENVELOPE_NODES) return undefined;
  const blocked = (u: number, v: number): boolean => level.occupied.has(`${u},${v}`);
  if (blocked(start.u, start.v) || blocked(goal.u, goal.v)) return undefined;

  const stepCost = (a: { u: number; v: number }, b: { u: number; v: number }): number => {
    const p = { x: a.u / 2, y: a.v / 2 };
    const q = { x: b.u / 2, y: b.v / 2 };
    let cost = 0;
    for (const segment of level.index.near(p, q, link.id)) {
      const met = contact(p, q, segment.a, segment.b);
      if (met.crossing > 0 && !nearSharedRoom(met.at, drawing, level.drawings.get(segment.link)!)) {
        cost += met.crossing * CROSSING_COST;
      }
      cost += (met.shared / 0.5) * SHARED_COST;
    }
    return cost;
  };

  const key = (u: number, v: number, direction: number): number => ((v - minV) * width + (u - minU)) * 4 + direction;
  const best = new Map<number, number>();
  const frontier = new Frontier();
  let sequence = 0;
  const heuristic = (u: number, v: number): number => (Math.abs(goal.u - u) + Math.abs(goal.v - v)) * STEP_COST;
  const first: SearchNode = {
    ...start,
    direction: sideIndex(link.fromSide),
    cost: 0,
    priority: heuristic(start.u, start.v),
    sequence: sequence++,
  };
  frontier.push(first);
  best.set(key(first.u, first.v, first.direction), 0);

  let found: SearchNode | undefined;
  while (frontier.size > 0) {
    const current = frontier.pop()!;
    if (current.cost !== best.get(key(current.u, current.v, current.direction))) continue;
    if (current.u === goal.u && current.v === goal.v) {
      found = current;
      break;
    }
    for (let direction = 0; direction < STEPS.length; direction += 1) {
      // A route never doubles back on itself.
      if (direction === (current.direction ^ 2)) continue;
      const u = current.u + STEPS[direction].u;
      const v = current.v + STEPS[direction].v;
      if (u < minU || u > maxU || v < minV || v > maxV || blocked(u, v)) continue;
      const atGoal = u === goal.u && v === goal.v;
      const cost = current.cost + STEP_COST +
        (direction !== current.direction ? TURN_COST : 0) +
        (atGoal && direction !== inward ? TURN_COST : 0) +
        stepCost(current, { u, v });
      const stateKey = key(u, v, direction);
      const known = best.get(stateKey);
      if (known !== undefined && known <= cost) continue;
      best.set(stateKey, cost);
      frontier.push({ u, v, direction, cost, priority: cost + heuristic(u, v), sequence: sequence++, parent: current });
    }
  }
  if (!found) return undefined;
  const nodes: { u: number; v: number }[] = [];
  for (let node: SearchNode | undefined = found; node; node = node.parent) nodes.push({ u: node.u, v: node.v });
  nodes.reverse();
  nodes.unshift(origin);
  nodes.push(target);
  return { runs: runsOf(nodes), nodes };
}

/** The route's polyline with every run on its lane's center line. */
function centeredPolyline(drawing: Drawing, route: LatticeRoute): RoutePoint[] {
  const [from, to] = drawing.rooms;
  const runs = route.runs;
  return polyline(from, to, drawing.link, cornerPoints(runs, runs.map(() => 0)), 0.5, 0.5);
}

function routeLength(route: LatticeRoute): number {
  return (route.nodes.length - 1) / 2;
}

interface LaneMember {
  link: string;
  run: number;
  lo: number;
  hi: number;
  /** An offset this member keeps: a straight link's line or a fixed port. */
  fixed?: number;
  /** How far this member may move from the lane's center line. */
  travel: number;
  /** Which side of the lane the member's neighbouring runs leave toward: negative, zero or positive. */
  side: number;
  /** Whether the run ends at a room's wall, where its offset places the port. */
  atWall: boolean;
  /** Offsets the run must keep, each as `sign × offset ≥ limit`: its turns stay clear of the rooms' stubs. */
  bounds: readonly { sign: number; limit: number }[];
}

/**
 * Plan routes for the links of a finished layout. Rooms are the keys `from`
 * and `to` name; links whose rooms are missing, on different levels or the
 * same room are left as they are. Every routable link gets a decision: a
 * route, or none to draw it straight.
 */
export function planLinkRoutes(
  positions: ReadonlyMap<string, GridPosition>,
  links: readonly RouteLink[],
): PlannedLinkRoute[] {
  const sorted = [...links].sort((a, b) => compareStrings(a.id, b.id));
  const levels = new Map<number, Level>();
  const levelOf = (level: number): Level => {
    let found = levels.get(level);
    if (!found) {
      found = new Level([...positions.values()].filter((room) => room.level === level).map((room) => ({
        x: Math.round(room.x),
        y: Math.round(room.y),
        level,
      })));
      levels.set(level, found);
    }
    return found;
  };
  const roomsOf = (link: RouteLink): [GridPosition, GridPosition] | undefined => {
    const from = positions.get(link.from);
    const to = positions.get(link.to);
    if (!from || !to || link.from === link.to || from.level !== to.level) return undefined;
    const at = (room: GridPosition): GridPosition => ({ x: Math.round(room.x), y: Math.round(room.y), level: room.level });
    return [at(from), at(to)];
  };
  const freePort = (port: number | undefined, fixed: boolean | undefined): number => fixed ? port ?? 0.5 : 0.5;

  // Every link starts drawn as it is, a routable one straight from its ports.
  const routable: Drawing[] = [];
  for (const link of sorted) {
    const rooms = roomsOf(link);
    if (!rooms) continue;
    const [from, to] = rooms;
    const points = link.routable
      ? polyline(from, to, link, [], freePort(link.fromPort, link.fromPortFixed), freePort(link.toPort, link.toPortFixed))
      : polyline(from, to, link, link.points ?? [], link.fromPort ?? 0.5, link.toPort ?? 0.5);
    const drawing: Drawing = { link, points, rooms };
    levelOf(from.level).draw(drawing);
    if (link.routable) routable.push(drawing);
  }

  const routes = new Map<string, LatticeRoute>();
  const consider = (drawing: Drawing, crossingsOnly: boolean): void => {
    const level = levelOf(drawing.rooms[0].level);
    const [from, to] = drawing.rooms;
    const straight = level.defects(drawing, drawing.points);
    const bent = runsStraight(from, to, drawing.link) ? 0 : 1;
    if (crossingsOnly ? straight.crossings === 0 : bent === 0 && straight.roomHits === 0) return;
    const route = searchRoute(level, drawing);
    if (!route || route.runs.length < 2) return;
    const points = centeredPolyline(drawing, route);
    const routed = level.defects(drawing, points);
    if (routed.roomHits > 0) return;
    if (crossingsOnly) {
      const straightLength = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
      if (routed.crossings >= straight.crossings ||
        routeLength(route) > straightLength + CROSSING_DETOUR_ALLOWANCE) return;
    } else {
      const before = bent * BENT_WEIGHT + straight.roomHits * ROOM_WEIGHT + straight.crossings * CROSSING_WEIGHT;
      if (routed.crossings * CROSSING_WEIGHT >= before) return;
    }
    routes.set(drawing.link.id, route);
    level.draw({ ...drawing, points });
  };
  // Links bent out of their walls or drawn across rooms first, shortest first,
  // then straight links that only cross others.
  const byLength = [...routable].sort((a, b) => {
    const length = (drawing: Drawing): number =>
      Math.abs(drawing.rooms[1].x - drawing.rooms[0].x) + Math.abs(drawing.rooms[1].y - drawing.rooms[0].y);
    return length(a) - length(b) || compareStrings(a.link.id, b.link.id);
  });
  for (const drawing of byLength) consider(drawing, false);
  for (const drawing of byLength) {
    if (!routes.has(drawing.link.id)) consider(levelOf(drawing.rooms[0].level).drawings.get(drawing.link.id)!, true);
  }

  const { offsets, callouts } = splay(routes, sorted, roomsOf);

  return routable.map((drawing): PlannedLinkRoute => {
    const link = drawing.link;
    const route = routes.get(link.id);
    if (!route) {
      return {
        id: link.id,
        points: [],
        fromPort: freePort(link.fromPort, link.fromPortFixed),
        toPort: freePort(link.toPort, link.toPortFixed),
      };
    }
    const runOffsets = offsets.get(link.id)!;
    const portFor = (offset: number): number => round(0.5 + offset / ROOM_SIZE);
    return {
      id: link.id,
      points: cornerPoints(route.runs, runOffsets),
      fromPort: link.fromPortFixed ? link.fromPort ?? 0.5 : portFor(runOffsets[0]),
      toPort: link.toPortFixed ? link.toPort ?? 0.5 : portFor(runOffsets[runOffsets.length - 1]),
      ...(callouts.has(link.id) ? { callout: callouts.get(link.id)! } : {}),
    };
  });
}

function keepsBounds(member: LaneMember, offset: number): boolean {
  return member.bounds.every((bound) => bound.sign * offset >= bound.limit - EPSILON);
}

/** The offset nearest `offset` that keeps the member's bounds. */
function withinBounds(member: LaneMember, offset: number): number {
  let kept = offset;
  for (const bound of member.bounds) {
    if (bound.sign * kept < bound.limit) kept = round(bound.sign * bound.limit);
  }
  return kept;
}

/**
 * Offsets for every routed run, splaying runs that share a stretch of one lane
 * apart. Straight links on the lane and fixed ports keep their place; the
 * others take lanes `LANE_SPACING` apart within their corridor, each on the
 * side its neighbouring runs leave toward. Runs with no lane left are called out.
 */
function splay(
  routes: ReadonlyMap<string, LatticeRoute>,
  links: readonly RouteLink[],
  roomsOf: (link: RouteLink) => [GridPosition, GridPosition] | undefined,
): { offsets: Map<string, number[]>; callouts: Map<string, number> } {
  const offsets = new Map<string, number[]>();
  const callouts = new Map<string, number>();
  const lanes = new Map<string, LaneMember[]>();
  const join = (levelKey: number, axis: "h" | "v", lane: number, member: LaneMember): void => {
    const key = `${levelKey}:${axis}:${lane}`;
    const members = lanes.get(key);
    if (members) members.push(member);
    else lanes.set(key, [member]);
  };

  for (const link of links) {
    const rooms = roomsOf(link);
    if (!rooms) continue;
    const [from, to] = rooms;
    const route = routes.get(link.id);
    if (route) {
      offsets.set(link.id, route.runs.map(() => 0));
      route.runs.forEach((run, index) => {
        const first = index === 0;
        const last = index === route.runs.length - 1;
        const portFixed = (first && link.fromPortFixed) || (last && link.toPortFixed);
        const port = first ? link.fromPort : link.toPort;
        const travel = Math.min(
          run.lane % 2 === 0 ? CELL_LANE_TRAVEL : HALF_LANE_TRAVEL,
          first || last ? PORT_TRAVEL : Number.POSITIVE_INFINITY,
        );
        // A neighbouring run meets this one's lane at one end and leaves it
        // toward its other end.
        const leaves = (neighbour: Run | undefined): number => neighbour
          ? Math.sign((neighbour.lo === run.lane ? neighbour.hi : neighbour.lo) - run.lane)
          : 0;
        const side = leaves(route.runs[index - 1]) + leaves(route.runs[index + 1]);
        // A run from a port that stays where it is lines up with the port.
        const fixed = portFixed
          ? round(Math.max(-PORT_TRAVEL, Math.min(PORT_TRAVEL, ((port ?? 0.5) - 0.5) * ROOM_SIZE)))
          : undefined;
        if (fixed !== undefined) offsets.get(link.id)![index] = fixed;
        // The run after the one out of a room, and the run before the one into
        // a room, turn beside that room's wall: their lanes lie along the
        // wall's outward direction, and keep the turn past the stub.
        const bounds: { sign: number; limit: number }[] = [];
        const clear = (room: GridPosition, side: RouteSide): void => {
          const normal = NORMALS[side];
          const sign = run.axis === "h" ? normal.y : normal.x;
          const at = run.axis === "h" ? room.y : room.x;
          if (sign !== 0) bounds.push({ sign, limit: TURN_CLEARANCE - sign * (run.lane / 2 - at) });
        };
        if (index === 1) clear(from, link.fromSide);
        if (index === route.runs.length - 2) clear(to, link.toSide);
        join(from.level, run.axis, run.lane, {
          link: link.id,
          run: index,
          lo: run.lo,
          hi: run.hi,
          travel,
          side,
          atWall: first || last,
          bounds,
          ...(fixed !== undefined ? { fixed } : {}),
        });
      });
    } else if (!link.points?.length && runsStraight(from, to, link)) {
      // A straight link holds the middle of its lane between its rooms.
      const axis = NORMALS[link.fromSide].x === 0 ? "v" : "h";
      const lane = axis === "v" ? from.x * 2 : from.y * 2;
      const [p, q] = axis === "v" ? [from.y * 2, to.y * 2] : [from.x * 2, to.x * 2];
      join(from.level, axis, lane, {
        link: link.id, run: -1, lo: Math.min(p, q), hi: Math.max(p, q), fixed: 0, travel: 0, side: 0, atWall: true, bounds: [],
      });
    }
  }

  for (const members of lanes.values()) {
    members.sort((a, b) => a.lo - b.lo || a.hi - b.hi || compareStrings(a.link, b.link) || a.run - b.run);
    // Clusters of members that share a stretch of the lane, directly or through each other.
    const clusters: LaneMember[][] = [];
    let current: LaneMember[] = [];
    let reach = Number.NEGATIVE_INFINITY;
    for (const member of members) {
      if (current.length > 0 && member.lo >= reach) {
        clusters.push(current);
        current = [];
        reach = Number.NEGATIVE_INFINITY;
      }
      current.push(member);
      reach = Math.max(reach, member.hi);
    }
    if (current.length > 0) clusters.push(current);

    for (const cluster of clusters) {
      const routed = cluster.filter((member) => member.run >= 0 && member.fixed === undefined);
      if (routed.length === 0 || new Set(cluster.map((member) => member.link)).size < 2) continue;
      const taken = cluster.filter((member) => member.fixed !== undefined).map((member) => member.fixed!);
      const travel = Math.min(...routed.map((member) => member.travel));
      routed.sort((a, b) => a.side - b.side || compareStrings(a.link, b.link) || a.run - b.run);
      // Of the windows of consecutive free lanes, the one that puts every
      // member on the side its neighbouring runs leave toward, so it turns
      // away without crossing the others, and otherwise keeps nearest the
      // center line.
      const windowOf = (candidates: readonly number[]): { lanes: number[]; cost: number } | undefined => {
        let best: { lanes: number[]; cost: number } | undefined;
        for (let start = 0; start + routed.length <= candidates.length; start += 1) {
          const window = candidates.slice(start, start + routed.length);
          if (window.some((offset, index) => !keepsBounds(routed[index], offset))) continue;
          let cost = 0;
          window.forEach((offset, index) => {
            const side = Math.sign(routed[index].side);
            if (side !== 0 && Math.sign(offset) !== side) cost += 1;
            cost += Math.abs(offset) * LANE_SPACING;
          });
          if (!best || cost < best.cost - EPSILON) best = { lanes: window, cost };
        }
        return best;
      };
      // Lanes `spacing` apart, on a grid through the center line or halfway
      // between, clear of every lane a member keeps.
      const lanesAt = (spacing: number): number[] | undefined => {
        let best: { lanes: number[]; cost: number } | undefined;
        for (const phase of [0, spacing / 2]) {
          const reach = Math.ceil(travel / spacing) + 1;
          const candidates: number[] = [];
          for (let step = -reach; step <= reach; step += 1) {
            const offset = round(phase + step * spacing);
            if (Math.abs(offset) > travel + EPSILON) continue;
            if (taken.some((other) => Math.abs(other - offset) < spacing * 0.99)) continue;
            candidates.push(offset);
          }
          const found = windowOf(candidates);
          if (found && (!best || found.cost < best.cost - EPSILON)) best = found;
        }
        return best?.lanes;
      };
      // Runs that all end at a wall spread their ports evenly across it, as far
      // apart as it allows, so their arrowheads stay apart. A lane a member
      // keeps takes the slot nearest it; one midway between two leaves both.
      const spreadAtWall = (): number[] | undefined => {
        const total = routed.length + taken.length;
        if (!routed.every((member) => member.atWall) || total < 2) return undefined;
        const spacing = (2 * travel) / (total - 1);
        if (spacing < MIN_LANE_SPACING - EPSILON) return undefined;
        let slots = Array.from({ length: total }, (_, index) => round(-travel + index * spacing));
        for (const other of taken) {
          const distances = slots.map((slot) => Math.abs(slot - other));
          const nearest = Math.min(...distances);
          if (distances.filter((distance) => Math.abs(distance - nearest) < EPSILON).length === 1) {
            slots = slots.filter((_, index) => distances[index] !== nearest);
          }
        }
        return windowOf(slots)?.lanes;
      };
      let chosen = spreadAtWall();
      for (const spacing of [LANE_SPACING, (LANE_SPACING + MIN_LANE_SPACING) / 2, MIN_LANE_SPACING]) {
        if (chosen) break;
        chosen = lanesAt(spacing);
      }
      if (!chosen) {
        // No lane for each even packed close: spread them evenly across the
        // corridor and call them out.
        chosen = routed.map((member, index) =>
          withinBounds(member, routed.length === 1 ? 0 : round(-travel + (2 * travel * index) / (routed.length - 1)))
        );
        // A link crowded on more than one stretch keeps its first place.
        routed.forEach((member, index) => {
          if (!callouts.has(member.link)) callouts.set(member.link, index);
        });
      }
      const lanes = chosen;
      routed.forEach((member, index) => {
        offsets.get(member.link)![member.run] = lanes[index];
      });
    }
  }
  return { offsets, callouts };
}
