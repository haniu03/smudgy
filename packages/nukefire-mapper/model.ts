/** A direction normalized for Smudgy plus the command NukeFire expects. */
export interface MappedDirection {
  direction: ExitDirection;
  command: string;
  opposite?: ExitDirection;
  reverseCommand?: string;
}

const DIRECTIONS: Record<string, ExitDirection> = {
  n: "North",
  north: "North",
  e: "East",
  east: "East",
  s: "South",
  south: "South",
  w: "West",
  west: "West",
  u: "Up",
  up: "Up",
  d: "Down",
  down: "Down",
  ne: "Northeast",
  northeast: "Northeast",
  nw: "Northwest",
  northwest: "Northwest",
  se: "Southeast",
  southeast: "Southeast",
  sw: "Southwest",
  southwest: "Southwest",
  in: "In",
  out: "Out",
};

const OPPOSITES: Partial<Record<ExitDirection, ExitDirection>> = {
  North: "South",
  East: "West",
  South: "North",
  West: "East",
  Up: "Down",
  Down: "Up",
  Northeast: "Southwest",
  Northwest: "Southeast",
  Southeast: "Northwest",
  Southwest: "Northeast",
  In: "Out",
  Out: "In",
};

const COMMANDS: Partial<Record<ExitDirection, string>> = {
  North: "north",
  East: "east",
  South: "south",
  West: "west",
  Up: "up",
  Down: "down",
  Northeast: "northeast",
  Northwest: "northwest",
  Southeast: "southeast",
  Southwest: "southwest",
  In: "in",
  Out: "out",
};

/** Normalize a NukeFire link direction without losing a special-exit command. */
export function mapDirection(raw: string): MappedDirection {
  const command = raw.trim().toLowerCase();
  const key = command.replace(/[\s_-]+/g, "");
  const direction = DIRECTIONS[key];
  if (!direction) {
    return { direction: "Special", command: command || "special" };
  }

  const opposite = OPPOSITES[direction];
  return {
    direction,
    command: command || COMMANDS[direction] || direction.toLowerCase(),
    opposite,
    reverseCommand: opposite ? COMMANDS[opposite] : undefined,
  };
}

/** The opposite of a canonical Smudgy direction, when one is knowable. */
export function oppositeDirection(direction: ExitDirection): ExitDirection | undefined {
  return OPPOSITES[direction];
}

/** Pick a connection wall, falling back to room geometry for special exits. */
export function directionSide(
  direction: ExitDirection,
  deltaX: number,
  deltaY: number,
): RoomSide {
  switch (direction) {
    case "North":
    case "Northeast":
    case "Northwest":
    case "Up":
      return "North";
    case "East":
    case "In":
      return "East";
    case "South":
    case "Southeast":
    case "Southwest":
    case "Down":
      return "South";
    case "West":
    case "Out":
      return "West";
    default:
      if (Math.abs(deltaX) >= Math.abs(deltaY)) return deltaX >= 0 ? "East" : "West";
      return deltaY >= 0 ? "South" : "North";
  }
}

/** Stable room color derived from NukeFire's terrain name. */
export function terrainColor(terrain: string): string {
  switch (terrain.trim().toLowerCase()) {
    case "forest":
      return "#2f7d43";
    case "water":
      return "#2a6bc0";
    case "smooth":
      return "#7d8894";
    case "mountains":
      return "#8a6a55";
    case "hills":
      return "#a08464";
    case "inside":
    case "indoors":
      return "#b0a27a";
    case "city":
      return "#8b7f72";
    case "desert":
      return "#c49a55";
    case "field":
    case "plains":
      return "#7c9a4d";
    default:
      return "#5c5c66";
  }
}

export function externalRoomId(vnum: number): string {
  return String(vnum);
}

export function isUsableVnum(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isFiniteCoordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}
