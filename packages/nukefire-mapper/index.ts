// NukeFire-specific automatic mapper. Map.Local is authoritative; Room.Info
// contributes the human-readable current-area name and vertical topology.
// Mapping is shared client state, so only the oldest live session may mutate it.

import { getSessions, session } from "smudgy:core";
import { created, destroyed } from "smudgy:events/sessions";
import { get } from "smudgy:params";
import { DEFAULT_DECISION_LOG_FILE } from "./decision-log.ts";
import { NukeFireMapper } from "./mapper.ts";
import { ownsSharedMapping } from "./ownership.ts";

export * from "./model.ts";
export * from "./layout.ts";
export * from "./routing.ts";
export * from "./area-resolution.ts";
export * from "./decision-log.ts";
export * from "./room-info.ts";
export * from "./ownership.ts";
export * from "./reflow-policy.ts";
export * from "./mapper.ts";

export const nukefireMapper = new NukeFireMapper({
  storage: "local",
  decisionLogFile: get("debugMappingDecisions") === true
    ? DEFAULT_DECISION_LOG_FILE
    : false,
});

let ownershipTimer: ReturnType<typeof setTimeout> | undefined;

function ownsMapping(): boolean {
  return ownsSharedMapping(session.id, getSessions());
}

function reconcileMappingOwner(): void {
  ownershipTimer = undefined;
  if (ownsMapping()) {
    nukefireMapper.start();
  } else {
    nukefireMapper.stop();
  }
}

function scheduleOwnershipCheck(): void {
  if (ownershipTimer !== undefined) clearTimeout(ownershipTimer);
  // Lifecycle events are emitted as the registry changes; defer one turn so
  // a destroyed session has disappeared before electing its successor.
  ownershipTimer = setTimeout(reconcileMappingOwner, 100);
}

created.on(scheduleOwnershipCheck);
destroyed.on(scheduleOwnershipCheck);
reconcileMappingOwner();
