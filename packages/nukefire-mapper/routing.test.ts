import assert from "node:assert/strict";
import test from "node:test";
import type { GridPosition } from "./layout.ts";
import {
  directRoomObstructions,
  routeAroundRooms,
  routeEndSide,
  routeStartSide,
  routeTurnPoints,
} from "./routing.ts";

const at = (x: number, y: number, level = 0): GridPosition => ({ x, y, level });

test("detects rooms crossed by a long straight cardinal link", () => {
  const blocked = directRoomObstructions(at(0, 0), at(5, 0), [at(1, 0), at(3, 0), at(2, 1)]);
  assert.deepEqual(blocked, [at(1, 0), at(3, 0)]);
});

test("routes a selected-link shape around a row of intervening rooms", () => {
  const rooms = [at(1, 0), at(2, 0), at(3, 0), at(4, 0)];
  const path = routeAroundRooms(at(0, 0), at(5, 0), rooms, "East", "West");
  assert.ok(path);
  const occupied = new Set(rooms.map((room) => `${room.x}:${room.y}`));
  for (const point of path.slice(1, -1)) {
    assert.equal(occupied.has(`${point.x}:${point.y}`), false);
  }
  assert.ok(routeTurnPoints(path).length >= 2);
  assert.notEqual(routeStartSide(path), "East");
  assert.notEqual(routeEndSide(path), "West");
});

test("keeps an unobstructed cardinal route straight", () => {
  const path = routeAroundRooms(at(0, 0), at(4, 0), [], "East", "West");
  assert.ok(path);
  assert.equal(routeTurnPoints(path).length, 0);
  assert.equal(routeStartSide(path), "East");
  assert.equal(routeEndSide(path), "West");
});

test("does not treat rooms on another level as obstacles", () => {
  assert.deepEqual(directRoomObstructions(at(0, 0), at(3, 0), [at(1, 0, 1)]), []);
});
