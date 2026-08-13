import assert from "node:assert/strict";
import test from "node:test";
import { verticalExitObservations, verticalMapLinks } from "./room-info.ts";

test("extracts numeric up/down exits while ignoring cardinal Room.Info exits", () => {
  const observations = verticalExitObservations({
    north: 10,
    u: 20,
    down: 30,
  });

  assert.deepEqual(observations.map(({ mapped, destination, closed }) => ({
    direction: mapped.direction,
    command: mapped.command,
    destination,
    closed,
  })), [
    { direction: "Down", command: "down", destination: 30, closed: false },
    { direction: "Up", command: "u", destination: 20, closed: false },
  ]);
  assert.deepEqual(verticalMapLinks(5, observations), [
    {
      from: 5,
      to: 30,
      direction: "down",
      bidirectional: false,
      closed: false,
      locked: false,
      route: false,
    },
    {
      from: 5,
      to: 20,
      direction: "u",
      bidirectional: false,
      closed: false,
      locked: false,
      route: false,
    },
  ]);
});

test("retains a closed vertical exit as a destinationless observation", () => {
  const observations = verticalExitObservations({ up: "closed", east: "closed" });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].mapped.direction, "Up");
  assert.equal(observations[0].closed, true);
  assert.equal(observations[0].destination, undefined);
  assert.deepEqual(verticalMapLinks(5, observations), []);
});
