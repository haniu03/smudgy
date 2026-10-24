import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const mapLayout = new URL("../map-layout/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    const prefix = "smudgy:@map-layout/";
    return specifier.startsWith(prefix)
      ? { url: mapLayout + specifier.slice(prefix.length), shortCircuit: true }
      : next(specifier, context);
  },
});
const { DEFAULT_LINK_COLOR, isVerticalDirection, planLinkGeometry } = await import("./link-routing.ts");
const { LINK_CALLOUT_THICKNESS, linkCalloutColor } = await import("../map-layout/link-routes.ts");
type RoutingLink = import("./link-routing.ts").RoutingLink;
type LinkGeometry = import("./link-routing.ts").LinkGeometry;
type RouteSide = import("../map-layout/link-routes.ts").RouteSide;

const MAP = "map-1";

function rooms(entries: Record<number, [number, number]>): Map<string, { x: number; y: number; level: number }> {
  return new Map(Object.entries(entries).map(([number, [x, y]]) => [`room:${number}`, { x, y, level: 0 }]));
}

function geometry(a: number, sideA: RouteSide, b: number, sideB: RouteSide, extra: Partial<LinkGeometry> = {}): LinkGeometry {
  return {
    endpointA: { roomNumber: a, side: sideA, portOffset: 0.5, portMode: "AutoPinned" },
    endpointB: { roomNumber: b, side: sideB, portOffset: 0.5, portMode: "AutoPinned" },
    routing: "Automatic", segmentShape: "Direct", corner: "Rounded", routePoints: [],
    color: DEFAULT_LINK_COLOR, thickness: 1,
    ...extra,
  };
}

function own(id: string, a: number, sideA: RouteSide, b: number, sideB: RouteSide, extra: Partial<LinkGeometry> = {}): RoutingLink {
  return { id, from: `room:${a}`, to: `room:${b}`, role: "route", sides: [sideA, sideB], geometry: geometry(a, sideA, b, sideB, extra) };
}

test("a link out of walls facing away from its room takes a route of rounded turns", () => {
  const [decision] = planLinkGeometry(rooms({ 1: [0, 0], 2: [0, 2] }), [own("bent", 1, "East", 2, "West")], MAP);
  assert.equal(decision.routed, true);
  assert.equal(decision.geometry.routing, "Automatic");
  assert.equal(decision.geometry.corner, "Rounded");
  assert.ok(decision.geometry.routePoints.length > 0);
});

test("a link straight out of both walls runs straight, still the mapper's own", () => {
  const [decision] = planLinkGeometry(rooms({ 1: [0, 0], 2: [0, 2] }), [own("clean", 1, "South", 2, "North")], MAP);
  assert.equal(decision.routed, false);
  assert.equal(decision.geometry.routing, "Automatic");
  assert.deepEqual(decision.geometry.routePoints, []);
});

test("links between Up and Down exits run straight: the mapper's route is dropped, an author's kept dormant", () => {
  const points = [{ x: 1, y: -1 }, { x: 2, y: -1 }];
  const decisions = planLinkGeometry(rooms({ 1: [0, 0], 2: [2, 0] }), [
    { id: "generated", from: "room:1", to: "room:2", role: "vertical", geometry: geometry(1, "North", 2, "South", { routePoints: points }) },
    { id: "authored", from: "room:1", to: "room:2", role: "vertical", geometry: geometry(1, "East", 2, "West", { routing: "Manual", routePoints: points }) },
  ], MAP);
  const generated = decisions.find((decision) => decision.id === "generated")!;
  const authored = decisions.find((decision) => decision.id === "authored")!;
  assert.equal(generated.geometry.routing, "Simple");
  assert.deepEqual(generated.geometry.routePoints, []);
  assert.equal(authored.geometry.routing, "Simple");
  assert.deepEqual(authored.geometry.routePoints, points);
  assert.equal(isVerticalDirection("Up"), true);
  assert.equal(isVerticalDirection("North"), false);
});

test("kept links get no decision and their drawings are avoided", () => {
  const kept: RoutingLink = {
    id: "kept", from: "room:3", to: "room:4", role: "keep",
    geometry: geometry(3, "South", 4, "North", { routing: "Manual", routePoints: [] }),
  };
  const decisions = planLinkGeometry(rooms({ 1: [0, 0], 2: [2, 2], 3: [1, -1], 4: [1, 3] }), [
    own("bent", 1, "East", 2, "North"),
    kept,
  ], MAP);
  assert.deepEqual(decisions.map((decision) => decision.id), ["bent"]);
});

test("crowded routes are called out in the map's palette colors, and an author's style stays", () => {
  const sources = [1, 2, 3, 4, 5, 6];
  const positions = rooms({ 10: [0, 0], ...Object.fromEntries(sources.map((n, index) => [n, [index * 2 - 5, 3]])) });
  const links = sources.map((n) => own(`s${n}`, n, "North", 10, "South"));
  links[0].geometry.color = "#123456";
  const decisions = planLinkGeometry(positions, links, MAP);
  const called = decisions.filter((decision) => decision.callout);
  assert.ok(called.length > 0);
  const styled = called.filter((decision) => decision.id !== "s1");
  assert.ok(styled.every((decision) => decision.geometry.thickness === LINK_CALLOUT_THICKNESS));
  const palette = new Set(Array.from({ length: 30 }, (_, place) => linkCalloutColor(MAP, place)));
  assert.ok(styled.every((decision) => palette.has(decision.geometry.color)));
  assert.equal(new Set(styled.map((decision) => decision.geometry.color)).size, styled.length);
  const author = decisions.find((decision) => decision.id === "s1")!;
  assert.equal(author.geometry.color, "#123456");
  assert.equal(author.geometry.thickness, 1);
});

test("a callout the mapper gave goes once the link no longer crowds a stretch", () => {
  const [decision] = planLinkGeometry(rooms({ 1: [0, 0], 2: [0, 2] }), [
    own("clean", 1, "South", 2, "North", { color: linkCalloutColor(MAP, 3), thickness: LINK_CALLOUT_THICKNESS }),
  ], MAP);
  assert.equal(decision.callout, false);
  assert.equal(decision.geometry.color, DEFAULT_LINK_COLOR);
  assert.equal(decision.geometry.thickness, 1);
});
