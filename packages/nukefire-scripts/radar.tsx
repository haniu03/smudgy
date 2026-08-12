// =============================================================================
//  Radar pane — the server's live BIGMAP grid drawn on a Canvas
// =============================================================================
//  NukeFire.Map.Local delivers the rooms around you as grid offsets plus the
//  GPS overlay; this turns each payload into a canvas scene: terrain-colored
//  room cells, exit links (gold when they are on the active route, red-dashed
//  when a door is closed), up/down wedges, a pulsing ring on your room, and a
//  breathing diamond on the GPS destination. Scene updates flow through a
//  state binding, so movement repaints without a remount; only a change in
//  the grid's extent (a different view_box) rebuilds the widget. Stable shape
//  ids keep the pulse animations in phase across rebuilds.
//
//  The exit chips under the canvas are Buttons that walk you; they remount on
//  each Room.Info since the exit set changes shape.

import { createState, send, session } from "smudgy:core";
import {
  Button,
  Canvas,
  Column,
  Row,
  Space,
  Text,
  Tooltip,
  createWidget,
  type CanvasShape,
  type CanvasStroke,
} from "smudgy:widgets";
import {
  watchMessage,
  type NukeFireMapLocal,
  type NukeFireMapRoom,
  type RoomInfo,
} from "smudgy://kapusniak/nukefire-gmcp";
import { widgetTextSize } from "./config.ts";
import { UI, terrainColor } from "./theme.ts";

const PANE = "Radar";

const CELL = 26; // grid pitch in scene units
const RS = 16; // room square size

/** The current radar scene; consumable by other packages too. */
export const radarScene = createState<CanvasShape[]>("radarScene");

// Stub vectors for links whose target room is off-grid or on another plane.
const DIR_VECTORS: Record<string, [number, number]> = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
  northeast: [1, -1],
  northwest: [-1, -1],
  southeast: [1, 1],
  southwest: [-1, 1],
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
  ne: [1, -1],
  nw: [-1, -1],
  se: [1, 1],
  sw: [-1, 1],
};

function linkStroke(l: { route: boolean; closed: boolean; locked: boolean; bidirectional: boolean }): CanvasStroke {
  if (l.closed || l.locked) {
    return { color: l.locked ? "#a03535" : "#e05555", width: 2, dash: [3, 3] };
  }
  if (l.route) return { color: UI.gold, width: 2.5 };
  return { color: "#565a66", width: 1.4, ...(l.bidirectional ? {} : { dash: [5, 3] }) };
}

function buildRadar(m: Readonly<NukeFireMapLocal>): {
  scene: CanvasShape[];
  viewBox: [number, number, number, number];
} {
  const byVnum = new Map<number, NukeFireMapRoom>();
  for (const r of m.rooms) byVnum.set(r.vnum, r);

  const scene: CanvasShape[] = [];

  // Links first, so room cells paint over the line ends.
  for (const l of m.links) {
    const a = byVnum.get(l.from);
    if (!a || a.z !== 0) continue;
    const ax = a.x * CELL;
    const ay = a.y * CELL;
    const b = byVnum.get(l.to);
    const dir = l.direction.toLowerCase();

    if (dir === "up" || dir === "down" || (b && b.z !== 0)) {
      // A wedge beside the room: ▲ at the NE corner for up, ▼ at SE for down.
      const up = dir !== "down" && !(b && b.z < 0);
      const wx = ax + RS / 2 + 3;
      const wy = up ? ay - RS / 2 : ay + RS / 2;
      scene.push({
        kind: "polygon",
        points: up
          ? [[wx, wy + 5], [wx + 6, wy + 5], [wx + 3, wy]]
          : [[wx, wy - 5], [wx + 6, wy - 5], [wx + 3, wy]],
        fill: l.route ? UI.gold : "#9a9aac",
      });
      continue;
    }

    if (b) {
      scene.push({
        kind: "line",
        x1: ax,
        y1: ay,
        x2: b.x * CELL,
        y2: b.y * CELL,
        stroke: linkStroke(l),
      });
    } else {
      // Target clipped out of the grid: draw a short stub in its direction.
      const v = DIR_VECTORS[dir];
      if (v) {
        scene.push({
          kind: "line",
          x1: ax,
          y1: ay,
          x2: ax + v[0] * CELL * 0.55,
          y2: ay + v[1] * CELL * 0.55,
          stroke: linkStroke(l),
        });
      }
    }
  }

  // Room cells (current plane only).
  for (const r of m.rooms) {
    if (r.z !== 0) continue;
    const x = r.x * CELL;
    const y = r.y * CELL;
    scene.push({
      kind: "rect",
      x: x - RS / 2,
      y: y - RS / 2,
      width: RS,
      height: RS,
      rx: 3,
      fill: terrainColor(r.terrain),
      opacity: r.zone !== m.zone ? 0.45 : 1,
      stroke: r.current
        ? { color: "#ffffff", width: 2 }
        : r.route || r.destination
          ? { color: UI.gold, width: 1.5 }
          : { color: "rgba(255,255,255,0.15)", width: 1 },
    });

    if (r.destination) {
      scene.push({
        kind: "polygon",
        id: "radar-dest",
        points: [[x, y - 6], [x + 6, y], [x, y + 6], [x - 6, y]],
        fill: UI.gold,
        animate: {
          opacity: { from: 1, to: 0.35, duration: 900, ease: "in-out", repeat: "infinite" },
        },
      });
    }

    if (r.current) {
      scene.push({
        kind: "circle",
        id: "radar-here",
        cx: x,
        cy: y,
        r: 6,
        stroke: { color: UI.gold, width: 2 },
        animate: {
          r: { from: 6, to: 16, duration: 1500, repeat: "infinite" },
          opacity: { from: 0.9, to: 0, duration: 1500, repeat: "infinite" },
        },
      });
    }
  }

  const planeRooms = m.rooms.filter((r) => r.z === 0);
  if (planeRooms.length === 0) {
    return { scene, viewBox: [-100, -100, 200, 200] };
  }
  const xs = planeRooms.map((r) => r.x);
  const ys = planeRooms.map((r) => r.y);
  const minX = Math.min(...xs) * CELL - CELL;
  const minY = Math.min(...ys) * CELL - CELL;
  const w = (Math.max(...xs) - Math.min(...xs)) * CELL + 2 * CELL;
  const h = (Math.max(...ys) - Math.min(...ys)) * CELL + 2 * CELL;
  return { scene, viewBox: [minX, minY, w, h] };
}

let viewBox: [number, number, number, number] = [-100, -100, 200, 200];
let viewKey = "";
let lastRoom: Readonly<RoomInfo> | undefined;
let shown = false;

watchMessage("NukeFire.Map.Local", (m) => {
  if (!m) return;
  const built = buildRadar(m);
  radarScene.set(built.scene);
  const key = built.viewBox.join(",");
  if (key !== viewKey) {
    viewKey = key;
    viewBox = built.viewBox;
    if (shown) mount();
  }
});

watchMessage("Room.Info", (room) => {
  lastRoom = room;
  if (shown) mount(); // the exit chip row changes shape with every room
});

function exitChips(room: Readonly<RoomInfo> | undefined) {
  if (!room) return [<Text size={widgetTextSize(10)} color={UI.faint}>no room data yet</Text>];
  const chips = Object.entries(room.exits ?? {}).map(([dir, dest]) =>
    dest === "closed" ? (
      <Tooltip tip="closed door">
        <Button variant="subtle" onPress={() => send(`open ${dir}`)}>
          <Text size={widgetTextSize(10)} color={UI.warning}>{dir} 🚪</Text>
        </Button>
      </Tooltip>
    ) : (
      <Tooltip tip={`room #${dest}`}>
        <Button variant="subtle" onPress={() => send(dir)}>
          <Text size={widgetTextSize(10)} color={UI.text}>{dir}</Text>
        </Button>
      </Tooltip>
    ),
  );
  return chips.length > 0
    ? chips
    : [<Text size={widgetTextSize(10)} color={UI.faint}>no obvious exits</Text>];
}

function mount(): void {
  const room = lastRoom;
  createWidget(
    "nf-radar",
    <Column width="fill" height="fill" padding={6} spacing={5}>
      <Row spacing={8}>
        <Text size={widgetTextSize(12)} color={UI.header}>BIGMAP radar</Text>
        <Space width="fill" />
        <Text size={widgetTextSize(10)} color={UI.dim}>
          {room ? `#${room.num} · ${room.terrain}` : ""}
        </Text>
      </Row>
      <Canvas width="fill" height="fill" view_box={viewBox} fit="contain" scene={radarScene.bind()} />
      <Row spacing={4}>{exitChips(room)}</Row>
    </Column>,
    { pane: PANE },
  );
}

export function open(): void {
  const parent = session.panes.get("Map") ?? session.mainPane;
  parent.split("bottom", { name: PANE, height: 280, terminal: false });
  shown = true;
  mount();
}

export function close(): void {
  shown = false;
  session.panes.get(PANE)?.close();
}
