import assert from "node:assert/strict";
import test from "node:test";
import type { GridPosition } from "./layout.ts";
import {
  isLinkCalloutColor,
  linkCalloutColor,
  planLinkRoutes,
  type PlannedLinkRoute,
  type RouteLink,
  type RoutePoint,
} from "./link-routes.ts";

const at = (x: number, y: number, level = 0): GridPosition => ({ x, y, level });

function rooms(entries: Record<string, [number, number]>): Map<string, GridPosition> {
  return new Map(Object.entries(entries).map(([id, [x, y]]) => [id, at(x, y)]));
}

function link(id: string, from: string, fromSide: RouteLink["fromSide"], to: string, toSide: RouteLink["toSide"], extra: Partial<RouteLink> = {}): RouteLink {
  return { id, from, to, fromSide, toSide, routable: true, ...extra };
}

function planned(routes: readonly PlannedLinkRoute[], id: string): PlannedLinkRoute {
  const found = routes.find((route) => route.id === id);
  assert.ok(found, `no plan for ${id}`);
  return found;
}

/** The drawn polyline, port to port, as Smudgy draws a routed connection. */
function drawn(positions: Map<string, GridPosition>, value: RouteLink, route: PlannedLinkRoute): RoutePoint[] {
  const port = (room: GridPosition, side: RouteLink["fromSide"], offset: number): RoutePoint => {
    const along = (offset - 0.5) * 0.5;
    return side === "North" ? { x: room.x + along, y: room.y - 0.25 }
      : side === "South" ? { x: room.x + along, y: room.y + 0.25 }
      : side === "East" ? { x: room.x + 0.25, y: room.y + along }
      : { x: room.x - 0.25, y: room.y + along };
  };
  const tip = (point: RoutePoint, side: RouteLink["fromSide"]): RoutePoint => side === "North"
    ? { x: point.x, y: point.y - 0.15 } : side === "South" ? { x: point.x, y: point.y + 0.15 }
    : side === "East" ? { x: point.x + 0.15, y: point.y } : { x: point.x - 0.15, y: point.y };
  const a = port(positions.get(value.from)!, value.fromSide, route.fromPort);
  const b = port(positions.get(value.to)!, value.toSide, route.toPort);
  return [a, tip(a, value.fromSide), ...route.points, tip(b, value.toSide), b];
}

function assertOrthogonal(line: readonly RoutePoint[]): void {
  for (let index = 1; index < line.length; index += 1) {
    const [a, b] = [line[index - 1], line[index]];
    assert.ok(Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9,
      `segment ${JSON.stringify(a)} -> ${JSON.stringify(b)} is not orthogonal`);
  }
}

function crossesRoom(line: readonly RoutePoint[], room: GridPosition): boolean {
  return line.some((a, index) => {
    const b = line[index + 1];
    if (!b) return false;
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    return maxX >= room.x - 0.25 && minX <= room.x + 0.25 && maxY >= room.y - 0.25 && minY <= room.y + 0.25;
  });
}

test("a link whose wall faces away from its room is routed out of both walls", () => {
  const positions = rooms({ a: [0, 0], b: [0, 2] });
  // a's East exit leads to b, which sits south of it and takes the link on its West wall.
  const value = link("ab", "a", "East", "b", "West");
  const route = planned(planLinkRoutes(positions, [value]), "ab");
  assert.ok(route.points.length > 0);
  const line = drawn(positions, value, route);
  assertOrthogonal(line);
  assert.ok(route.points[0].x > 0.25 && route.points[0].y === 0, "the route leaves a's East wall");
  assert.ok(route.points.at(-1)!.x < -0.25 && route.points.at(-1)!.y === 2, "the route enters b's West wall");
  assert.equal(crossesRoom(line.slice(2, -2), positions.get("a")!), false);
  assert.equal(crossesRoom(line.slice(2, -2), positions.get("b")!), false);
  assert.equal(route.callout, undefined);
});

test("a link drawn across a room goes around it", () => {
  const positions = rooms({ a: [0, 0], middle: [1, 0], b: [2, 0] });
  const value = link("ab", "a", "East", "b", "West");
  const line = drawn(positions, value, planned(planLinkRoutes(positions, [value]), "ab"));
  assertOrthogonal(line);
  assert.equal(crossesRoom(line, positions.get("middle")!), false);
});

test("a route turns as few times as it can, counting the turn into the far wall", () => {
  const positions = rooms({ a: [0, 0], b: [2, 2] });
  const value = link("ab", "a", "East", "b", "North");
  const route = planned(planLinkRoutes(positions, [value]), "ab");
  assert.deepEqual(route.points, [{ x: 2, y: 0 }], "east along a's row, then down into b's North wall");
});

test("a straight link that meets nothing stays straight on centered ports", () => {
  const positions = rooms({ a: [0, 0], b: [3, 0] });
  const route = planned(planLinkRoutes(positions, [link("ab", "a", "East", "b", "West", { fromPort: 0.7 })]), "ab");
  assert.deepEqual(route, { id: "ab", points: [], fromPort: 0.5, toPort: 0.5 });
});

test("only routable links are planned, and the others are avoided as they are drawn", () => {
  const positions = rooms({ a: [0, 0], b: [2, 2], c: [1, -1], d: [1, 3] });
  // c to d is drawn straight down through the cells a bent a-b link would cut across.
  const fixed = link("cd", "c", "South", "d", "North", { routable: false });
  const routes = planLinkRoutes(positions, [link("ab", "a", "East", "b", "North"), fixed]);
  assert.deepEqual(routes.map((route) => route.id), ["ab"]);
  const line = drawn(positions, link("ab", "a", "East", "b", "North"), planned(routes, "ab"));
  assertOrthogonal(line);
  // a's East wall leads right and b is entered from above: the route crosses x = 1 once.
  const crossings = line.filter((point, index) => {
    const next = line[index + 1];
    return next && (point.x - 1) * (next.x - 1) < 0;
  });
  assert.equal(crossings.length, 1);
});

test("a route sharing a wall with a straight link takes the side it turns toward", () => {
  const positions = rooms({ a: [0, 2], up: [0, 0], east: [3, 1] });
  const straight = link("a-up", "a", "North", "up", "South");
  const bent = link("a-east", "a", "North", "east", "West");
  const routes = planLinkRoutes(positions, [straight, bent]);
  assert.deepEqual(planned(routes, "a-up").points, []);
  const route = planned(routes, "a-east");
  assert.ok(route.fromPort > 0.5, `the route leaves on the east of a's North wall, not at ${route.fromPort}`);
  const line = drawn(positions, bent, route);
  assertOrthogonal(line);
  assert.ok(line.every((point) => point.x >= -1e-9), "the route never crosses the straight link at x = 0");
});

test("a route from a fixed port keeps the port and starts in line with it", () => {
  const positions = rooms({ a: [0, 0], b: [0, 2] });
  const value = link("ab", "a", "East", "b", "West", { fromPort: 0.8, fromPortFixed: true });
  const route = planned(planLinkRoutes(positions, [value]), "ab");
  assert.equal(route.fromPort, 0.8);
  assertOrthogonal(drawn(positions, value, route));
});

test("arrivals sharing one wall each get a port of their own while the wall has room", () => {
  const positions = rooms({ t: [0, 0], s1: [-3, 3], s2: [-1, 3], s3: [1, 3], s4: [3, 3] });
  const links = ["s1", "s2", "s3", "s4"].map((source) => link(source, source, "North", "t", "South"));
  const routes = planLinkRoutes(positions, links);
  assert.ok(routes.every((route) => route.points.length > 0 && route.callout === undefined));
  const ports = routes.map((route) => route.toPort).sort((a, b) => a - b);
  for (let index = 1; index < ports.length; index += 1) {
    assert.ok(ports[index] - ports[index - 1] >= 0.14 - 1e-9, `ports ${ports} sit too close together`);
  }
  for (const value of links) assertOrthogonal(drawn(positions, value, planned(routes, value.id)));
});

test("arrivals beside a straight link spread their ports across the wall, each on its own side", () => {
  const positions = rooms({ t: [0, 0], w: [-2, 0], nw: [-2, -2], sw: [-2, 2] });
  const routes = planLinkRoutes(positions, [
    link("straight", "w", "East", "t", "West"),
    link("from-nw", "nw", "East", "t", "West"),
    link("from-sw", "sw", "East", "t", "West"),
  ]);
  assert.deepEqual(planned(routes, "straight").points, []);
  assert.equal(planned(routes, "straight").toPort, 0.5);
  assert.equal(planned(routes, "from-nw").toPort, 0.2, "the arrival from the north takes the wall's northern end");
  assert.equal(planned(routes, "from-sw").toPort, 0.8, "the arrival from the south takes the wall's southern end");
});

test("links crowding one wall beyond its lanes are called out", () => {
  const sources = ["s1", "s2", "s3", "s4", "s5", "s6"];
  const positions = rooms({ t: [0, 0], ...Object.fromEntries(sources.map((id, index) => [id, [index * 2 - 5, 3]])) });
  const links = sources.map((source) => link(source, source, "North", "t", "South"));
  const routes = planLinkRoutes(positions, links);
  assert.ok(routes.every((route) => route.points.length > 0));
  const places = routes.flatMap((route) => route.callout === undefined ? [] : [route.callout]);
  assert.ok(places.length > 0, "six arrivals cannot each have a lane on one wall");
  assert.equal(new Set(places).size, places.length, "each called-out link has a place of its own");
  for (const value of links) assertOrthogonal(drawn(positions, value, planned(routes, value.id)));
});

test("plans do not depend on the order links arrive in", () => {
  const positions = rooms({ a: [0, 2], up: [0, 0], east: [3, 1], b: [0, 4] });
  const links = [
    link("a-up", "a", "North", "up", "South"),
    link("a-east", "a", "North", "east", "West"),
    link("a-b", "a", "East", "b", "East"),
  ];
  assert.deepEqual(planLinkRoutes(positions, links), planLinkRoutes(positions, [...links].reverse()));
});

test("links between levels, to missing rooms or to themselves are left alone", () => {
  const positions = new Map([["a", at(0, 0)], ["b", at(0, 2, 1)]]);
  assert.deepEqual(planLinkRoutes(positions, [
    link("levels", "a", "East", "b", "West"),
    link("missing", "a", "East", "nowhere", "West"),
    link("self", "a", "East", "a", "West"),
  ]), []);
});

test("callout colors are the map's own sequence, each place a color apart", () => {
  const colors = Array.from({ length: 6 }, (_, place) => linkCalloutColor("map-a", place));
  assert.equal(new Set(colors).size, colors.length);
  assert.ok(colors.every((color) => /^#[0-9A-F]{6}$/.test(color)));
  assert.equal(linkCalloutColor("map-a", 2), colors[2], "the same map and place give the same color");
  assert.notEqual(linkCalloutColor("map-b", 0), colors[0], "another map starts elsewhere in the hue circle");
  assert.ok(isLinkCalloutColor("map-a", colors[4].toLowerCase()));
  assert.equal(isLinkCalloutColor("map-a", "#A4A4A4"), false);
});

test("a route never turns closer to its rooms than past their stubs", () => {
  const normal = { North: [0, -1], East: [1, 0], South: [0, 1], West: [-1, 0] } as const;
  const sources = ["s1", "s2", "s3", "s4", "s5"];
  const fixtures: [Map<string, GridPosition>, RouteLink[]][] = [
    [
      rooms({ t: [0, 0], ...Object.fromEntries(sources.map((id, index) => [id, [index * 2 - 4, 3]])) }),
      sources.map((source) => link(source, source, "North", "t", "South")),
    ],
    [
      rooms({ t: [0, 0], w: [-2, 0], nw: [-2, -2], sw: [-2, 2], n: [0, -3] }),
      [
        link("straight", "w", "East", "t", "West"),
        link("from-nw", "nw", "East", "t", "West"),
        link("from-sw", "sw", "East", "t", "West"),
        link("from-n", "n", "West", "t", "West"),
        link("around", "nw", "South", "sw", "North"),
      ],
    ],
  ];
  for (const [positions, links] of fixtures) {
    for (const route of planLinkRoutes(positions, links)) {
      if (route.points.length === 0) continue;
      const value = links.find((candidate) => candidate.id === route.id)!;
      const clearance = (room: GridPosition, side: RouteLink["fromSide"], point: RoutePoint): number =>
        (point.x - room.x) * normal[side][0] + (point.y - room.y) * normal[side][1];
      const first = clearance(positions.get(value.from)!, value.fromSide, route.points[0]);
      const last = clearance(positions.get(value.to)!, value.toSide, route.points.at(-1)!);
      assert.ok(first >= 0.5 - 1e-9, `${route.id} turns ${first} out of ${value.from}`);
      assert.ok(last >= 0.5 - 1e-9, `${route.id} turns ${last} out of ${value.to}`);
    }
  }
});
