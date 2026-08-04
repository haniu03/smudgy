/** An integral cell in Smudgy's map grid. */
export interface GridPosition {
  x: number;
  y: number;
  level: number;
}

export type LayoutDirection =
  | "North"
  | "East"
  | "South"
  | "West"
  | "Northeast"
  | "Northwest"
  | "Southeast"
  | "Southwest"
  | "Up"
  | "Down"
  | "In"
  | "Out"
  | "Special"
  | "Other";

/** One room visible in the current player-relative Map.Local chart. */
export interface LayoutNode {
  id: string;
  relative: GridPosition;
}

/** One room that already occupies the durable map. */
export interface LayoutResident {
  id: string;
  position: GridPosition;
  /** False reserves the cell but prevents automatic reflow of this room. */
  movable: boolean;
}

/** A directed topological constraint. */
export interface LayoutEdge {
  from: string;
  to: string;
  direction: LayoutDirection;
}

export interface IntegralLayoutRequest {
  nodes: readonly LayoutNode[];
  residents: readonly LayoutResident[];
  edges: readonly LayoutEdge[];
  centerId?: string;
  allowExistingMoves?: boolean;
  /** Optional diagnostic sink for candidate generation and accepted repairs. */
  trace?: (event: LayoutTraceEvent) => void;
}

export interface IntegralLayoutPlan {
  /** Final cells for every resident and every node in the request. */
  positions: ReadonlyMap<string, GridPosition>;
  /** Resident ids whose durable coordinates changed. */
  movedExisting: ReadonlySet<string>;
  /** The lexicographic geometry tuple used to select this layout. */
  quality: Readonly<LayoutQuality>;
}

interface Candidate {
  positions: Map<string, GridPosition>;
  movedExisting: Set<string>;
  quality: LayoutQuality;
  collisions: number;
}

/**
 * A lexicographic description of a layout. Every field is minimized, in
 * declaration order; no amount of compactness can pay for a cardinal exit
 * leaving its proper ray.
 */
export interface LayoutQuality {
  cardinalRayViolations: number;
  roomObstructions: number;
  linkCrossings: number;
  /** Extra cells along correctly oriented, directed cardinal exits. */
  cardinalSlack: number;
  /** Sum of the occupied bounding-box areas on each level. */
  footprintArea: number;
  /** Sum of the occupied bounding-box perimeters on each level. */
  footprintPerimeter: number;
}

export interface LayoutTraceCandidate {
  quality: LayoutQuality;
  movedExisting: string[];
  /** Omitted for rejected-candidate summaries to avoid duplicating whole maps. */
  positions?: { id: string; x: number; y: number; level: number }[];
}

export type LayoutTraceStage =
  | "stable"
  | "golden"
  | "exact-new"
  | "chart-reflow"
  | "all-candidates"
  | "initial-selection"
  | "greedy-cardinal-repair"
  | "link-obstruction-repair"
  | "bridge-vacuum"
  | "vacuum"
  | "final-selection";

export type LayoutTraceEvent =
  | {
    type: "candidate-batch";
    stage: LayoutTraceStage;
    generated: number;
    collisionFree: number;
    best?: LayoutTraceCandidate;
  }
  | {
    type: "selection";
    stage: "initial-selection" | "final-selection";
    selected: LayoutTraceCandidate;
  }
  | {
    type: "improvement";
    stage: "greedy-cardinal-repair";
    iteration: number;
    before: LayoutTraceCandidate;
    after: LayoutTraceCandidate;
  }
  | {
    type: "vacuum";
    stage: "vacuum";
    iteration: number;
    axis: "x" | "y";
    lower: number;
    upper: number;
    distance: number;
    moved: string[];
    before: LayoutTraceCandidate;
    after: LayoutTraceCandidate;
  }
  | {
    type: "obstruction-repair";
    stage: "link-obstruction-repair";
    iteration: number;
    edge: LayoutEdge;
    offset: GridPosition;
    obstructing: string[];
    moved: string[];
    before: LayoutTraceCandidate;
    after: LayoutTraceCandidate;
  }
  | {
    type: "obstruction-candidates";
    stage: "link-obstruction-repair";
    iteration: number;
    candidates: {
      edge: LayoutEdge;
      offset: GridPosition;
      obstructing: string[];
      moved: string[];
      result: LayoutTraceCandidate;
    }[];
  }
  | {
    type: "bridge-vacuum";
    stage: "bridge-vacuum";
    iteration: number;
    edge: LayoutEdge;
    movingEndpoint: string;
    offset: GridPosition;
    moved: string[];
    before: LayoutTraceCandidate;
    after: LayoutTraceCandidate;
  };

interface Origin {
  x: number;
  y: number;
  level: number;
}

const CARDINAL_VECTORS: Partial<Record<LayoutDirection, GridPosition>> = {
  North: { x: 0, y: -1, level: 0 },
  East: { x: 1, y: 0, level: 0 },
  South: { x: 0, y: 1, level: 0 },
  West: { x: -1, y: 0, level: 0 },
};

const DIRECTION_VECTORS: Partial<Record<LayoutDirection, GridPosition>> = {
  ...CARDINAL_VECTORS,
  Northeast: { x: 1, y: -1, level: 0 },
  Northwest: { x: -1, y: -1, level: 0 },
  Southeast: { x: 1, y: 1, level: 0 },
  Southwest: { x: -1, y: 1, level: 0 },
  Up: { x: 0, y: 0, level: 1 },
  Down: { x: 0, y: 0, level: -1 },
};

const SEARCH_RADIUS = 12;
const ISLAND_GAP = 4;

interface IndexedPhysicalLink {
  a: string;
  b: string;
  edges: LayoutEdge[];
}

interface LayoutTopologyIndex {
  incident: Map<string, LayoutEdge[]>;
  physical: IndexedPhysicalLink[];
}

const TOPOLOGY_INDEXES = new WeakMap<readonly LayoutEdge[], LayoutTopologyIndex>();

/** Cache topology-only indexes for the lifetime of one request's edge array. */
function topologyIndex(edges: readonly LayoutEdge[]): LayoutTopologyIndex {
  const known = TOPOLOGY_INDEXES.get(edges);
  if (known) return known;
  const incident = new Map<string, LayoutEdge[]>();
  const physicalByKey = new Map<string, IndexedPhysicalLink>();
  for (const edge of edges) {
    for (const id of edge.from === edge.to ? [edge.from] : [edge.from, edge.to]) {
      const values = incident.get(id) ?? [];
      values.push(edge);
      incident.set(id, values);
    }
    if (edge.from === edge.to) continue;
    const [a, b] = edge.from.localeCompare(edge.to) <= 0
      ? [edge.from, edge.to]
      : [edge.to, edge.from];
    const key = `${a}|${b}`;
    const link = physicalByKey.get(key) ?? { a, b, edges: [] };
    link.edges.push(edge);
    physicalByKey.set(key, link);
  }
  const result = {
    incident,
    physical: [...physicalByKey.values()].sort((a, b) =>
      a.a.localeCompare(b.a) || a.b.localeCompare(b.b)
    ),
  };
  TOPOLOGY_INDEXES.set(edges, result);
  return result;
}

function integral(position: GridPosition): GridPosition {
  return {
    x: Math.round(position.x),
    y: Math.round(position.y),
    level: Math.round(position.level),
  };
}

function add(position: GridPosition, offset: Origin): GridPosition {
  return {
    x: position.x + offset.x,
    y: position.y + offset.y,
    level: position.level + offset.level,
  };
}

function subtract(a: GridPosition, b: GridPosition): Origin {
  return { x: a.x - b.x, y: a.y - b.y, level: a.level - b.level };
}

function samePosition(a: GridPosition, b: GridPosition): boolean {
  return a.x === b.x && a.y === b.y && a.level === b.level;
}

function cellKey(position: GridPosition): string {
  return `${position.level}:${position.x}:${position.y}`;
}

function offsetKey(offset: Origin): string {
  return `${offset.level}:${offset.x}:${offset.y}`;
}

function manhattan(a: GridPosition, b: GridPosition): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.level - b.level);
}

function cardinalRayDistance(
  direction: LayoutDirection,
  delta: GridPosition,
): number | undefined {
  const expected = CARDINAL_VECTORS[direction];
  if (!expected || delta.level !== 0) return undefined;
  const onRay = expected.x !== 0
    ? delta.y === 0 && Math.sign(delta.x) === expected.x
    : delta.x === 0 && Math.sign(delta.y) === expected.y;
  if (!onRay) return undefined;
  return expected.x !== 0 ? Math.abs(delta.x) : Math.abs(delta.y);
}

function segmentIntersectsRoomCell(
  from: GridPosition,
  to: GridPosition,
  room: GridPosition,
): boolean {
  if (from.level !== room.level || to.level !== room.level) return false;
  if (samePosition(from, room) || samePosition(to, room)) return false;
  const half = 0.32;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let enter = 0;
  let leave = 1;
  const clips: readonly [number, number][] = [
    [-dx, from.x - (room.x - half)],
    [dx, room.x + half - from.x],
    [-dy, from.y - (room.y - half)],
    [dy, room.y + half - from.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
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

function collisionGroups(positions: ReadonlyMap<string, GridPosition>): string[][] {
  const cells = new Map<string, string[]>();
  for (const [id, position] of positions) {
    const key = cellKey(position);
    const occupants = cells.get(key) ?? [];
    occupants.push(id);
    cells.set(key, occupants);
  }
  return [...cells.values()].filter((occupants) => occupants.length > 1);
}

function translationOffsets(radius = SEARCH_RADIUS): Origin[] {
  const result: Origin[] = [{ x: 0, y: 0, level: 0 }];
  for (let distance = 1; distance <= radius; distance += 1) {
    for (let dx = -distance; dx <= distance; dx += 1) {
      const dy = distance - Math.abs(dx);
      result.push({ x: dx, y: dy, level: 0 });
      if (dy !== 0) result.push({ x: dx, y: -dy, level: 0 });
    }
  }
  return result;
}

const NEARBY_OFFSETS = translationOffsets();

function bounds(positions: Iterable<GridPosition>): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} | undefined {
  const values = [...positions];
  if (values.length === 0) return undefined;
  return {
    minX: Math.min(...values.map((position) => position.x)),
    maxX: Math.max(...values.map((position) => position.x)),
    minY: Math.min(...values.map((position) => position.y)),
    maxY: Math.max(...values.map((position) => position.y)),
  };
}

function farOffsets(
  moving: Iterable<GridPosition>,
  occupied: Iterable<GridPosition>,
): Origin[] {
  const movingBounds = bounds(moving);
  const occupiedBounds = bounds(occupied);
  if (!movingBounds || !occupiedBounds) return [];
  return [
    { x: occupiedBounds.maxX + ISLAND_GAP - movingBounds.minX, y: 0, level: 0 },
    { x: occupiedBounds.minX - ISLAND_GAP - movingBounds.maxX, y: 0, level: 0 },
    { x: 0, y: occupiedBounds.maxY + ISLAND_GAP - movingBounds.minY, level: 0 },
    { x: 0, y: occupiedBounds.minY - ISLAND_GAP - movingBounds.maxY, level: 0 },
  ];
}

function uniqueOffsets(offsets: Iterable<Origin>): Origin[] {
  const seen = new Set<string>();
  const result: Origin[] = [];
  for (const offset of offsets) {
    const key = offsetKey(offset);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(offset);
  }
  return result;
}

function footprintQuality(positions: ReadonlyMap<string, GridPosition>): {
  area: number;
  perimeter: number;
} {
  const levels = new Map<number, GridPosition[]>();
  for (const position of positions.values()) {
    const level = levels.get(position.level) ?? [];
    level.push(position);
    levels.set(position.level, level);
  }

  let area = 0;
  let perimeter = 0;
  for (const positionsOnLevel of levels.values()) {
    const levelBounds = bounds(positionsOnLevel);
    if (!levelBounds) continue;
    const width = levelBounds.maxX - levelBounds.minX + 1;
    const height = levelBounds.maxY - levelBounds.minY + 1;
    area += width * height;
    perimeter += 2 * (width + height);
  }
  return { area, perimeter };
}

function layoutQuality(
  positions: ReadonlyMap<string, GridPosition>,
  edges: readonly LayoutEdge[],
): LayoutQuality {
  const footprint = footprintQuality(positions);
  const result: LayoutQuality = {
    cardinalRayViolations: 0,
    roomObstructions: 0,
    linkCrossings: 0,
    cardinalSlack: 0,
    footprintArea: footprint.area,
    footprintPerimeter: footprint.perimeter,
  };

  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const expected = CARDINAL_VECTORS[edge.direction];
    if (!expected || !from || !to) continue;
    const delta = subtract(to, from);
    const distance = cardinalRayDistance(edge.direction, delta);
    if (distance !== undefined) {
      result.cardinalSlack += Math.max(0, distance - 1);
    } else {
      result.cardinalRayViolations += 1;
    }
  }

  const physicalEdges: { fromId: string; toId: string; from: GridPosition; to: GridPosition }[] = [];
  for (const link of topologyIndex(edges).physical) {
    const from = positions.get(link.a);
    const to = positions.get(link.b);
    if (!from || !to || from.level !== to.level) continue;
    physicalEdges.push({ fromId: link.a, toId: link.b, from, to });
    for (const room of positions.values()) {
      if (segmentIntersectsRoomCell(from, to, room)) result.roomObstructions += 1;
    }
  }
  for (let a = 0; a < physicalEdges.length; a += 1) {
    const first = physicalEdges[a];
    for (let b = a + 1; b < physicalEdges.length; b += 1) {
      const second = physicalEdges[b];
      if (first.fromId === second.fromId || first.fromId === second.toId ||
        first.toId === second.fromId || first.toId === second.toId) continue;
      if (strictSegmentsIntersect(first.from, first.to, second.from, second.to)) {
        result.linkCrossings += 1;
      }
    }
  }
  return result;
}

/** Positive means `a` is the greedily preferred layout. */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.collisions !== b.collisions) return b.collisions - a.collisions;
  if (a.quality.cardinalRayViolations !== b.quality.cardinalRayViolations) {
    return b.quality.cardinalRayViolations - a.quality.cardinalRayViolations;
  }
  if (a.quality.roomObstructions !== b.quality.roomObstructions) {
    return b.quality.roomObstructions - a.quality.roomObstructions;
  }
  if (a.quality.linkCrossings !== b.quality.linkCrossings) {
    return b.quality.linkCrossings - a.quality.linkCrossings;
  }
  if (a.quality.cardinalSlack !== b.quality.cardinalSlack) {
    return b.quality.cardinalSlack - a.quality.cardinalSlack;
  }
  if (a.quality.footprintArea !== b.quality.footprintArea) {
    return b.quality.footprintArea - a.quality.footprintArea;
  }
  if (a.quality.footprintPerimeter !== b.quality.footprintPerimeter) {
    return b.quality.footprintPerimeter - a.quality.footprintPerimeter;
  }
  return b.movedExisting.size - a.movedExisting.size;
}

function traceCandidate(value: Candidate, includePositions = true): LayoutTraceCandidate {
  const result: LayoutTraceCandidate = {
    quality: { ...value.quality },
    movedExisting: [...value.movedExisting].sort(),
  };
  if (includePositions) {
    result.positions = [...value.positions]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, position]) => ({ id, ...position }));
  }
  return result;
}

function traceCandidateBatch(
  trace: IntegralLayoutRequest["trace"],
  stage: LayoutTraceStage,
  values: readonly (Candidate | undefined)[],
): void {
  if (!trace) return;
  const generated = values.filter((value): value is Candidate => value !== undefined);
  const collisionFree = generated.filter((value) => value.collisions === 0);
  collisionFree.sort((a, b) => compareCandidates(b, a));
  trace({
    type: "candidate-batch",
    stage,
    generated: generated.length,
    collisionFree: collisionFree.length,
    best: collisionFree[0] ? traceCandidate(collisionFree[0], false) : undefined,
  });
}

class DisjointSet {
  readonly #parent = new Map<string, string>();

  add(id: string): void {
    if (!this.#parent.has(id)) this.#parent.set(id, id);
  }

  find(id: string): string {
    this.add(id);
    const parent = this.#parent.get(id) ?? id;
    if (parent === id) return id;
    const root = this.find(parent);
    this.#parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.#parent.set(rootB, rootA);
  }
}

function coherentBlocks(
  current: ReadonlyMap<string, GridPosition>,
  edges: readonly LayoutEdge[],
): Map<string, Set<string>> {
  const sets = new DisjointSet();
  for (const id of current.keys()) sets.add(id);
  for (const edge of edges) {
    const from = current.get(edge.from);
    const to = current.get(edge.to);
    const expected = DIRECTION_VECTORS[edge.direction];
    if (from && to && expected && samePosition(subtract(to, from), expected)) {
      sets.union(edge.from, edge.to);
    }
  }

  const byRoot = new Map<string, Set<string>>();
  for (const id of current.keys()) {
    const root = sets.find(id);
    const block = byRoot.get(root) ?? new Set<string>();
    block.add(id);
    byRoot.set(root, block);
  }

  const result = new Map<string, Set<string>>();
  for (const block of byRoot.values()) {
    for (const id of block) result.set(id, block);
  }
  return result;
}

function candidate(
  positions: Map<string, GridPosition>,
  current: ReadonlyMap<string, GridPosition>,
  edges: readonly LayoutEdge[],
): Candidate {
  const movedExisting = new Set<string>();
  for (const [id, before] of current) {
    const after = positions.get(id);
    if (after && !samePosition(before, after)) movedExisting.add(id);
  }
  return {
    positions,
    movedExisting,
    quality: layoutQuality(positions, edges),
    collisions: collisionGroups(positions).length,
  };
}

function connectedComponents(ids: ReadonlySet<string>, edges: readonly LayoutEdge[]): string[][] {
  const sets = new DisjointSet();
  for (const id of ids) sets.add(id);
  for (const edge of edges) {
    if (ids.has(edge.from) && ids.has(edge.to)) sets.union(edge.from, edge.to);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = sets.find(id);
    const group = groups.get(root) ?? [];
    group.push(id);
    groups.set(root, group);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/** Place new islands with the strongest established topological seam first. */
function connectionFirstComponents(
  ids: ReadonlySet<string>,
  positions: ReadonlyMap<string, GridPosition>,
  edges: readonly LayoutEdge[],
): string[][] {
  const ranked = connectedComponents(ids, edges).map((component) => {
    const members = new Set(component);
    const anchors = new Set<string>();
    let edgeCount = 0;
    for (const edge of edges) {
      if (members.has(edge.from) && !members.has(edge.to) && positions.has(edge.to)) {
        edgeCount += 1;
        anchors.add(edge.to);
      }
      if (members.has(edge.to) && !members.has(edge.from) && positions.has(edge.from)) {
        edgeCount += 1;
        anchors.add(edge.from);
      }
    }
    return { component, edgeCount, anchorCount: anchors.size };
  });
  ranked.sort((a, b) =>
    b.anchorCount - a.anchorCount ||
    b.edgeCount - a.edgeCount ||
    b.component.length - a.component.length ||
    a.component[0].localeCompare(b.component[0])
  );
  return ranked.map(({ component }) => component);
}

function anchorOrigins(
  component: ReadonlySet<string>,
  positions: ReadonlyMap<string, GridPosition>,
  nodes: ReadonlyMap<string, LayoutNode>,
  edges: readonly LayoutEdge[],
  centerId: string | undefined,
): Origin[] {
  const adjacent = new Set<string>();
  const adjacencyCount = new Map<string, number>();
  const recordAdjacent = (id: string): void => {
    adjacent.add(id);
    adjacencyCount.set(id, (adjacencyCount.get(id) ?? 0) + 1);
  };
  for (const edge of edges) {
    if (component.has(edge.from) && !component.has(edge.to) && nodes.has(edge.to) && positions.has(edge.to)) {
      recordAdjacent(edge.to);
    }
    if (component.has(edge.to) && !component.has(edge.from) && nodes.has(edge.from) && positions.has(edge.from)) {
      recordAdjacent(edge.from);
    }
  }

  let anchors = [...nodes.keys()].filter((id) => positions.has(id) && !component.has(id));
  anchors.sort((a, b) => {
    if (adjacent.has(a) !== adjacent.has(b)) return adjacent.has(a) ? -1 : 1;
    const connectionDifference = (adjacencyCount.get(b) ?? 0) - (adjacencyCount.get(a) ?? 0);
    if (connectionDifference !== 0) return connectionDifference;
    if (a === centerId) return -1;
    if (b === centerId) return 1;
    return a.localeCompare(b);
  });

  // Once a component actually touches the durable topology, unrelated chart
  // anchors are noise. Seed it exclusively from the rooms at that seam.
  if (adjacent.size > 0) anchors = anchors.filter((id) => adjacent.has(id));

  return uniqueOffsets(anchors.slice(0, 8).map((id) => {
    const position = positions.get(id) as GridPosition;
    const node = nodes.get(id) as LayoutNode;
    return subtract(position, node.relative);
  }));
}

function knownOrigins(
  positions: ReadonlyMap<string, GridPosition>,
  nodes: ReadonlyMap<string, LayoutNode>,
  centerId: string | undefined,
): Origin[] {
  const anchors = [...nodes.keys()].filter((id) => positions.has(id));
  anchors.sort((a, b) => {
    if (a === centerId) return -1;
    if (b === centerId) return 1;
    return a.localeCompare(b);
  });
  return uniqueOffsets(anchors.slice(0, 8).map((id) =>
    subtract(positions.get(id) as GridPosition, (nodes.get(id) as LayoutNode).relative)
  ));
}

function packedOrigin(
  component: readonly string[],
  positions: ReadonlyMap<string, GridPosition>,
  nodes: ReadonlyMap<string, LayoutNode>,
): Origin {
  const relative = component.map((id) => nodes.get(id)?.relative).filter((value): value is GridPosition => !!value);
  const relativeBounds = bounds(relative);
  const occupiedBounds = bounds(positions.values());
  const minLevel = relative.length > 0 ? Math.min(...relative.map((position) => position.level)) : 0;
  if (!relativeBounds || !occupiedBounds) {
    return {
      x: relativeBounds ? -relativeBounds.minX : 0,
      y: relativeBounds ? -relativeBounds.minY : 0,
      level: -minLevel,
    };
  }
  return {
    x: occupiedBounds.maxX + ISLAND_GAP - relativeBounds.minX,
    y: occupiedBounds.minY - relativeBounds.minY,
    level: -minLevel,
  };
}

function componentPositions(
  ids: readonly string[],
  nodes: ReadonlyMap<string, LayoutNode>,
  origin: Origin,
  translation: Origin = { x: 0, y: 0, level: 0 },
): Map<string, GridPosition> {
  const result = new Map<string, GridPosition>();
  const combined = {
    x: origin.x + translation.x,
    y: origin.y + translation.y,
    level: origin.level + translation.level,
  };
  for (const id of ids) {
    const node = nodes.get(id);
    if (node) result.set(id, add(node.relative, combined));
  }
  return result;
}

function fits(
  placement: ReadonlyMap<string, GridPosition>,
  positions: ReadonlyMap<string, GridPosition>,
): boolean {
  const occupied = new Map<string, string>();
  for (const [id, position] of positions) occupied.set(cellKey(position), id);
  const staged = new Set<string>();
  for (const [id, position] of placement) {
    const key = cellKey(position);
    const occupant = occupied.get(key);
    if ((occupant && occupant !== id) || staged.has(key)) return false;
    staged.add(key);
  }
  return true;
}

function bestStablePlacement(
  initial: Map<string, GridPosition>,
  current: ReadonlyMap<string, GridPosition>,
  edges: readonly LayoutEdge[],
  nodes: ReadonlyMap<string, LayoutNode>,
  centerId: string | undefined,
): Candidate | undefined {
  const positions = new Map(initial);
  const newIds = new Set([...nodes.keys()].filter((id) => !current.has(id)));
  for (const component of connectionFirstComponents(newIds, positions, edges)) {
    const componentSet = new Set(component);
    const origins = anchorOrigins(componentSet, positions, nodes, edges, centerId);
    if (origins.length === 0) origins.push(packedOrigin(component, positions, nodes));

    let best: Candidate | undefined;
    for (const origin of origins) {
      const base = componentPositions(component, nodes, origin);
      const offsets = uniqueOffsets([
        ...NEARBY_OFFSETS,
        ...farOffsets(base.values(), positions.values()),
      ]);
      for (const offset of offsets) {
        const placement = componentPositions(component, nodes, origin, offset);
        if (!fits(placement, positions)) continue;
        const trial = new Map(positions);
        for (const [id, position] of placement) trial.set(id, position);
        const evaluated = candidate(trial, current, edges);
        if (!best || compareCandidates(evaluated, best) > 0) best = evaluated;
      }
    }
    if (!best) return undefined;
    for (const id of component) {
      const position = best.positions.get(id);
      if (position) positions.set(id, position);
    }
  }
  return candidate(positions, current, edges);
}

function chooseKeeper(
  occupants: readonly string[],
  protectedIds: ReadonlySet<string>,
  residents: ReadonlyMap<string, LayoutResident>,
  centerId: string | undefined,
): string {
  return [...occupants].sort((a, b) => {
    if (a === centerId) return -1;
    if (b === centerId) return 1;
    if (protectedIds.has(a) !== protectedIds.has(b)) return protectedIds.has(a) ? -1 : 1;
    const fixedA = residents.get(a)?.movable === false;
    const fixedB = residents.get(b)?.movable === false;
    if (fixedA !== fixedB) return fixedA ? -1 : 1;
    return a.localeCompare(b);
  })[0];
}

function moveCollisionBlocks(
  initial: Map<string, GridPosition>,
  protectedIds: ReadonlySet<string>,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  blocks: ReadonlyMap<string, Set<string>>,
  edges: readonly LayoutEdge[],
  centerId: string | undefined,
): Map<string, GridPosition> | undefined {
  const positions = new Map(initial);
  for (let iteration = 0; iteration <= residents.size; iteration += 1) {
    const collision = collisionGroups(positions)[0];
    if (!collision) return positions;
    const keeper = chooseKeeper(collision, protectedIds, residents, centerId);
    const loser = collision.find((id) =>
      id !== keeper && !protectedIds.has(id) && residents.get(id)?.movable !== false
    );
    if (!loser) return undefined;

    const coherent = blocks.get(loser) ?? new Set([loser]);
    const canMoveWholeBlock = [...coherent].every((id) =>
      !protectedIds.has(id) && residents.get(id)?.movable !== false
    );
    const movingIds = canMoveWholeBlock ? [...coherent] : [loser];
    const movingPositions = movingIds.map((id) => positions.get(id)).filter((value): value is GridPosition => !!value);
    const stationary = new Map(positions);
    for (const id of movingIds) stationary.delete(id);

    let best: Candidate | undefined;
    const offsets = uniqueOffsets([
      ...NEARBY_OFFSETS.slice(1),
      ...farOffsets(movingPositions, stationary.values()),
    ]);
    for (const offset of offsets) {
      const trial = new Map(stationary);
      const placement = new Map<string, GridPosition>();
      for (const id of movingIds) {
        const position = positions.get(id);
        if (position) placement.set(id, add(position, offset));
      }
      // Other collisions may still be waiting for the next loop iteration;
      // this translation only has to avoid introducing one for this block.
      if (!fits(placement, stationary)) continue;
      for (const [id, position] of placement) trial.set(id, position);
      const evaluated = candidate(trial, current, edges);
      if (!best || compareCandidates(evaluated, best) > 0) best = evaluated;
    }
    if (!best) return undefined;
    positions.clear();
    for (const [id, position] of best.positions) positions.set(id, position);
  }
  return undefined;
}

function positionMapKey(positions: ReadonlyMap<string, GridPosition>): string {
  return [...positions]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, position]) => `${id}@${cellKey(position)}`)
    .join("|");
}

interface ExpansionAxis {
  dx: number;
  dy: number;
  includes(position: GridPosition, cut: GridPosition): boolean;
}

const EXPANSION_AXES: readonly ExpansionAxis[] = [
  { dx: 0, dy: -1, includes: (position, cut) => position.y <= cut.y },
  { dx: 1, dy: 0, includes: (position, cut) => position.x >= cut.x },
  { dx: 0, dy: 1, includes: (position, cut) => position.y >= cut.y },
  { dx: -1, dy: 0, includes: (position, cut) => position.x <= cut.x },
];

function strictSegmentsIntersect(
  a: GridPosition,
  b: GridPosition,
  c: GridPosition,
  d: GridPosition,
): boolean {
  if (a.level !== b.level || a.level !== c.level || a.level !== d.level) return false;
  const cross = (p: GridPosition, q: GridPosition, r: GridPosition): number =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  // Collinear contact and shared endpoints do not cross the open swept path.
  return ((abC < 0 && abD > 0) || (abC > 0 && abD < 0)) &&
    ((cdA < 0 && cdB > 0) || (cdA > 0 && cdB < 0));
}

function safePushClosure(
  positions: ReadonlyMap<string, GridPosition>,
  roots: ReadonlySet<string>,
  protectedIds: ReadonlySet<string>,
  residents: ReadonlyMap<string, LayoutResident>,
  edges: readonly LayoutEdge[],
  offset: Origin,
): Set<string> | undefined {
  const topology = topologyIndex(edges);
  const occupants = new Map<string, string[]>();
  for (const [id, position] of positions) {
    const ids = occupants.get(cellKey(position)) ?? [];
    ids.push(id);
    occupants.set(cellKey(position), ids);
  }

  const closure = new Set<string>();
  const queued = new Set<string>();
  const queue: string[] = [];
  const enqueue = (id: string): void => {
    // Protected ids describe the staged patch. Its cells may be crossed during
    // an intermediate one-cell push, but the patch itself never moves.
    if (protectedIds.has(id) || queued.has(id)) return;
    queued.add(id);
    queue.push(id);
  };
  for (const id of roots) enqueue(id);

  while (queue.length > 0) {
    const id = queue.shift() as string;
    const position = positions.get(id);
    if (!position) continue;
    if (residents.get(id)?.movable === false) return undefined;
    closure.add(id);

    const destination = add(position, offset);
    for (const occupant of occupants.get(cellKey(destination)) ?? []) enqueue(occupant);

    for (const edge of topology.incident.get(id) ?? []) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      const expected = DIRECTION_VECTORS[edge.direction];
      if (!from || !to || !expected) continue;
      const directedDelta = subtract(to, from);
      const coherent = CARDINAL_VECTORS[edge.direction]
        ? cardinalRayDistance(edge.direction, directedDelta) !== undefined
        : samePosition(directedDelta, expected);
      if (!coherent) continue;
      const otherId = edge.from === id ? edge.to : edge.from;
      if (protectedIds.has(otherId)) continue;
      const other = positions.get(otherId);
      if (!other) continue;
      const delta = subtract(other, position);
      const perpendicular = delta.x * offset.x + delta.y * offset.y === 0;
      if (!perpendicular) continue;

      enqueue(otherId);
      if (other.level !== position.level) continue;
      const pushedOther = add(other, offset);
      const minX = Math.min(position.x, pushedOther.x);
      const maxX = Math.max(position.x, pushedOther.x);
      const minY = Math.min(position.y, pushedOther.y);
      const maxY = Math.max(position.y, pushedOther.y);
      for (const [roomId, roomPosition] of positions) {
        if (protectedIds.has(roomId) || roomPosition.level !== position.level) continue;
        if (roomPosition.x >= minX && roomPosition.x <= maxX &&
          roomPosition.y >= minY && roomPosition.y <= maxY) {
          enqueue(roomId);
        }
      }
    }

    // A push must not sweep a room through an existing link. Pull both link
    // endpoints into the closure, matching Arctic's recursive map-push rule.
    for (const link of topology.physical) {
      if (link.a === id || link.b === id ||
        protectedIds.has(link.a) || protectedIds.has(link.b)) continue;
      const from = positions.get(link.a);
      const to = positions.get(link.b);
      if (from && to && strictSegmentsIntersect(position, destination, from, to)) {
        enqueue(link.a);
        enqueue(link.b);
      }
    }
  }
  return closure.size > 0 ? closure : undefined;
}

/**
 * Insert space with a sequence of one-cell, geometry-safe pushes. Unlike a
 * half-plane shift, the moving set is the recursive causal closure of the
 * blockers: perpendicular correct-ray cardinal neighbors (or exact non-cardinal
 * neighbors), destination occupants, swept rooms, and endpoints of crossed links.
 */
export function safePushRepairs(
  initial: Map<string, GridPosition>,
  protectedIds: ReadonlySet<string>,
  residents: ReadonlyMap<string, LayoutResident>,
  edges: readonly LayoutEdge[],
): Map<string, GridPosition>[] {
  const protectedPositions = [...protectedIds]
    .map((id) => initial.get(id))
    .filter((position): position is GridPosition => position !== undefined);
  const patchBounds = bounds(protectedPositions);
  if (!patchBounds) return [];

  const initialRoots = new Set<string>();
  for (const occupants of collisionGroups(initial)) {
    if (!occupants.some((id) => protectedIds.has(id))) continue;
    for (const id of occupants) if (!protectedIds.has(id)) initialRoots.add(id);
  }
  if (initialRoots.size === 0) return [];

  const result: Map<string, GridPosition>[] = [];
  const seen = new Set<string>();
  for (const axis of EXPANSION_AXES) {
    const positions = new Map(initial);
    let moving = new Set(initialRoots);
    const span = axis.dx === 0
      ? patchBounds.maxY - patchBounds.minY + 1
      : patchBounds.maxX - patchBounds.minX + 1;
    for (let distance = 1; distance <= span + 1; distance += 1) {
      for (const occupants of collisionGroups(positions)) {
        if (!occupants.some((id) => protectedIds.has(id))) continue;
        for (const id of occupants) if (!protectedIds.has(id)) moving.add(id);
      }
      const closure = safePushClosure(
        positions,
        moving,
        protectedIds,
        residents,
        edges,
        { x: axis.dx, y: axis.dy, level: 0 },
      );
      if (!closure) break;
      for (const id of closure) {
        const position = positions.get(id);
        if (position) positions.set(id, add(position, { x: axis.dx, y: axis.dy, level: 0 }));
      }
      moving = closure;

      if (collisionGroups(positions).length > 0) continue;
      const key = positionMapKey(positions);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(new Map(positions));
      }
      break;
    }
  }
  return result;
}

interface ObstructionRepairCandidate {
  candidate: Candidate;
  edge: LayoutEdge;
  offset: GridPosition;
  obstructing: string[];
  moved: string[];
}

function obstructingRoomIds(
  positions: ReadonlyMap<string, GridPosition>,
  fromId: string,
  toId: string,
): string[] {
  const from = positions.get(fromId);
  const to = positions.get(toId);
  if (!from || !to || from.level !== to.level) return [];
  return [...positions]
    .filter(([id, position]) =>
      id !== fromId && id !== toId && segmentIntersectsRoomCell(from, to, position)
    )
    .map(([id]) => id)
    .sort();
}

/**
 * Extend a set of rooms on a link through the cardinal branch trailing behind
 * the requested push. Leaving that branch in place would merely replace a room
 * obstruction with a stretched link crossing the line we are trying to clear.
 */
function trailingCardinalRoots(
  positions: ReadonlyMap<string, GridPosition>,
  initialRoots: ReadonlySet<string>,
  protectedIds: ReadonlySet<string>,
  edges: readonly LayoutEdge[],
  lineOrigin: GridPosition,
  offset: GridPosition,
): Set<string> {
  const result = new Set(initialRoots);
  const queue = [...initialRoots];
  const incident = topologyIndex(edges).incident;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const position = positions.get(id);
    if (!position) continue;
    for (const edge of incident.get(id) ?? []) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to || from.level !== to.level ||
        cardinalRayDistance(edge.direction, subtract(to, from)) === undefined) continue;
      const otherId = edge.from === id ? edge.to : edge.from;
      if (protectedIds.has(otherId) || result.has(otherId)) continue;
      const other = positions.get(otherId);
      if (!other || other.level !== lineOrigin.level) continue;
      const delta = subtract(other, position);
      const parallelToPush = delta.x * offset.y - delta.y * offset.x === 0;
      if (!parallelToPush) continue;

      // Positive projection is already on the leading side of the protected
      // line. Zero and negative projections would trail through it.
      const projection = (other.x - lineOrigin.x) * offset.x +
        (other.y - lineOrigin.y) * offset.y;
      if (projection > 0) continue;
      result.add(otherId);
      queue.push(otherId);
    }
  }
  return result;
}

function pushDistancePastLine(
  positions: ReadonlyMap<string, GridPosition>,
  roots: ReadonlySet<string>,
  lineOrigin: GridPosition,
  offset: GridPosition,
): number {
  let minimumProjection = Number.POSITIVE_INFINITY;
  for (const id of roots) {
    const position = positions.get(id);
    if (!position || position.level !== lineOrigin.level) continue;
    minimumProjection = Math.min(
      minimumProjection,
      (position.x - lineOrigin.x) * offset.x + (position.y - lineOrigin.y) * offset.y,
    );
  }
  return Number.isFinite(minimumProjection)
    ? Math.max(0, 1 - minimumProjection)
    : 0;
}

/**
 * Clear rooms from the open segment of an existing link. The endpoints stay
 * fixed while every obstructing room and its trailing cardinal branch are
 * pushed perpendicular to the segment with the same recursive closure used by
 * Arctic-style map push. Repeated one-cell pushes carry the full branch beyond
 * the protected line instead of replacing room obstructions with link crossings.
 */
function obstructionRepairCandidates(
  base: Candidate,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  edges: readonly LayoutEdge[],
): ObstructionRepairCandidate[] {
  const obstructed: { edge: LayoutEdge; ids: string[]; distance: number }[] = [];
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const from = base.positions.get(edge.from);
    const to = base.positions.get(edge.to);
    if (!from || !to || from.level !== to.level) continue;
    const key = edge.from.localeCompare(edge.to) <= 0
      ? `${edge.from}|${edge.to}`
      : `${edge.to}|${edge.from}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const ids = obstructingRoomIds(base.positions, edge.from, edge.to);
    if (ids.length > 0) obstructed.push({ edge, ids, distance: manhattan(from, to) });
  }
  obstructed.sort((a, b) => b.ids.length - a.ids.length || b.distance - a.distance);

  const result: ObstructionRepairCandidate[] = [];
  const seenPositions = new Set<string>();
  for (const { edge, ids } of obstructed.slice(0, 48)) {
    const from = base.positions.get(edge.from) as GridPosition;
    const to = base.positions.get(edge.to) as GridPosition;
    const delta = subtract(to, from);
    const offsets: GridPosition[] = delta.y === 0
      ? [{ x: 0, y: -1, level: 0 }, { x: 0, y: 1, level: 0 }]
      : delta.x === 0
      ? [{ x: -1, y: 0, level: 0 }, { x: 1, y: 0, level: 0 }]
      : EXPANSION_AXES.map(({ dx, dy }) => ({ x: dx, y: dy, level: 0 }));
    const protectedIds = new Set([edge.from, edge.to]);

    for (const offset of offsets) {
      const trial = new Map(base.positions);
      let bestForDirection: ObstructionRepairCandidate | undefined;
      let moving = trailingCardinalRoots(
        base.positions,
        new Set(ids),
        protectedIds,
        edges,
        from,
        offset,
      );
      let distanceLimit = pushDistancePastLine(
        base.positions,
        moving,
        from,
        offset,
      );
      const allMoved = new Set<string>();
      for (let distance = 1; distance <= distanceLimit; distance += 1) {
        const closure = safePushClosure(
          trial,
          moving,
          protectedIds,
          residents,
          edges,
          offset,
        );
        if (!closure) break;
        for (const id of closure) {
          const position = trial.get(id);
          if (position) trial.set(id, add(position, offset));
          allMoved.add(id);
        }
        moving = closure;
        distanceLimit = Math.max(
          distanceLimit,
          distance + pushDistancePastLine(trial, closure, from, offset),
        );

        if (collisionGroups(trial).length > 0) continue;
        if (obstructingRoomIds(trial, edge.from, edge.to).length >= ids.length) continue;
        const repair = {
          candidate: candidate(new Map(trial), current, edges),
          edge,
          offset: {
            x: offset.x * distance,
            y: offset.y * distance,
            level: offset.level * distance,
          },
          obstructing: ids,
          moved: [...allMoved].sort(),
        } satisfies ObstructionRepairCandidate;
        if (!bestForDirection ||
          compareCandidates(repair.candidate, bestForDirection.candidate) > 0) {
          bestForDirection = repair;
        }
      }
      if (bestForDirection) {
        const key = positionMapKey(bestForDirection.candidate.positions);
        if (!seenPositions.has(key)) {
          seenPositions.add(key);
          result.push(bestForDirection);
        }
      }
    }
  }
  return result;
}

function greedyObstructionRepair(
  seed: Candidate,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  edges: readonly LayoutEdge[],
  trace: IntegralLayoutRequest["trace"],
): Candidate | undefined {
  let best = seed;
  let changed = false;
  const limit = Math.min(8, Math.max(1, edges.length));
  for (let iteration = 0; iteration < limit; iteration += 1) {
    const repairs = obstructionRepairCandidates(best, current, residents, edges)
      .sort((a, b) => compareCandidates(b.candidate, a.candidate));
    trace?.({
      type: "obstruction-candidates",
      stage: "link-obstruction-repair",
      iteration,
      candidates: repairs.slice(0, 8).map((repair) => ({
        edge: { ...repair.edge },
        offset: { ...repair.offset },
        obstructing: repair.obstructing,
        moved: repair.moved,
        result: traceCandidate(repair.candidate, false),
      })),
    });
    const accepted = repairs[0];
    if (!accepted || compareCandidates(accepted.candidate, best) <= 0) break;
    trace?.({
      type: "obstruction-repair",
      stage: "link-obstruction-repair",
      iteration,
      edge: { ...accepted.edge },
      offset: { ...accepted.offset },
      obstructing: accepted.obstructing,
      moved: accepted.moved,
      before: traceCandidate(best),
      after: traceCandidate(accepted.candidate),
    });
    best = accepted.candidate;
    changed = true;
  }
  return changed ? best : undefined;
}

/**
 * Resolve a patch collision by inserting rows or columns into the map. Every
 * room on the far side of the collision moves together, so the map grows
 * instead of ejecting one blocker to a remote island.
 */
function expansionRepairs(
  initial: Map<string, GridPosition>,
  protectedIds: ReadonlySet<string>,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  blocks: ReadonlyMap<string, Set<string>>,
  edges: readonly LayoutEdge[],
  centerId: string | undefined,
): Map<string, GridPosition>[] {
  const protectedPositions = [...protectedIds]
    .map((id) => initial.get(id))
    .filter((position): position is GridPosition => position !== undefined);
  const patchBounds = bounds(protectedPositions);
  if (!patchBounds) return [];

  const result: Map<string, GridPosition>[] = [];
  const seen = new Set<string>();
  const collisions = collisionGroups(initial);
  for (const occupants of collisions) {
    if (!occupants.some((id) => protectedIds.has(id))) continue;
    const blockerIds = occupants.filter((id) => !protectedIds.has(id));
    if (blockerIds.length === 0) continue;
    const cut = initial.get(occupants[0]);
    if (!cut) continue;

    for (const axis of EXPANSION_AXES) {
      const movingIds = [...initial]
        .filter(([id, position]) =>
          !protectedIds.has(id) && position.level === cut.level && axis.includes(position, cut)
        )
        .map(([id]) => id);
      if (!blockerIds.some((id) => movingIds.includes(id))) continue;
      if (movingIds.some((id) => residents.get(id)?.movable === false)) continue;

      const span = axis.dx === 0
        ? patchBounds.maxY - patchBounds.minY + 1
        : patchBounds.maxX - patchBounds.minX + 1;
      for (let distance = 1; distance <= span + 1; distance += 1) {
        const offset = { x: axis.dx * distance, y: axis.dy * distance, level: 0 };
        const trial = new Map(initial);
        for (const id of movingIds) {
          const position = trial.get(id);
          if (position) trial.set(id, add(position, offset));
        }

        const repaired = collisionGroups(trial).length === 0
          ? trial
          : moveCollisionBlocks(
            trial,
            protectedIds,
            current,
            residents,
            blocks,
            edges,
            centerId,
          );
        if (!repaired || collisionGroups(repaired).length > 0) continue;
        const key = positionMapKey(repaired);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(repaired);
      }
    }
  }
  return result;
}

function movableRegion(
  ids: ReadonlySet<string>,
  residents: ReadonlyMap<string, LayoutResident>,
): boolean {
  return [...ids].every((id) => residents.get(id)?.movable !== false);
}

function endpointRegions(
  positions: ReadonlyMap<string, GridPosition>,
  movingId: string,
  stationaryId: string,
  coherent: ReadonlyMap<string, Set<string>>,
): Set<string>[] {
  const moving = positions.get(movingId);
  const stationary = positions.get(stationaryId);
  if (!moving || !stationary) return [];

  const result: Set<string>[] = [];
  const seen = new Set<string>();
  const addRegion = (ids: Iterable<string>): void => {
    const region = new Set(ids);
    if (!region.has(movingId) || region.has(stationaryId)) return;
    const key = [...region].sort().join("|");
    if (seen.has(key)) return;
    seen.add(key);
    result.push(region);
  };

  addRegion(coherent.get(movingId) ?? [movingId]);
  if (moving.x !== stationary.x) {
    addRegion([...positions]
      .filter(([, position]) => position.level === moving.level &&
        (moving.x < stationary.x ? position.x <= moving.x : position.x >= moving.x))
      .map(([id]) => id));
  }
  if (moving.y !== stationary.y) {
    addRegion([...positions]
      .filter(([, position]) => position.level === moving.level &&
        (moving.y < stationary.y ? position.y <= moving.y : position.y >= moving.y))
      .map(([id]) => id));
  }
  return result;
}

function shiftedRegionRepairs(
  base: Candidate,
  region: ReadonlySet<string>,
  offset: Origin,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  liveBlocks: ReadonlyMap<string, Set<string>>,
  edges: readonly LayoutEdge[],
  centerId: string | undefined,
): Candidate[] {
  if (!movableRegion(region, residents)) return [];
  // Keep the player's current anchor stable while elastic regions around it
  // are tried. Golden/reflow candidates may still move it when truly needed.
  if (centerId && region.has(centerId)) return [];
  if (offset.x === 0 && offset.y === 0 && offset.level === 0) return [];

  const shifted = new Map(base.positions);
  for (const id of region) {
    const position = shifted.get(id);
    if (position) shifted.set(id, add(position, offset));
  }

  const maps: Map<string, GridPosition>[] = [];
  if (collisionGroups(shifted).length === 0) {
    maps.push(shifted);
  } else {
    const repaired = moveCollisionBlocks(
      shifted,
      region,
      current,
      residents,
      liveBlocks,
      edges,
      centerId,
    );
    if (repaired) maps.push(repaired);
  }

  const seen = new Set<string>();
  return maps
    .filter((positions) => collisionGroups(positions).length === 0)
    .filter((positions) => {
      const key = positionMapKey(positions);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((positions) => candidate(positions, current, edges));
}

/** Try rigid-block and whole-side translations which make a bad cardinal edge exact. */
function edgeRepairCandidates(
  base: Candidate,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  edges: readonly LayoutEdge[],
  nodes: ReadonlyMap<string, LayoutNode>,
  centerId: string | undefined,
): Candidate[] {
  const liveBlocks = coherentBlocks(base.positions, edges);
  const result: Candidate[] = [];
  const seen = new Set<string>();
  const seenConstraints = new Set<string>();
  const badEdges = edges.flatMap((edge) => {
    const expected = CARDINAL_VECTORS[edge.direction];
    const from = base.positions.get(edge.from);
    const to = base.positions.get(edge.to);
    if (!expected || !from || !to || samePosition(subtract(to, from), expected)) return [];
    const forward = edge.from.localeCompare(edge.to) <= 0;
    const normalized = forward
      ? expected
      : { x: -expected.x, y: -expected.y, level: -expected.level };
    const key = forward
      ? `${edge.from}|${edge.to}|${offsetKey(normalized)}`
      : `${edge.to}|${edge.from}|${offsetKey(normalized)}`;
    if (seenConstraints.has(key)) return [];
    seenConstraints.add(key);
    const visible = Number(nodes.has(edge.from)) + Number(nodes.has(edge.to));
    const priority = (edge.from === centerId || edge.to === centerId ? 4 : 0) + visible;
    const distance = manhattan(from, to);
    return [{ edge, expected, from, to, priority, distance }];
  }).sort((a, b) => b.priority - a.priority || b.distance - a.distance).slice(0, 48);

  for (const { edge, expected, from, to } of badEdges) {

    const targetOffset = subtract(add(from, expected), to);
    const sourceGoal = {
      x: to.x - expected.x,
      y: to.y - expected.y,
      level: to.level - expected.level,
    };
    const sourceOffset = subtract(sourceGoal, from);
    const attempts: [string, string, Origin][] = [
      [edge.to, edge.from, targetOffset],
      [edge.from, edge.to, sourceOffset],
    ];
    for (const [movingId, stationaryId, offset] of attempts) {
      for (const region of endpointRegions(base.positions, movingId, stationaryId, liveBlocks)) {
        for (const repaired of shiftedRegionRepairs(
          base,
          region,
          offset,
          current,
          residents,
          liveBlocks,
          edges,
          centerId,
        )) {
          const key = positionMapKey(repaired.positions);
          if (seen.has(key)) continue;
          seen.add(key);
          result.push(repaired);
        }
      }
    }
  }
  return result;
}

function greedyCardinalRepair(
  seed: Candidate,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  edges: readonly LayoutEdge[],
  nodes: ReadonlyMap<string, LayoutNode>,
  centerId: string | undefined,
  trace: IntegralLayoutRequest["trace"],
): Candidate | undefined {
  let best = seed;
  let changed = false;
  const limit = Math.min(8, Math.max(1, edges.length));
  for (let iteration = 0; iteration < limit; iteration += 1) {
    let next = best;
    for (const repaired of edgeRepairCandidates(
      best,
      current,
      residents,
      edges,
      nodes,
      centerId,
    )) {
      if (compareCandidates(repaired, next) > 0) next = repaired;
    }
    if (next === best) break;
    trace?.({
      type: "improvement",
      stage: "greedy-cardinal-repair",
      iteration,
      before: traceCandidate(best),
      after: traceCandidate(next),
    });
    best = next;
    changed = true;
  }
  return changed ? best : undefined;
}

function exactNewCandidates(
  initial: Map<string, GridPosition>,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  blocks: ReadonlyMap<string, Set<string>>,
  edges: readonly LayoutEdge[],
  nodes: ReadonlyMap<string, LayoutNode>,
  centerId: string | undefined,
): Candidate[] {
  const positions = new Map(initial);
  const newIds = new Set([...nodes.keys()].filter((id) => !current.has(id)));
  for (const component of connectionFirstComponents(newIds, positions, edges)) {
    const origins = anchorOrigins(new Set(component), positions, nodes, edges, centerId);
    const origin = origins[0] ?? packedOrigin(component, positions, nodes);
    for (const [id, position] of componentPositions(component, nodes, origin)) positions.set(id, position);
  }
  const protectedIds = new Set(newIds);
  if (centerId) protectedIds.add(centerId);
  const result = safePushRepairs(
    positions,
    protectedIds,
    residents,
    edges,
  ).map((pushed) => candidate(pushed, current, edges));
  result.push(...expansionRepairs(
    positions,
    protectedIds,
    current,
    residents,
    blocks,
    edges,
    centerId,
  ).map((expanded) => candidate(expanded, current, edges)));
  const repaired = moveCollisionBlocks(
    positions,
    protectedIds,
    current,
    residents,
    blocks,
    edges,
    centerId,
  );
  if (repaired) result.push(candidate(repaired, current, edges));
  return result;
}

function reflowCandidates(
  initial: Map<string, GridPosition>,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  blocks: ReadonlyMap<string, Set<string>>,
  edges: readonly LayoutEdge[],
  nodes: ReadonlyMap<string, LayoutNode>,
  centerId: string | undefined,
): Candidate[] {
  const nodeIds = new Set(nodes.keys());
  const origins = knownOrigins(initial, nodes, centerId);
  if (origins.length === 0) origins.push(packedOrigin([...nodeIds], initial, nodes));

  const result: Candidate[] = [];
  for (const origin of origins) {
    const positions = new Map(initial);
    const patch = componentPositions([...nodeIds], nodes, origin);
    if (collisionGroups(patch).length > 0) continue;
    for (const [id, position] of patch) positions.set(id, position);
    for (const pushed of safePushRepairs(positions, nodeIds, residents, edges)) {
      result.push(candidate(pushed, current, edges));
    }
    for (const expanded of expansionRepairs(
      positions,
      nodeIds,
      current,
      residents,
      blocks,
      edges,
      centerId,
    )) {
      result.push(candidate(expanded, current, edges));
    }
    const repaired = moveCollisionBlocks(
      positions,
      nodeIds,
      current,
      residents,
      blocks,
      edges,
      centerId,
    );
    if (repaired) result.push(candidate(repaired, current, edges));
  }
  return result;
}

interface GoldenComponent {
  ids: string[];
  relative: Map<string, GridPosition>;
  hasFixedRoom: boolean;
}

/**
 * Solve every cardinal edge as an exact difference constraint. A solution is
 * "golden": its connected shapes are fixed up to integral translation, so
 * disconnected shapes can be packed without weakening any cardinal exit.
 */
function goldenCandidate(
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  edges: readonly LayoutEdge[],
  nodes: ReadonlyMap<string, LayoutNode>,
  centerId: string | undefined,
): Candidate | undefined {
  const ids = new Set([...current.keys(), ...nodes.keys()]);
  const adjacency = new Map<string, { to: string; delta: GridPosition }[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const edge of edges) {
    const delta = CARDINAL_VECTORS[edge.direction];
    if (!delta || !ids.has(edge.from) || !ids.has(edge.to)) continue;
    adjacency.get(edge.from)?.push({ to: edge.to, delta });
    adjacency.get(edge.to)?.push({
      to: edge.from,
      delta: { x: -delta.x, y: -delta.y, level: -delta.level },
    });
  }

  const visited = new Set<string>();
  const components: GoldenComponent[] = [];
  for (const root of [...ids].sort()) {
    if (visited.has(root)) continue;
    const relative = new Map<string, GridPosition>([[root, { x: 0, y: 0, level: 0 }]]);
    const queue = [root];
    visited.add(root);
    while (queue.length > 0) {
      const from = queue.shift() as string;
      const fromPosition = relative.get(from) as GridPosition;
      for (const constraint of adjacency.get(from) ?? []) {
        const expected = add(fromPosition, constraint.delta);
        const known = relative.get(constraint.to);
        if (known) {
          if (!samePosition(known, expected)) return undefined;
          continue;
        }
        relative.set(constraint.to, expected);
        visited.add(constraint.to);
        queue.push(constraint.to);
      }
    }

    if (new Set([...relative.values()].map(cellKey)).size !== relative.size) return undefined;
    const componentIds = [...relative.keys()].sort();
    components.push({
      ids: componentIds,
      relative,
      hasFixedRoom: componentIds.some((id) => residents.get(id)?.movable === false),
    });
  }

  components.sort((a, b) => {
    if (a.hasFixedRoom !== b.hasFixedRoom) return a.hasFixedRoom ? -1 : 1;
    if (centerId) {
      if (a.ids.includes(centerId) !== b.ids.includes(centerId)) return a.ids.includes(centerId) ? -1 : 1;
    }
    return b.ids.length - a.ids.length || a.ids[0].localeCompare(b.ids[0]);
  });

  const placed = new Map<string, GridPosition>();
  for (const component of components) {
    const fixedOrigins = component.ids
      .filter((id) => residents.get(id)?.movable === false && current.has(id))
      .map((id) => subtract(current.get(id) as GridPosition, component.relative.get(id) as GridPosition));
    if (fixedOrigins.length > 1) {
      const first = offsetKey(fixedOrigins[0]);
      if (fixedOrigins.some((origin) => offsetKey(origin) !== first)) return undefined;
    }

    let origins = fixedOrigins.length > 0
      ? [fixedOrigins[0]]
      : component.ids
        .filter((id) => current.has(id))
        .sort((a, b) => {
          if (a === centerId) return -1;
          if (b === centerId) return 1;
          return a.localeCompare(b);
        })
        .slice(0, 8)
        .map((id) => subtract(current.get(id) as GridPosition, component.relative.get(id) as GridPosition));
    origins = uniqueOffsets(origins);

    if (origins.length === 0) {
      const relativeBounds = bounds(component.relative.values());
      const placedBounds = bounds(placed.values());
      origins = [{
        x: relativeBounds && placedBounds ? placedBounds.maxX + ISLAND_GAP - relativeBounds.minX : 0,
        y: relativeBounds && placedBounds ? placedBounds.minY - relativeBounds.minY : 0,
        level: 0,
      }];
    }

    let best: Candidate | undefined;
    for (const origin of origins) {
      const base = new Map(component.ids.map((id) => [
        id,
        add(component.relative.get(id) as GridPosition, origin),
      ]));
      const offsets = fixedOrigins.length > 0
        ? [{ x: 0, y: 0, level: 0 }]
        : uniqueOffsets([
          ...NEARBY_OFFSETS,
          ...farOffsets(base.values(), placed.values()),
        ]);
      for (const offset of offsets) {
        const placement = new Map([...base].map(([id, position]) => [id, add(position, offset)]));
        if (!fits(placement, placed)) continue;
        const trial = new Map(placed);
        for (const [id, position] of placement) trial.set(id, position);
        const evaluated = candidate(trial, current, edges);
        if (!best || compareCandidates(evaluated, best) > 0) best = evaluated;
      }
    }
    if (!best) return undefined;
    for (const id of component.ids) {
      const position = best.positions.get(id);
      if (position) placed.set(id, position);
    }
  }

  const result = candidate(placed, current, edges);
  return result.quality.cardinalRayViolations === 0 && result.quality.cardinalSlack === 0
    ? result
    : undefined;
}

interface PhysicalLink {
  key: string;
  a: string;
  b: string;
  edges: LayoutEdge[];
}

function physicalLinks(
  positions: ReadonlyMap<string, GridPosition>,
  edges: readonly LayoutEdge[],
): PhysicalLink[] {
  return topologyIndex(edges).physical
    .filter((link) => positions.has(link.a) && positions.has(link.b))
    .map((link) => ({
      key: `${link.a}|${link.b}`,
      a: link.a,
      b: link.b,
      edges: link.edges,
    }));
}

interface LinkNeighbor {
  id: string;
  link: PhysicalLink;
}

function linkAdjacency(
  positions: ReadonlyMap<string, GridPosition>,
  links: readonly PhysicalLink[],
): Map<string, LinkNeighbor[]> {
  const result = new Map<string, LinkNeighbor[]>([...positions.keys()].map((id) => [id, []]));
  for (const link of links) {
    result.get(link.a)?.push({ id: link.b, link });
    result.get(link.b)?.push({ id: link.a, link });
  }
  for (const neighbors of result.values()) {
    neighbors.sort((a, b) => a.link.key.localeCompare(b.link.key));
  }
  return result;
}

/** Find the unique physical links whose removal disconnects their endpoints. */
function bridgeLinks(
  positions: ReadonlyMap<string, GridPosition>,
  edges: readonly LayoutEdge[],
): { links: PhysicalLink[]; adjacency: Map<string, LinkNeighbor[]> } {
  const links = physicalLinks(positions, edges);
  const adjacency = linkAdjacency(positions, links);
  const entered = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges: PhysicalLink[] = [];
  let clock = 0;

  const visit = (id: string, parentLink: string | undefined): void => {
    clock += 1;
    entered.set(id, clock);
    low.set(id, clock);
    for (const neighbor of adjacency.get(id) ?? []) {
      if (neighbor.link.key === parentLink) continue;
      const known = entered.get(neighbor.id);
      if (known !== undefined) {
        low.set(id, Math.min(low.get(id) as number, known));
        continue;
      }
      visit(neighbor.id, neighbor.link.key);
      low.set(id, Math.min(low.get(id) as number, low.get(neighbor.id) as number));
      if ((low.get(neighbor.id) as number) > (entered.get(id) as number)) {
        bridges.push(neighbor.link);
      }
    }
  };

  for (const id of [...positions.keys()].sort()) {
    if (!entered.has(id)) visit(id, undefined);
  }
  bridges.sort((a, b) => a.key.localeCompare(b.key));
  return { links: bridges, adjacency };
}

function bridgeSide(
  start: string,
  blockedLink: string,
  adjacency: ReadonlyMap<string, readonly LinkNeighbor[]>,
): Set<string> {
  const result = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const neighbor of adjacency.get(id) ?? []) {
      if (neighbor.link.key === blockedLink || result.has(neighbor.id)) continue;
      result.add(neighbor.id);
      queue.push(neighbor.id);
    }
  }
  return result;
}

interface BridgeSlide {
  candidate: Candidate;
  edge: LayoutEdge;
  movingEndpoint: string;
  offset: GridPosition;
  moved: string[];
}

/**
 * Slide a lobe toward the other endpoint of its sole physical connection.
 * Internal lobe geometry cannot change because every room on that side moves
 * together. The first collision stops the slide so geometry is never moved
 * through an unrelated room merely to find a free cell farther away.
 */
function bridgeSlideCandidates(
  base: Candidate,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  edges: readonly LayoutEdge[],
  bridgeGraph: ReturnType<typeof bridgeLinks>,
): BridgeSlide[] {
  const { links, adjacency } = bridgeGraph;
  const result: BridgeSlide[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    const a = base.positions.get(link.a);
    const b = base.positions.get(link.b);
    if (!a || !b || a.level !== b.level) continue;
    const delta = subtract(b, a);
    if ((delta.x === 0) === (delta.y === 0)) continue;
    const representative = link.edges.find((edge) => {
      const from = base.positions.get(edge.from);
      const to = base.positions.get(edge.to);
      return from && to && cardinalRayDistance(edge.direction, subtract(to, from)) !== undefined;
    });
    if (!representative) continue;
    const length = Math.abs(delta.x) + Math.abs(delta.y);
    if (length <= 1) continue;

    const attempts = [
      { movingEndpoint: link.a, stationaryEndpoint: link.b },
      { movingEndpoint: link.b, stationaryEndpoint: link.a },
    ];
    for (const attempt of attempts) {
      const moving = bridgeSide(attempt.movingEndpoint, link.key, adjacency);
      if (!movableRegion(moving, residents)) continue;
      const movingPosition = base.positions.get(attempt.movingEndpoint) as GridPosition;
      const stationaryPosition = base.positions.get(attempt.stationaryEndpoint) as GridPosition;
      const unit = {
        x: Math.sign(stationaryPosition.x - movingPosition.x),
        y: Math.sign(stationaryPosition.y - movingPosition.y),
        level: 0,
      };
      let bestForSide: BridgeSlide | undefined;
      for (let distance = 1; distance < length; distance += 1) {
        const offset = {
          x: unit.x * distance,
          y: unit.y * distance,
          level: 0,
        };
        const trial = new Map(base.positions);
        for (const id of moving) {
          const position = trial.get(id);
          if (position) trial.set(id, add(position, offset));
        }
        if (collisionGroups(trial).length > 0) break;
        const evaluated = candidate(trial, current, edges);
        const slide = {
          candidate: evaluated,
          edge: representative,
          movingEndpoint: attempt.movingEndpoint,
          offset,
          moved: [...moving].sort(),
        } satisfies BridgeSlide;
        if (!bestForSide || compareCandidates(evaluated, bestForSide.candidate) > 0) {
          bestForSide = slide;
        }
      }
      if (!bestForSide) continue;
      const key = positionMapKey(bestForSide.candidate.positions);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(bestForSide);
    }
  }
  return result;
}

function bridgeLobeVacuum(
  seed: Candidate,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  edges: readonly LayoutEdge[],
  trace: IntegralLayoutRequest["trace"],
): Candidate {
  let best = seed;
  const bridgeGraph = bridgeLinks(seed.positions, edges);
  const iterationLimit = Math.max(1, best.positions.size * 2);
  for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
    const slides = bridgeSlideCandidates(best, current, residents, edges, bridgeGraph)
      .sort((a, b) => compareCandidates(b.candidate, a.candidate));
    const accepted = slides[0];
    if (!accepted || compareCandidates(accepted.candidate, best) <= 0) break;
    trace?.({
      type: "bridge-vacuum",
      stage: "bridge-vacuum",
      iteration,
      edge: { ...accepted.edge },
      movingEndpoint: accepted.movingEndpoint,
      offset: { ...accepted.offset },
      moved: accepted.moved,
      before: traceCandidate(best),
      after: traceCandidate(accepted.candidate),
    });
    best = accepted.candidate;
  }
  return best;
}

/**
 * Remove globally empty rows and columns without changing the ordering of any
 * occupied rows or columns. Each gap can be closed from either side; locked
 * residents simply make that side unavailable. Closing a whole gap at once is
 * equivalent to repeated one-cell half-plane shifts, but avoids making large
 * sparse maps expensive to compact.
 */
function vacuumLayout(
  seed: Candidate,
  current: ReadonlyMap<string, GridPosition>,
  residents: ReadonlyMap<string, LayoutResident>,
  edges: readonly LayoutEdge[],
  trace: IntegralLayoutRequest["trace"],
): Candidate {
  let best = seed;
  const iterationLimit = Math.max(1, best.positions.size * 2);

  for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
    let next = best;
    let accepted: {
      axis: "x" | "y";
      lower: number;
      upper: number;
      distance: number;
      moved: string[];
    } | undefined;
    for (const axis of ["x", "y"] as const) {
      const coordinates = [...new Set([...best.positions.values()].map((position) => position[axis]))]
        .sort((a, b) => a - b);
      for (let index = 0; index + 1 < coordinates.length; index += 1) {
        const lower = coordinates[index];
        const upper = coordinates[index + 1];
        const gap = upper - lower - 1;
        if (gap <= 0) continue;

        const attempts: readonly [
          (position: GridPosition) => boolean,
          number,
        ][] = [
          [(position) => position[axis] <= lower, gap],
          [(position) => position[axis] >= upper, -gap],
        ];
        for (const [includes, distance] of attempts) {
          const moving = new Set([...best.positions]
            .filter(([, position]) => includes(position))
            .map(([id]) => id));
          if (moving.size === 0 || !movableRegion(moving, residents)) continue;

          const trial = new Map(best.positions);
          for (const id of moving) {
            const position = trial.get(id);
            if (!position) continue;
            trial.set(id, {
              ...position,
              [axis]: position[axis] + distance,
            });
          }
          if (collisionGroups(trial).length > 0) continue;
          const evaluated = candidate(trial, current, edges);
          if (compareCandidates(evaluated, next) > 0) {
            next = evaluated;
            accepted = {
              axis,
              lower,
              upper,
              distance,
              moved: [...moving].sort(),
            };
          }
        }
      }
    }
    if (next === best) break;
    if (accepted) {
      trace?.({
        type: "vacuum",
        stage: "vacuum",
        iteration,
        ...accepted,
        before: traceCandidate(best),
        after: traceCandidate(next),
      });
    }
    best = next;
  }
  return best;
}

/**
 * Embed a player-relative NukeFire chart in an integral grid.
 *
 * Candidate layouts are compared lexicographically: cardinal exits stay on
 * their proper rays first, then links avoid rooms and each other, and only
 * then do link slack and footprint matter. It may insert whole rows/columns or
 * translate coherent regions; movement count is only the final tie-breaker.
 */
export function planIntegralLayout(request: IntegralLayoutRequest): IntegralLayoutPlan {
  const nodes = new Map(request.nodes.map((node) => [node.id, {
    ...node,
    relative: integral(node.relative),
  }]));
  const residents = new Map(request.residents.map((resident) => [resident.id, {
    ...resident,
    position: integral(resident.position),
  }]));
  const current = new Map([...residents].map(([id, resident]) => [id, resident.position]));
  const blocks = coherentBlocks(current, request.edges);
  const initial = new Map(current);

  const stable = bestStablePlacement(
    initial,
    current,
    request.edges,
    nodes,
    request.centerId,
  );
  traceCandidateBatch(request.trace, "stable", [stable]);
  const alternatives: Candidate[] = [];
  let golden: Candidate | undefined;
  let exactNew: Candidate[] = [];
  let chartReflow: Candidate[] = [];
  if (request.allowExistingMoves !== false) {
    golden = goldenCandidate(
      current,
      residents,
      request.edges,
      nodes,
      request.centerId,
    );
    if (golden) alternatives.push(golden);
    exactNew = exactNewCandidates(
      initial,
      current,
      residents,
      blocks,
      request.edges,
      nodes,
      request.centerId,
    );
    alternatives.push(...exactNew);
    chartReflow = reflowCandidates(
      initial,
      current,
      residents,
      blocks,
      request.edges,
      nodes,
      request.centerId,
    );
    alternatives.push(...chartReflow);
  }
  traceCandidateBatch(request.trace, "golden", [golden]);
  traceCandidateBatch(request.trace, "exact-new", exactNew);
  traceCandidateBatch(request.trace, "chart-reflow", chartReflow);

  const collisionFree = [stable, ...alternatives]
    .filter((value): value is Candidate => value !== undefined && value.collisions === 0);
  traceCandidateBatch(request.trace, "all-candidates", [stable, ...alternatives]);
  if (collisionFree.length === 0) {
    throw new Error("could not produce a collision-free integral layout");
  }
  collisionFree.sort((a, b) => compareCandidates(b, a));
  request.trace?.({
    type: "selection",
    stage: "initial-selection",
    selected: traceCandidate(collisionFree[0]),
  });
  if (request.allowExistingMoves !== false) {
    const repaired = greedyCardinalRepair(
      collisionFree[0],
      current,
      residents,
      request.edges,
      nodes,
      request.centerId,
      request.trace,
    );
    if (repaired) {
      collisionFree.push(repaired);
      collisionFree.sort((a, b) => compareCandidates(b, a));
    }
    const unobstructed = greedyObstructionRepair(
      collisionFree[0],
      current,
      residents,
      request.edges,
      request.trace,
    );
    if (unobstructed) {
      collisionFree.push(unobstructed);
      collisionFree.sort((a, b) => compareCandidates(b, a));
    }
  }
  const lobeCompacted = request.allowExistingMoves === false
    ? collisionFree[0]
    : bridgeLobeVacuum(
      collisionFree[0],
      current,
      residents,
      request.edges,
      request.trace,
    );
  const selected = request.allowExistingMoves === false
    ? lobeCompacted
    : vacuumLayout(
      lobeCompacted,
      current,
      residents,
      request.edges,
      request.trace,
    );
  request.trace?.({
    type: "selection",
    stage: "final-selection",
    selected: traceCandidate(selected),
  });
  return {
    positions: selected.positions,
    movedExisting: selected.movedExisting,
    quality: selected.quality,
  };
}
