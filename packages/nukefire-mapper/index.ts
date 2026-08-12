// NukeFire-specific automatic mapper. Map.Local is authoritative; Room.Info
// contributes only the human-readable current-area name.

import { NukeFireMapper } from "./mapper.ts";

export * from "./model.ts";
export * from "./layout.ts";
export * from "./routing.ts";
export * from "./decision-log.ts";
export * from "./mapper.ts";

export const nukefireMapper = new NukeFireMapper({ storage: "session" });
nukefireMapper.start();
