import assert from "node:assert/strict";
import test from "node:test";
import { ownsSharedMapping } from "./ownership.ts";

test("only the oldest same-server session owns shared mapping", () => {
  const sessions = [{ id: 11 }, { id: 12 }, { id: 13 }];

  assert.equal(ownsSharedMapping(11, sessions), true);
  assert.equal(ownsSharedMapping(12, sessions), false);
  assert.equal(ownsSharedMapping(13, sessions), false);
});

test("no session owns mapping while the registry is empty", () => {
  assert.equal(ownsSharedMapping(11, []), false);
});
