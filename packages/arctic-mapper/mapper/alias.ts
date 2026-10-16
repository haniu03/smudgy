import { createAlias, createHotkey, createTrigger, type Matches, echo, send, sendRaw, capture, buffer, line, mapper, getSessions, session } from "smudgy:core";
import { extractMarkdownLinks } from "smudgy:widgets";
import {
    planAreaChange,
    loadLayoutModel,
    planLayoutModel,
    layoutSnapshotKey,
    chooseProjectedConstraint,
    inferElevationPreference,
    materializePlannedLayoutModels,
    measureIntegralLayoutQuality,
    compareLayoutQuality,
    DIRECTIONAL_VIOLATION_WEIGHT,
    LEVEL_VIOLATION_WEIGHT,
    type AreaChangePlan,
    type ElevationPreference,
    type LayoutDirection,
    type LayoutModel,
    type LayoutQuality,
    type LayoutPatch,
} from "smudgy:@map-layout";
import { debugLog, distanceBetweenRooms, findRoomsAt, idsMatch, linkRooms, options, parseRoomExits, parseRoomExitsDetailed, roomsImpactedByPush, speedwalk, State, state, ZMode } from "./mapper.ts";
import { mapEvent, type RoomEvent } from "./events.ts";
import { requestExistingRoomConnection } from "./widget.tsx";

import promptEvent from 'smudgy:events/kapusniak/arctic-prompt/prompt';

import {
    Direction,
    DirectionLetter,
    MoveCommands,
    OppositeDirection,
} from "./mapper.ts";
import { defaultOpenCommand, describeDoor, doorUpdate, nextDoorState, openCommandFor } from "./doors.ts";
import { notesLinks } from "./places.ts";
import { extendExit, linkCandidate, linkNeedsOtherPlace } from "./links.ts";
import { recordObservedDoors } from "./recording.ts";
import { findAreaByName, findNearestRoomWithTagsInArea, roomRouteCost } from "./tag-search.ts";
import { targets } from "./targets.ts";
import { extendRecordedExit } from "./recording-place.ts";

createAlias(/^map\b(\s+(?<args>.*))?$/, mapperCommand, { name: "mapper" });

// Every link in `text`, in order, as `{ text, url }` (the label to show and the destination to
// run) — exactly the links a <Markdown> widget renders for it: explicit `[label](dest)` links
// (label and destination can differ, e.g. `[the temple](<enter temple>)`) and bare command
// autolinks (`<go north>`), with escapes and inline/fenced code handled by the real parser
// instead of a pattern.
function links(text: string): { text: string; url: string }[] {
    return extractMarkdownLinks(text).map(({ label, url }) => ({ text: label, url }));
}

// Run the destination of the `index`th (1-based) link in the current room's notes. Echoes when
// the room has no notes, its notes contain no link, or it has fewer links than asked for.
function sendRoomNotesLink(index = 1, audience: "self" | "all" | "others" = "self") {
    state.refreshRoomAndArea();
    const found = notesLinks(state.room, links);
    const link = found[index - 1];

    if (link) {
        if (audience === "self") send(link.url);
        else {
            for (const target of getSessions()) {
                if (audience === "all" || target.id !== session.id) target.send(link.url);
            }
        }
    } else if (found.length > 0) {
        echo(`This room's notes have only ${found.length} link${found.length === 1 ? "" : "s"}.`);
    } else {
        echo("No link found in this room's notes.");
    }
}

// Leave these keys available to other bindings when the package option is off.
if (options.noteLinkHotkeys) {
    createHotkey({ key: "Enter", modifiers: ["ctrl"] }, () => sendRoomNotesLink(),
        { name: "room_notes_link" });
    createHotkey({ key: "Enter", modifiers: ["ctrl", "alt"] }, () => sendRoomNotesLink(1, "all"),
        { name: "room_notes_link_alt" });
    createHotkey({ key: "Enter", modifiers: ["ctrl", "shift"] }, () => sendRoomNotesLink(1, "others"),
        { name: "room_notes_link_shift" });
}

// When we enter a room whose notes carry a link, hint it inline in the game's prompt (the
// same link CTRL+ENTER follows), borrowing the older command-hint module's approach. Runs in
// the map update queue after the room event's handler, so state.room is the room just
// entered.
function hintShortcut(room: RoomEvent) {
    if (!options.noteLinkPromptHint) return;
    const link = notesLinks(state.room, links)[0];
    if (!link) {
        return;
    }
    // Slip the hint in just before the prompt's ">". Show the link text (which may read more
    // nicely than the destination CTRL+ENTER runs).
    const at = room.prompt.lastIndexOf(">");

    if (at < 0) {
        return;
    }
    const target = promptLine(room.prompt_line_number, room.prompt.slice(0, at));
    if (!target) {
        return;
    }
    try {
        target.insert(` Shortcut:${link.text}`, at);
    } catch (e) {
        echo(`Error inserting link hint: ${e}`);
    }
}

// The prompt's line, found by its text. `number` is what the prompt's line was predicted to
// be; an echo during the prompt's own pass is emitted ahead of it and pushes it later, so
// search the emitted lines from there up. Not emitted yet means it is still in flight: a
// buffer edit of a line not yet emitted is dropped, so edit the current line instead.
function promptLine(number: number, prefix: string) {
    for (let n = number; n < line.number; n++) {
        const emitted = buffer.line(n);
        if (emitted.text.startsWith(prefix)) {
            return emitted;
        }
    }
    return line.text.startsWith(prefix) ? line : null;
}

// Speedwalk to the nearest room matching a dot-separated tag filter. Each token
// is a required tag, or an excluded tag when prefixed with `!`. Tags are set with
// `map room flag set <TAG>` (or the mapper UI). Examples:
//   >inn              nearest INN
//   >inn.peace        nearest room with BOTH INN and PEACE
//   >!peace.guild     nearest GUILD room that is NOT PEACE
//   >inn@sol          nearest INN in the area named by "sol"
createAlias(/^>(?<spec>[!\w.]+)(?:@(?<prefix>.+?))?(?:[ \t]+(?<alone>a|al|alo|alon|alone))?[ \t]*$/, ({ spec, prefix, alone }: Matches) => {
    if (!spec) {
        return;
    }
    const here = state.room;
    if (!here) {
        echo("The mapper doesn't know your current room yet.");
        return;
    }

    // An absent optional group reads "", so only a named area scopes the search.
    const scope = prefix?.trim() || undefined;
    const area = scope === undefined ? undefined : findAreaByName(mapper.areas, scope);
    if (scope !== undefined && !area) {
        echo(`No area name starts with "${scope}".`);
        return;
    }

    const all: string[] = [];
    const none: string[] = [];
    for (const token of spec.split(".")) {
        if (!token) {
            continue;
        }
        if (token.startsWith("!")) {
            const tag = token.slice(1);
            if (tag) {
                none.push(tag);
            }
        } else {
            all.push(token);
        }
    }
    if (all.length === 0 && none.length === 0) {
        return;
    }

    const dest = area ? findNearestRoomWithTagsInArea(mapper, here, area, all, none)
        : mapper.findNearestRoomWithTags(here, { all, none });
    if (dest) {
        speedwalk(dest, here, !!alone);
        return;
    }

    // Expand tags in the named area, or the current area when no scope was given.
    const resolved = resolveTagPrefixes(here, all, none, area);
    if (resolved) {
        echo(`Matched ${resolved.combo.join(".")}.`);
        speedwalk(resolved.room, here, !!alone);
        return;
    }

    echo(`No room matching >${spec.toUpperCase()}${area ? `@${area.name}` : ""} is reachable from here.`);
}, { name: "speedwalk_tag" });

// Speedwalk to an area named by prefix: `>@sol` walks to the closest reachable
// room of the first area whose name starts with "sol" (case-insensitive; an
// exact name wins over a longer prefix match, so `>@mud` reaches "Mud" even
// when "Mudhole" exists). The destination is the area itself, so there is no
// tag filter -- `>@sol.!peace` is just a (failing) prefix.
createAlias(/^>@(?<prefix>.+?)(?:[ \t]+(?<alone>a|al|alo|alon|alone))?[ \t]*$/, ({ prefix, alone }: Matches) => {
    const wanted = (prefix ?? "").trim().toLowerCase();
    if (!wanted) {
        return;
    }
    const here = state.room;
    if (!here) {
        echo("The mapper doesn't know your current room yet.");
        return;
    }

    const area = findAreaByName(mapper.areas, prefix);
    if (!area) {
        echo(`No area name starts with "${prefix.trim()}".`);
        return;
    }

    const dest = mapper.findNearestRoomInArea(here, area);
    if (!dest) {
        echo(`No room of ${area.name} is reachable from here.`);
        return;
    }
    if (speedwalk(dest, here, !!alone) === 0) {
        echo(`You're already in ${area.name}.`);
    }
}, { name: "speedwalk_area" });

// Named destinations supplied by procedures or another session's live location.
createAlias(/^>\$(?<prefix>.+?)(?:[ \t]+(?<alone>a|al|alo|alon|alone))?[ \t]*$/, ({ prefix, alone }: Matches) => {
    const here = state.room;
    if (!here) {
        echo("The mapper doesn't know your current room yet.");
        return;
    }
    try {
        const target = targets.find(prefix);
        let room: Room | undefined;
        try { room = mapper.getAreaById(target.location.areaId)?.room(target.location.roomNumber); }
        catch { /* A target may refer to a map/place unavailable in this session. */ }
        if (!room) {
            echo(`Target "${target.name}" refers to a room unavailable in this session.`);
        } else if (room.areaId === here.areaId && room.roomNumber === here.roomNumber) {
            echo(`You're already at ${target.name}.`);
        } else if (speedwalk(room, here, !!alone) === 0) {
            echo(`Target "${target.name}" is not reachable from here.`);
        }
    } catch (error) {
        echo(error instanceof Error ? error.message : String(error));
    }
}, { name: "speedwalk_target" });

// The distinct tags present on rooms in an area (already stored UPPERCASE).
function areaTags(area: Area): string[] {
    const tags = new Set<string>();
    for (const roomNumber of area.roomNumbers) {
        const room = area.room(roomNumber);
        for (const tag of room?.tags ?? []) {
            tags.add(tag);
        }
    }
    return [...tags];
}

// All combinations picking one item from each list (cartesian product).
function cartesian(lists: string[][]): string[][] {
    return lists.reduce<string[][]>(
        (acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])),
        [[]],
    );
}

// Fallback for ">tag" when no room matches the tags exactly: read each required token
// as a prefix of a real tag in the named or current area and return the nearest reachable room
// (with the expansion used). A token that already names a real tag resolves to itself;
// excluded (none) tags are left exact. Null if nothing expands to a reachable room.
function resolveTagPrefixes(here: Room, all: string[], none: string[], scope?: Area): { room: Room; combo: string[] } | null {
    const area = scope ?? state.area;
    if (!area || all.length === 0) {
        return null;
    }
    const tags = areaTags(area);

    const candidatesPerToken = all.map((token) => {
        const upper = token.toUpperCase();
        return tags.includes(upper) ? [upper] : tags.filter((t) => t.startsWith(upper));
    });
    if (candidatesPerToken.some((candidates) => candidates.length === 0)) {
        return null;
    }

    let best: { room: Room; combo: string[] } | null = null;
    let bestDistance = Infinity;
    for (const combo of cartesian(candidatesPerToken)) {
        const room = scope ? findNearestRoomWithTagsInArea(mapper, here, scope, combo, none)
            : mapper.findNearestRoomWithTags(here, { all: combo, none });
        if (!room) continue;
        const distance = scope ? roomRouteCost(mapper, here, room) : distanceBetweenRooms(here, room);
        if (distance < bestDistance) {
            best = { room, combo };
            bestDistance = distance;
        }
    }
    return best;
}

function parseArgs(args: string) {
    let escaped = false;
    let quoted: '"' | "'" | false = false;
    const result: string[] = [];
    let current = "";

    for (const c of args) {
        if (escaped) {
            current += c;
            escaped = false;
        } else if (c === quoted) {
            quoted = false;
            result.push(current);
            current = "";
        } else if (current.length > 0 && !quoted && (c === " ")) {
            result.push(current);
            current = "";
        } else if (!quoted && (c === '"' || c === "'")) {
            quoted = c;
        } else if (c === "\\") {
            escaped = true;
        } else if (quoted || c !== " ") {
            current += c;
        }
    }

    if (current.length > 0) {
        result.push(current);
    }
    return result;
}

function mapperCommand(matches: Matches) {
    void runMapperCommand(matches);
}

async function runMapperCommand({ args }: Matches) {
    try {
        let [command, ...cmdArgs] = parseArgs(args ?? "");
        if (command && command in commands) {
            await commands[command as keyof typeof commands].apply(null, cmdArgs);
        } else {
            commands.help();
        }
    } catch (error) {
        echo(`Map edit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// Move the selection along an existing exit in the given direction.
function moveSelected(direction: string) {
    if (!state.room) {
        echo("No room selected");
        return;
    }

    const intent = MoveCommands[direction as keyof typeof MoveCommands];
    if (!intent || intent === "look") {
        echo(`Invalid direction: ${direction}`);
        return;
    }

    const exit = state.room.exits.find((e) => e.fromDirection === intent && !!e.toRoomNumber);

    if (exit) {
        const areaId = exit.toAreaId;
        const roomId = exit.toRoomNumber;

        if (!areaId || !roomId) {
            echo(`Exit ${direction} from ${state.room.title} is not linked to a room`);
            return;
        }
        
        const area = mapper.getAreaById(areaId);
        if (!area) {
            echo(`Area ${areaId} not found`);
            return;
        }
        const room = area.room(roomId);

        if (!room) {
            echo(`Room ${roomId} not found in area ${area.name}`);
            return;
        }
        
        state.area = area;
        state.room = room;

        mapper.setCurrentLocation(state.area.id, state.room.roomNumber);
        echo(`Moved to room ${state.room.title}`);
    } else {
        echo(`No exit found in direction ${direction}`);
    }
}

async function areaCommand([subcommand, ...args]: string[]) {
    switch (subcommand) {
        case 'create': {
            const [name] = args;
            if (!name) {
                echo("Usage: area create <name>");
                return;
            }
            // The default durable destination is cloud when signed in and local
            // otherwise. An explicit `storage: "cloud"` would not fall back.
            const area = await mapper.createArea(name);
            echo(`Created ${area.storage} area ${name}`);
            break;
        }
        default:
            echo("\nAreas:");
            for (const area of mapper.areas) {
                echo(
                    `  ${area.name} (${area.roomNumbers.length} rooms) [${area.id}]`,
                );
            }
            break;
    }
}


async function roomCommand([subcommand, ...args]: string[]) {
    switch (subcommand) {
        case 'move': {
            const [direction] = args;
            moveSelected(direction);
            break;
        }
        case 'color': {
            const [color] = args;
            if (!color) {
                echo("Usage: map room color <color>");
                return;
            }
            if (!state.room) {
                echo("No room selected");
                return;
            }
            await mapper.setRoomColor(state.area.id, state.room.roomNumber, color);
            state.refreshRoomAndArea();
            mapper.setCurrentLocation(state.area.id, state.room.roomNumber);
            break;
        }
        case 'link': {
            const usage = () => {
                echo("Usage: map room link <direction> <target> [options]");
                echo("Options:");
                echo("  oneway - Create a one-way exit from the current room to the target room");
            }
            if (!state.room) {
                echo("No room selected");
                usage();
                return;
            }

            const [direction, target, ...rest] = args;
            const options = new Set(rest.map(r => r.toLowerCase()));


            const targetRoom = state.getRoomFromRoomTag(target);

            if (!targetRoom) {
                echo(`Room ${target} not found`);
                usage();
                return;
            }

            const intent = MoveCommands[direction as keyof typeof MoveCommands];

            if (!intent || intent === "look") {
                usage();
                return;
            }

            await linkRooms(state.room, targetRoom, intent, !options.has('oneway'));

            state.refreshRoomAndArea();
            mapper.setCurrentLocation(state.area.id, state.room.roomNumber);
            echo(`Linked room ${state.room.title} to ${targetRoom.title} in direction ${direction}`);

            break;
        }
        case 'shift': {
            if (!state.room) {
                echo("No room selected");
                return;
            }

            const [direction] = args;
            const intent = MoveCommands[direction as keyof typeof MoveCommands];
            if (!intent || intent === "look") {
                echo("Usage: map room shift <direction>");
                return;
            }
            const offset = options.moveCoordinates[intent];
            const selectedRoom = state.room;
            await mapper.mutateArea(state.area.id, (mutation) => mutation.updateRoom(
                selectedRoom,
                {
                    ...(offset[0] !== 0 ? { x: selectedRoom.x + offset[0] } : {}),
                    ...(offset[1] !== 0 ? { y: selectedRoom.y + offset[1] } : {}),
                    ...(offset[2] !== 0 ? { level: selectedRoom.level + offset[2] } : {}),
                },
            ), { description: "Shift Arctic room" });
            state.refreshRoomAndArea();
            break;
        }
        case 'unlink': {
            if (!state.room) {
                echo("No room selected");
                return;
            }

            const [direction] = args;
            const intent = MoveCommands[direction as keyof typeof MoveCommands];
            const exits = state.room.exits.filter((e) => e.fromDirection === intent);

            for (const exit of exits) {
                await mapper.deleteRoomExit(state.area.id, state.room.roomNumber, exit.id);
                echo(`Deleted exit ${exit.fromDirection} from ${state.room.title}`);
            }
            state.refreshRoomAndArea();
            mapper.setCurrentLocation(state.area.id, state.room.roomNumber);

            break;
        }
        case 'delete': {
            if (!state.room) {
                echo("No room selected");
                return;
            }
            const { areaId, roomNumber, title } = state.room;
            await mapper.deleteRoom(areaId, roomNumber);
            state.area = mapper.getAreaById(areaId);
            state.room = null;
            mapper.setCurrentLocation(state.area.id, null);
            echo(`Deleted room ${title}`);
            break;
        }
        case 'show': {
            // show the current room
            if (!state.room) {
                echo("No room selected");
                return;
            }
            echo(`Showing room ${state.room.title}`);
            echo(`Description: ${state.room.description}`);
            echo(`Coordinates: ${state.room.x}, ${state.room.y} Level:${state.room.level}`);
            echo(`Exits: ${state.room.exits.map(e => {
                const markers = [
                    e.door && `door ${describeDoor(e.door)}`,
                    e.isHidden && "hidden",
                    e.command && `cmd: ${e.command}`,
                    e.door?.opensWith && `open: ${e.door.opensWith}`,
                ].filter(Boolean);
                return `${e.fromDirection} -> ${e.toRoomNumber ?? "?"}${markers.length ? ` [${markers.join(", ")}]` : ""}`;
            }).join(", ")}`);
            break;
        }
        case 'flag': {
            if (!state.room) {
                echo("No room selected");
                return;
            }

            const [action, flag] = args;

            if (!action || !flag) {
                echo("Usage: map room flag <action> <flag>");
                echo("Actions: set, clear");
                echo(`Current flags: ${state.room.tags.join(", ") || "(none)"}`);
                return;
            }

            // Flags are room tags: any name, case-insensitive, stored UPPERCASE.
            const tag = flag.trim();

            if (!tag) {
                echo("No flag given");
                return;
            }

            if (action === "set") {
                await mapper.addRoomTag(state.area.id, state.room.roomNumber, tag);
            } else if (action === "clear") {
                const flagged = state.room.hasTag(tag);
                if (await mapper.removeRoomTag(state.area.id, state.room.roomNumber, tag) === null) {
                    echo(flagged
                        ? `${tag.toUpperCase()} comes from Private or a Secret, not this room's own flags.`
                        : `This room has no ${tag.toUpperCase()} flag.`);
                }
            } else {
                echo("Invalid action");
                return;
            }
            state.refreshRoomAndArea();
            break;
        }
        case 'automerge': {
            if (!state.room) {
                echo("No room selected");
                return;
            }

            const rooms = mapper.listRoomsByTitleAndDescription(state.room.title, state.room.description);

            // find the nearest room with a matching title and description
            const nearestRoom = rooms.filter(r =>
                idsMatch(r.areaId, state.area.id)
                && r.roomNumber !== state.room.roomNumber
            ).sort((a, b) => {
                const aDistance = Math.abs(a.x - state.room.x) + Math.abs(a.y - state.room.y) + Math.abs(a.level - state.room.level);
                const bDistance = Math.abs(b.x - state.room.x) + Math.abs(b.y - state.room.y) + Math.abs(b.level - state.room.level);
                return aDistance - bDistance;
            });

            if (nearestRoom.length === 0) {
                echo("No nearest room found");
                return;
            }

            const mergeWith = nearestRoom[0];

            try {
                await mapper.mergeRooms(
                    state.area.id,
                    state.room.roomNumber,
                    mergeWith.roomNumber,
                );
                state.refreshRoomAndArea();
                mapper.setCurrentLocation(state.area.id, state.room.roomNumber);
            } catch (error) {
                echo(`Could not merge rooms: ${error}`);
            }

            break;
        }
    }
}

async function exitCommand([dirArg, action, ...rest]: string[]) {
    const usage = () => {
        echo("Usage: map exit <direction> [action]");
        echo("Actions:");
        echo("  (none)                  - Show the exit's door, commands and flags");
        echo("  open <cmd>              - Command that opens the door (e.g. `unlock n;open n`, `part brush`)");
        echo("  name <name>             - Door name used by the default open command");
        echo("  command <cmd>           - Command sent instead of the direction (e.g. `enter hole`)");
        echo("  clear open|command|door|name - Remove the open command, movement command, door, or door name");
        echo("  closed|locked [true|false] - Set the door's state");
        echo("  hidden [true|false]     - Set the hidden flag");
    };

    if (!state.room) {
        echo("No room selected");
        return;
    }

    const intent = dirArg ? MoveCommands[dirArg as keyof typeof MoveCommands] : undefined;
    if (!intent || intent === "look") {
        usage();
        return;
    }
    const direction = intent;

    const exit = state.room.exits.find((e) => e.fromDirection === direction);
    if (!exit) {
        echo(`No exit ${direction} from ${state.room.title}`);
        return;
    }
    const door = exit.door ?? null;
    const setDoor = async (next: DoorArgs | null) => {
        await mapper.setRoomExit(state.area.id, state.room.roomNumber, exit.id, { door: next });
        state.refreshRoomAndArea();
    };

    switch (action) {
        case undefined:
        case 'show': {
            echo(`Exit ${direction} from ${state.room.title}:`);
            echo(`  to: ${exit.toRoomNumber ?? "(unlinked)"}${exit.toDirection ? ` (arrives from ${exit.toDirection})` : ""}`);
            echo(`  door: ${door ? describeDoor(door) : "(none)"}`);
            echo(`  flags: ${exit.isHidden ? "hidden" : "(none)"}`);
            echo(`  open command: ${openCommandFor(exit, `${defaultOpenCommand(exit, DirectionLetter[direction])} (default)`) ?? "(none)"}`);
            echo(`  movement command: ${exit.command || "(none)"}`);
            break;
        }
        case 'open': {
            const cmd = rest.join(" ").trim();
            if (!cmd) {
                usage();
                return;
            }
            await setDoor(doorUpdate(door, { opensWith: cmd }));
            echo(`Exit ${direction}: open command set to \`${cmd}\``);
            break;
        }
        case 'name': {
            const name = rest.join(" ").trim();
            if (!name) { usage(); return; }
            await setDoor(doorUpdate(door, { name }));
            echo(`Exit ${direction}: door name set to \`${name}\``);
            break;
        }
        case 'command': {
            const cmd = rest.join(" ").trim();
            if (!cmd) {
                usage();
                return;
            }
            await mapper.setRoomExit(state.area.id, state.room.roomNumber, exit.id, { command: cmd });
            state.refreshRoomAndArea();
            echo(`Exit ${direction}: movement command set to \`${cmd}\` (sent instead of ${DirectionLetter[direction]})`);
            break;
        }
        case 'clear': {
            const what = rest[0]?.toLowerCase();
            if (what === 'open') {
                if (!door?.opensWith) {
                    echo(`Exit ${direction} has no open command`);
                    return;
                }
                await setDoor(doorUpdate(door, { opensWith: null }));
                echo(`Exit ${direction}: open command cleared`);
            } else if (what === 'command') {
                await mapper.setRoomExit(state.area.id, state.room.roomNumber, exit.id, { command: "" });
                state.refreshRoomAndArea();
                echo(`Exit ${direction}: movement command cleared`);
            } else if (what === 'name') {
                if (door) await setDoor(doorUpdate(door, { name: null }));
                echo(`Exit ${direction}: door name cleared`);
            } else if (what === 'door') {
                if (!door) {
                    echo(`Exit ${direction} has no door`);
                    return;
                }
                await setDoor(null);
                echo(`Exit ${direction}: door removed`);
            } else {
                usage();
            }
            break;
        }
        case 'closed':
        case 'locked': {
            const value = (rest[0] ?? "true").toLowerCase() !== "false";
            const current = door?.state ?? null;
            const next = nextDoorState(current, action, value);
            if (next === null) {
                echo(`Exit ${direction} has no door`);
                return;
            }
            const updated = doorUpdate(door, { state: next });
            if (next !== current) {
                await setDoor(updated);
            }
            echo(`Exit ${direction}: door ${describeDoor(updated)}`);
            break;
        }
        case 'hidden': {
            const value = (rest[0] ?? "true").toLowerCase() !== "false";
            await mapper.setRoomExit(state.area.id, state.room.roomNumber, exit.id, { isHidden: value });
            state.refreshRoomAndArea();
            echo(`Exit ${direction}: hidden = ${value}`);
            break;
        }
        default:
            usage();
            break;
    }
}

const commands = {
    help: () => {
        echo("");
        echo("Usage: map [command] [options]");
        echo("Commands:");
        echo("  help - Show this help message");
        echo("  off - Turn the mapper off");
        echo("  follow - Follow movement on the map without modifying it");
        echo("  active - Like follow, plus n/e/s/w/u/d open doors and use exit commands");
        echo("  record - Map new rooms as you move");
        echo("  area - List areas");
        echo("  area create <name> - Create a new area");
        echo("  rooms - List rooms in the currently selected area");
        echo("  select <area> [room] - Select the current area and room");
        echo("  move <direction> - Move the selection along an existing exit");
        echo("  path <from> <to> - Show the path between two rooms (tags: <number> or <area>#<number>)");
        echo("  push <direction> - Shift the selected room and connected rooms in a direction");
        echo("  reflow - Thoroughly search and reflow the complete current area");
        echo("  z [auto|levels|projected] - Show or set new U/D room placement style");
        echo("  refresh - Refresh the current room (will send a `look` command)");
        echo("  send_link [n] - Run the nth link in the current room's notes (default 1)");
        echo("  room move|color|link|shift|unlink|delete|show|flag|automerge - Edit the selected room");
        echo("  exit <direction> [open|name|command|clear|closed|hidden|locked] - Show or edit an exit");
        echo("  debug [on|off] - Toggle diagnostic logging");
        echo("  debug raw - Toggle raw line dump (escape codes shown as \\e)");
        echo("Speedwalk: >tags, >tags@area, >@area, or >$target (optional: a|al|alo|alon|alone)");
        echo("  Targets include other sessions' profile names; use an exact name or unique prefix.");
    },
    area: (...args: string[]) => areaCommand(args),
    room: (...args: string[]) => {
        return roomCommand(args);
    },
    rooms: () => {
        if (!state.area) {
            echo("No area selected");
            return;
        }

        echo("\nRooms:");
        for (const roomNumber of state.area.roomNumbers) {
            const room = state.area.room(roomNumber);
            echo(`  ${room.title} (${room.roomNumber})`);
        }
    },
    path: (from: string, to: string) => {
        const fromRoom = state.getRoomFromRoomTag(from);
        const toRoom = state.getRoomFromRoomTag(to);
        if (!fromRoom || !toRoom) {
            echo("Room not found (use a room number or <area>#<number>)");
            return;
        }
        const path = mapper.getPathBetweenRooms(fromRoom.areaId, fromRoom.roomNumber, toRoom.areaId, toRoom.roomNumber);
        for (const room of path) {
            const areaId = room[0];
            const roomNumber = room[1];
            echo(`area ${areaId} room ${roomNumber}`);
        }
    },

    push: async (direction: string) => {
        if (!state.room) {
            echo("No room selected");
            return;
        }

        const intent = MoveCommands[direction as keyof typeof MoveCommands];

        if (!intent || intent === "look") {
            echo(`Invalid direction: ${direction}`);
            return;
        }

        const rooms = roomsImpactedByPush(state.room, intent as Direction);

        const offset = options.moveCoordinates[intent as Direction];

        const updates: [RoomNumber, UpdateRoomParams][] = [];
        for (const roomNumber of rooms) {
            const room = state.area.room(roomNumber);
            echo(`Pushing room ${room.title} to ${intent}`);

            const fields: UpdateRoomParams = {
                ...(offset[0] !== 0 ? { x: room.x + offset[0] } : {}),
                ...(offset[1] !== 0 ? { y: room.y + offset[1] } : {}),
            };
            if (Object.keys(fields).length > 0) updates.push([roomNumber, fields]);
        }
        if (updates.length > 0) {
            await mapper.mutateArea(state.area.id, (mutation) => mutation.updateRooms(updates), {
                description: "Push Arctic rooms",
            });
        }

        state.refreshRoomAndArea();
    },
    reflow: async () => {
        if (!state.area) {
            echo("No area selected");
            return;
        }
        echo("Searching violation-prioritized anchors for a better layout…");
        const result = await planAreaChange(state.area.id, {
            type: "reflow",
            anchor: state.room?.roomNumber,
        }, {
            effort: "thorough",
        });
        await applyLayoutMoves(state.area.id, result);
        state.refreshRoomAndArea();
        const search = result.search;
        const searchText = search
            ? ` Tried ${search.anchorsTried.length} anchors across ${search.planningPasses} passes; ` +
                `selected ${search.selectedAnchor === null ? "the unanchored result" : `room ${search.selectedAnchor} as anchor`}.`
            : "";
        echo(`Thoroughly reflowed ${result.patch.moves.length} room${result.patch.moves.length === 1 ? "" : "s"}; ` +
            `${result.quality.cardinalRayViolations} directional violation${result.quality.cardinalRayViolations === 1 ? "" : "s"} remain.` +
            searchText);
    },
    z: (mode?: string) => {
        const normalized = mode?.toLowerCase();
        if (!normalized) {
            const current = options.zMode === ZMode.Auto
                ? "auto"
                : options.zMode === ZMode.Normal ? "levels" : "projected";
            echo(`New U/D room placement: ${current}`);
            return;
        }
        const selected = normalized === "auto"
            ? ZMode.Auto
            : normalized === "levels" || normalized === "normal"
                ? ZMode.Normal
                : normalized === "projected" || normalized === "isometric"
                    ? ZMode.Isometric
                    : undefined;
        if (selected === undefined) {
            echo("Usage: map z [auto|levels|projected]");
            return;
        }
        options.zMode = selected;
        echo(`New U/D room placement: ${normalized}`);
    },
    select: (area: string, room?: string) => {
        if (!area) {
            echo("Usage: map select <area> [room]");
            return;
        }

        state.area = null;
        state.room = null;

        let found = mapper.areas.find((a) =>
            a.name.toLowerCase() === area.toLowerCase()
        );
        if (!found) {
            echo(`Area ${area} not found`);
            return;
        }

        state.area = found;

        mapper.setCurrentLocation(found.id, room ? parseInt(room) : null);

        echo(
            `Selected area: ${state.area?.name} [${found.id}]`,
        );

        if (!room) {
            return;
        }

        let foundRoom = state.area.room(parseInt(room));

        if (!foundRoom) {
            echo(`Room not found`);
            return;
        }

        state.room = foundRoom;

        echo(`Selected room: ${foundRoom.title}`);
        echo("Description: ");
        echo(`${foundRoom.description}`);
    },
    off: () => {
        state.state = State.Off;
        state.clearMoveQueue();
        state.possibleRooms = [];
        echo("Mapper turned off");
    },
    follow: () => {
        state.state = State.Following;
        state.clearMoveQueue();
        state.possibleRooms = [];
        echo("Mapper following");
    },
    active: () => {
        state.state = State.Active;
        state.clearMoveQueue();
        state.possibleRooms = [];
        echo("Mapper active (following; movement opens doors and uses exit commands)");
    },
    debug: (arg?: string) => {
        if (arg?.toLowerCase() === "raw") {
            options.debugRaw = !options.debugRaw;
            echo(`Mapper raw line logging ${options.debugRaw ? "on" : "off"}`);
            return;
        }
        options.debug = arg ? arg.toLowerCase() === "on" : !options.debug;
        echo(`Mapper debug logging ${options.debug ? "on" : "off"}`);
    },
    exit: (...args: string[]) => {
        return exitCommand(args);
    },
    record: () => {
        state.state = State.Mapping;
        state.clearMoveQueue();
        state.possibleRooms = [];
        echo("Mapper recording");
    },
    move: (direction: string) => {
        moveSelected(direction);
    },
    send_link: (nth?: string) => {
        const index = nth === undefined ? 1 : Number(nth);
        if (!Number.isInteger(index) || index < 1) {
            echo("Usage: map send_link [n]  (n is a positive link number, default 1)");
            return;
        }
        sendRoomNotesLink(index);
    },
    refresh: () => {
        if (!state.area) {
            echo("No area selected");
            return;
        }

        const areaId = !state.room && state.state === State.Mapping
            ? state.recordingDestination().area.id : state.area.id;
        let roomNumber = state.room?.roomNumber;
        state.refreshRoomAndArea();
        const selectedRoom = state.room;

        echo("Refreshing the current room");

        state.clearMoveQueue();

        send("look");
        mapEvent.once("room", (room: RoomEvent) => {
            void (async () => {
                echo(`Room: ${room.title}`);
                echo(`Description: ${room.description}`);
                echo(`Exits: ${room.exits}`);

                const currentExits = new Set([
                    ...(selectedRoom?.exits ?? []).map((e) => e.fromDirection),
                ]);
                const createdExits: [Direction, ExitId][] = [];
                await mapper.mutateArea(areaId, async (mutation) => {
                    if (!selectedRoom) {
                        roomNumber = await mutation.createRoom({
                            title: room.title,
                            description: room.description.join("\n"),
                        });
                    } else if (roomNumber !== undefined) {
                        await mutation.updateRoom(roomNumber, {
                            title: room.title,
                            description: room.description.join("\n"),
                        });
                    }

                    for (const exit of parseRoomExitsDetailed(room.exits)) {
                        if (!currentExits.has(exit.direction) && roomNumber !== undefined) {
                            const id = await mutation.createRoomExit(roomNumber, {
                                fromDirection: exit.direction,
                                door: exit.closed ? { state: "closed" } : null,
                            });
                            createdExits.push([exit.direction, id]);
                        }
                    }
                }, { description: "Refresh Arctic room" });
                if (roomNumber === undefined) {
                    throw new Error("map refresh did not resolve a room number");
                }
                state.area = mapper.getAreaById(areaId);
                state.room = state.area.room(roomNumber);
                if (state.room) {
                    await recordObservedDoors(mapper, state.room, parseRoomExitsDetailed(room.exits));
                    state.refreshRoomAndArea();
                    mapper.setCurrentLocation(state.room.areaId, state.room.roomNumber);
                }
                for (const [direction, id] of createdExits) {
                    echo(`Created exit ${direction} (${id})`);
                }
            })().catch((error) => {
                echo(`Map refresh failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        });
    },
};

// Send a (possibly `;`-separated) command string. Raw sends, so exit
// commands can't recursively fire the movement alias.
function sendCommands(commands: string) {
    for (const command of commands.split(";")) {
        const trimmed = command.trim();
        if (trimmed) {
            sendRaw(trimmed + "\n");
        }
    }
}

// Track live door state from the prompt's exit list — (E) means E is closed.
promptEvent.on(({exits}) => {
    state.seenExits = exits === undefined
        ? null
        : new Map(parseRoomExitsDetailed(exits).map((e) => [e.direction, e.closed]));

    if (darkRoomPending) {
        darkRoomPending = false;
        advanceInDark(exits);
    }
});

// A dark room ("It is pitch black.") produces no room block, but the prompt
// that follows still arrives (with an exit list) — finalize the move there.
let darkRoomPending = false;

mapEvent.on("visionFailed", () => {
    darkRoomPending = true;
});

function advanceInDark(visibleExits: string | undefined) {
    const direction = state.popMoveCommand();

    if (state.state === State.Off) {
        return;
    }

    debugLog(`dark room: direction=${direction ?? "(none)"}, mode=${State[state.state]}`);

    if (!direction || direction === "look") {
        return;
    }

    // Rooms reachable in `direction` from any currently-possible room
    const sources = state.possibleRooms.length > 0
        ? state.possibleRooms
        : (state.room ? [state.room] : []);
    const targets: Room[] = [];
    for (const p of sources) {
        for (const e of p.exits) {
            if ((p.hasTag("SPIN") || e.fromDirection === direction) && e.toRoomNumber && e.toAreaId) {
                if (targets.some((t) => t.roomNumber === e.toRoomNumber && idsMatch(t.areaId, e.toAreaId))) {
                    continue;
                }
                const room = mapper.getAreaById(e.toAreaId)?.room(e.toRoomNumber);
                if (room) {
                    targets.push(room);
                }
            }
        }
    }

    // We can't verify title/description in the dark, but the prompt's exit
    // list still narrows things down: prefer targets that have every exit
    // the prompt shows.
    const visibleDirections = parseRoomExits(visibleExits);
    const matchingExits = targets.filter((r) =>
        visibleDirections.every((d) => r.exits.some((e) => e.fromDirection === d)));
    const candidates = matchingExits.length > 0 ? matchingExits : targets;

    if (candidates.length === 0) {
        if (state.state === State.Mapping) {
            echo(`Dark room: nothing mapped ${direction} of here, and there's no title/description to record it with — bring a light.`);
        }
        debugLog(`dark move ${direction}: no mapped exit to follow; tracking lost`);
        state.possibleRooms = [];
        return;
    }

    candidates.sort((a, b) => distanceBetweenRooms(a, state.room) - distanceBetweenRooms(b, state.room));
    state.possibleRooms = candidates;
    state.setCurrentRoom(candidates[0]);
    debugLog(`now at "${candidates[0].title}" (#${candidates[0].roomNumber}) via dark-room exit; ${candidates.length} possible`);
}

/**
 * Active-mode movement: consult the map about the exit we're about to use.
 * Sends the exit's open command first when one applies (its door's
 * `opensWith`, a door mapped closed, or the prompt currently showing the exit
 * parenthesized), then sends the exit's movement command if it has one.
 * Returns true when the movement command was sent in place of the direction.
 */
function activeMove(direction: Direction, alone = false): boolean {
    if (!state.room) {
        return false;
    }

    const exit = state.room.exits.find((e) => e.fromDirection === direction);
    if (!exit) {
        return false;
    }

    // Live state from the latest prompt: true = closed, false = open,
    // undefined = unknown (no prompt data, or a hidden exit).
    const liveClosed = state.seenExits?.get(direction);

    const openCommand = openCommandFor(exit, defaultOpenCommand(exit, DirectionLetter[direction]), liveClosed === true);

    // Skip opening only when the prompt affirmatively shows the exit open.
    if (openCommand && liveClosed !== false) {
        debugLog(`sending open command for ${direction}: ${openCommand}`);
        sendCommands(openCommand);
    }

    // Explicit solo movement keeps the typed direction and modifier. A custom
    // exit command may have different arguments and cannot stand in for it.
    if (exit.command && !alone) {
        debugLog(`sending exit command for ${direction} instead of moving: ${exit.command}`);
        sendCommands(exit.command);
        return true;
    }

    return false;
}

const directionCommands = Object.keys(MoveCommands).filter(command => MoveCommands[command] !== "look");
const lookCommands = Object.keys(MoveCommands).filter(command => MoveCommands[command] === "look");
createAlias(
    `^(?:(?<direction>${directionCommands.join("|")})(?:[ \\t]+(?<alone>a|al|alo|alon|alone))?|(?<look>${lookCommands.join("|")}))[ \\t]*$`,
    ({ direction, look, alone }: Matches) => {
        const intent = MoveCommands[direction || look];

        state.captureMoveCommand(intent);
        debugLog(`move captured: ${intent} (queue ${state.moveQueue.length})`);

        if (state.state === State.Active && intent !== "look" && activeMove(intent, !!alone)) {
            // the exit's command went out instead — swallow the typed direction
            return;
        }

        capture(false);
    },
    { name: "mapper_captureMovements" },
);

createTrigger(
    /^You follow [a-zA-Z']+ (?<dir>\w+)\.$/,
    ({ dir }: Matches) => {
        state.captureMoveCommand(MoveCommands[dir as keyof typeof MoveCommands], true);
        debugLog(`follow move captured: ${dir}`);
    },
    { name: "mapper_captureFollowMove" },
);

mapEvent.on("moveFailed", () => {
    state.popMoveCommand();
});

function offsetDirection(room: Room, direction: Direction) {
    const offset = options.moveCoordinates[direction];
    return {
        x: room.x + offset[0],
        y: room.y + offset[1],
        level: room.level + offset[2],
    };
}

const PROPOSED_ROOM_ID = "$arctic:new-room";

function elevationPreference(): ElevationPreference {
    return options.zMode === ZMode.Auto
        ? "auto"
        : options.zMode === ZMode.Normal ? "levels" : "projected";
}

async function applyLayoutMoves(
    areaId: AreaId,
    result: Pick<AreaChangePlan, "patch">,
    mutation?: AreaMutator,
): Promise<void> {
    const updates: [RoomNumber, UpdateRoomParams][] = result.patch.moves.map((move) => {
        if (move.roomNumber === undefined) {
            throw new Error(`layout move ${move.id} has no Smudgy room number`);
        }
        return [move.roomNumber, {
            x: move.to.x,
            y: move.to.y,
            level: move.to.level,
        }];
    });
    if (updates.length > 0) {
        if (mutation) await mutation.updateRooms(updates);
        else await mapper.updateRooms(areaId, updates);
    }
}

function matchingRoomsWithReciprocalStub(
    source: Room,
    title: string,
    description: string,
    direction: Direction,
    areaId: AreaId = source.areaId,
): Room[] {
    const reciprocalDirection = OppositeDirection[direction];
    return mapper.listRoomsByTitleAndDescription(title, description)
        .filter((room): room is Room => !!room)
        .filter((room) => room.areaId === areaId &&
            (room.areaId !== source.areaId || room.roomNumber !== source.roomNumber))
        .filter((room) => room.exits.some((exit) =>
            exit.fromDirection === reciprocalDirection && exit.toRoomNumber === null
        ))
        .sort((a, b) => a.roomNumber - b.roomNumber);
}

async function reflowAndConnectExistingRoom(
    source: Room,
    destinationRoomNumber: RoomNumber,
    direction: Direction,
    destination: ReturnType<typeof state.recordingDestination>,
): Promise<void> {
    if (source.areaId !== destination.area.id) {
        const target = destination.area.room(destinationRoomNumber);
        if (!target) throw new Error("The room to connect is no longer available.");
        await linkRecordingRooms(source, target, direction, destination.place);
        state.setCurrentRoom(target);
        return;
    }
    const result = await planAreaChange(source.areaId, {
        type: "connect-rooms",
        from: source.roomNumber,
        to: destinationRoomNumber,
        direction: direction as LayoutDirection,
        elevation: elevationPreference(),
    });
    await applyLayoutMoves(source.areaId, result);

    const reflowedArea = mapper.getAreaById(source.areaId);
    const reflowedSource = reflowedArea.room(source.roomNumber);
    const reflowedDestination = reflowedArea.room(destinationRoomNumber);
    if (!reflowedSource || !reflowedDestination) {
        throw new Error("a room disappeared while reflowing an existing connection");
    }

    await linkRecordingRooms(reflowedSource, reflowedDestination, direction, destination.place);
    state.setCurrentRoom(reflowedDestination);
    echo(`Reflowed and connected ${direction} to ${reflowedDestination.title} (#${reflowedDestination.roomNumber}).`);
}

async function linkRecordingRooms(from: Room, to: Room, direction: Direction, place: MapPlace) {
    const reverse = OppositeDirection[direction];
    await extendRecordedExit(mapper, from, place, {
        fromDirection: direction, toDirection: reverse, toAreaId: to.areaId, toRoomNumber: to.roomNumber,
    });
    await extendRecordedExit(mapper, to, place, {
        fromDirection: reverse, toDirection: direction, toAreaId: from.areaId, toRoomNumber: from.roomNumber,
    });
}

function measureRecordingLayout(model: LayoutModel): LayoutQuality {
    return measureIntegralLayoutQuality(new Map(model.rooms.map(room => [room.id, room.position])), model.edges);
}

/** Compare defects only: adding a clean room naturally increases footprint and link length. */
function recordingLayoutScore(quality: LayoutQuality): number {
    const levels = quality.levelViolations ?? 0;
    return DIRECTIONAL_VIOLATION_WEIGHT * (quality.cardinalRayViolations - levels)
        + LEVEL_VIOLATION_WEIGHT * levels + quality.routingViolations + quality.linkCrossings;
}

/** Place along the intended ray without moving residents or invoking the planner. */
function unadjustedRoomPatch(model: LayoutModel, from: string, direction: Direction): LayoutPatch {
    const source = model.rooms.find(room => room.id === from);
    if (!source) throw new Error("The room we left is no longer available for recording.");
    const [x, y, level] = options.moveCoordinates[direction];
    let step = { x, y, level };
    if (direction === Direction.Up || direction === Direction.Down) {
        const preference = elevationPreference();
        const style = preference === "auto" ? inferElevationPreference(model, from) : preference;
        step = style === "projected" ? chooseProjectedConstraint(model, from, direction)
            : { x: 0, y: 0, level: direction === Direction.Up ? 1 : -1 };
    }
    const occupied = new Set(model.rooms.map(room => `${room.position.x},${room.position.y},${room.position.level}`));
    let position = { ...source.position };
    do {
        position = { x: position.x + step.x, y: position.y + step.y, level: position.level + step.level };
    } while (occupied.has(`${position.x},${position.y},${position.level}`));
    return { moves: [], placements: [{ id: PROPOSED_ROOM_ID, position }] };
}

async function createNewRoomInDirection(
    roomEvent: RoomEvent,
    direction: Direction,
    destination: ReturnType<typeof state.recordingDestination>,
): Promise<ExitId[]> {
    const prevRoom = state.room;
    const areaId = destination.area.id;

    if (!prevRoom || !areaId) {
        echo("No current room, cannot create new room");
        return [];
    }

    // Refuse an ambiguous entrance before committing a room in another place.
    // The allocator still chooses the actual room number inside the mutation.
    linkCandidate(prevRoom, {
        fromDirection: direction, toAreaId: areaId,
        toRoomNumber: destination.area.nextRoomNumber,
    });

    // Across places, include only a fixed reference to the source. It is never
    // persisted, and the planner must not move the destination's existing rooms.
    const crossingPlaces = prevRoom.areaId !== areaId;
    const entryId = "$arctic:entry";
    const snapshot = loadLayoutModel(areaId);
    const model: LayoutModel = crossingPlaces ? {
        ...snapshot,
        rooms: [...snapshot.rooms, { id: entryId, movable: false,
            position: { x: prevRoom.x, y: prevRoom.y, level: prevRoom.level } }],
    } : snapshot;
    const change = {
        type: "add-room",
        from: crossingPlaces ? entryId : String(prevRoom.roomNumber),
        direction: direction as LayoutDirection,
        temporaryId: PROPOSED_ROOM_ID,
        elevation: elevationPreference(),
    } as const;
    let layout: Pick<AreaChangePlan, "patch"> = { patch: unadjustedRoomPatch(model, change.from, direction) };
    if (options.autoAdjustMapLayout) {
        const after = materializePlannedLayoutModels(model, change, {}, layout.patch).after;
        const quality = measureRecordingLayout(after);
        const beforeScore = recordingLayoutScore(measureRecordingLayout(model));
        const afterScore = recordingLayoutScore(quality);
        if (afterScore > beforeScore) {
            debugLog(`new room worsens layout defect score ${beforeScore} -> ${afterScore}; planning adjustment`);
            const adjusted: AreaChangePlan = crossingPlaces ? planLayoutModel(model, change, { allowExistingMoves: false })
                : await planAreaChange(areaId, change, { includeSnapshotKeys: true });
            // The Worker can yield to a checkbox change or an edit in another
            // session. Rebuild the simple fallback from live coordinates, and
            // apply the adjustment only to the snapshot it was planned against.
            const currentModel = crossingPlaces ? model : loadLayoutModel(areaId);
            layout = { patch: unadjustedRoomPatch(currentModel, change.from, direction) };
            const currentQuality = crossingPlaces ? quality : measureRecordingLayout(
                materializePlannedLayoutModels(currentModel, change, {}, layout.patch).after);
            const currentScore = crossingPlaces ? beforeScore : recordingLayoutScore(measureRecordingLayout(currentModel));
            const snapshotMatches = crossingPlaces || adjusted.sourceSnapshotKey === layoutSnapshotKey(currentModel);
            // Both candidates contain the new room, so the full quality ordering
            // is meaningful here. Keep the simple placement unless planning improves it.
            if (options.autoAdjustMapLayout && snapshotMatches && recordingLayoutScore(currentQuality) > currentScore
                && compareLayoutQuality(adjusted.quality, currentQuality) > 0) layout = adjusted;
        }
    }
    const placement = layout.patch.placements.find((value) => value.id === PROPOSED_ROOM_ID);
    if (!placement) throw new Error("layout did not place the new Arctic room");
    // Definitely assigned inside the mutateArea callback before any later use.
    let newRoomNumber!: RoomNumber;
    const exitIds: ExitId[] = [];
    let deferredLink: ExitArgs & { toAreaId: AreaId; toRoomNumber: RoomNumber } | undefined;
    await mapper.mutateArea(areaId, async (mutation) => {
        await applyLayoutMoves(areaId, layout, mutation);
        newRoomNumber = await mutation.createRoom({
            ...placement.position,
            title: roomEvent.title,
            description: roomEvent.description.join("\n"),
        });

        const forward = {
            fromDirection: direction,
            toDirection: OppositeDirection[direction],
            toAreaId: areaId,
            toRoomNumber: newRoomNumber,
        };
        if (prevRoom.areaId !== areaId || linkNeedsOtherPlace(prevRoom, forward)) deferredLink = forward;
        else exitIds.push(await extendExit(mutation, prevRoom, forward));
        exitIds.push(await mutation.createRoomExit(newRoomNumber, {
            fromDirection: OppositeDirection[direction],
            toDirection: direction,
            toAreaId: prevRoom.areaId,
            toRoomNumber: prevRoom.roomNumber,
            door: parseRoomExitsDetailed(roomEvent.exits).find(exit => exit.direction === OppositeDirection[direction])?.closed
                ? { state: "closed" } : null,
        }));
        for (const exit of parseRoomExitsDetailed(roomEvent.exits)) {
            if (exit.direction !== OppositeDirection[direction]) {
                exitIds.push(await mutation.createRoomExit(newRoomNumber, {
                    fromDirection: exit.direction,
                    door: exit.closed ? { state: "closed" } : null,
                }));
            }
        }
    }, { description: "Map Arctic room and exits" });
    if (deferredLink) {
        // The new room must exist before another place's attachment can name it.
        // Updating the existing exit routes to that place without copying its door.
        exitIds.push(await extendRecordedExit(mapper, prevRoom, destination.place, deferredLink));
    }

    state.area = mapper.getAreaById(areaId);
    state.room = state.area.room(newRoomNumber)!;
    return exitIds;
}

async function handleRoomEvent(roomEvent: RoomEvent) {
    const direction = state.popMoveCommand();

    if (state.state === State.Off) {
        return;
    }

    debugLog(`room event: "${roomEvent.title}" (exits "${roomEvent.exits}"), direction=${direction ?? "(none)"}, mode=${State[state.state]}`);

    const eventRoomDescription = roomEvent.description.join("\n");

    if (state.state === State.Mapping && state.room && state.area) {
        if (!direction || direction === "look") {
            return;
        }

        state.refreshRoomAndArea();

        // first, let's see if the map already links to a room in the direction we just moved

        const existingLink = state.room.exits.find((e) => e.fromDirection === direction && !!e.toRoomNumber);
        if (existingLink) {
            const linkedRoomArea = mapper.getAreaById(existingLink.toAreaId);
            const linkedRoom = linkedRoomArea.room(existingLink.toRoomNumber);

            if (linkedRoom?.title === roomEvent.title && linkedRoom?.description === eventRoomDescription) {
                state.area = linkedRoomArea;
                state.room = linkedRoom;
                mapper.setCurrentLocation(existingLink.toAreaId, existingLink.toRoomNumber);
                debugLog(`followed existing link ${direction} to "${linkedRoom.title}" (#${linkedRoom.roomNumber})`);
                return;
            } else {
                echo(`Room ${roomEvent.title} already exists in the map, but with different description, or title, doing nothing.`);
                return;
            }
        }

        // we haven't managed to follow a link to the target, but let's see if there's a room in the vicinity we would map towards.
        // if so, let's see if it's a match

        const movedToCoordinates = offsetDirection(state.room, direction);
        const destination = state.recordingDestination();

        const roomsAtTarget = findRoomsAt(movedToCoordinates.x, movedToCoordinates.y, movedToCoordinates.level, destination.area);

        const matchingRoom = roomsAtTarget.find((room) =>
            room.title === roomEvent.title && room.description === eventRoomDescription
        );

        if (matchingRoom) {
            echo(`Found not-yet-linked room ${matchingRoom.title} at ${movedToCoordinates.x}, ${movedToCoordinates.y}, ${movedToCoordinates.level}, linking...`);
            await linkRecordingRooms(state.room, matchingRoom, direction, destination.place);
            state.setCurrentRoom(matchingRoom);
            return;
        }

        if (roomsAtTarget.length > 0) {
            const occupants = roomsAtTarget.map((room) => room.title).join(", ");
            echo(`Target cell ${movedToCoordinates.x}, ${movedToCoordinates.y}, ${movedToCoordinates.level} is occupied by ${occupants}; finding a free position for the new room.`);
        }

        const sourceRoom = state.room;
        const existingCandidates = matchingRoomsWithReciprocalStub(
            sourceRoom,
            roomEvent.title,
            eventRoomDescription,
            direction,
            destination.area.id,
        );
        if (existingCandidates.length > 0) {
            const decision = await requestExistingRoomConnection(
                roomEvent.title,
                existingCandidates.map((room) => ({
                    roomNumber: room.roomNumber,
                    x: room.x,
                    y: room.y,
                    level: room.level,
                })),
                sourceRoom.areaId === destination.area.id,
            );
            if (decision.type === "connect") {
                await reflowAndConnectExistingRoom(sourceRoom, decision.roomNumber, direction, destination);
                return;
            }
        }

        echo(`Creating new room in direction ${direction}`);

        await createNewRoomInDirection(roomEvent, direction, destination);

        state.refreshRoomAndArea();
        mapper.setCurrentLocation(state.area.id, state.room.roomNumber);
    } else if (state.state === State.Following || state.state === State.Active) {
        const incomingExits = parseRoomExits(roomEvent.exits);

        // Where we might currently be. When there's no live ambiguity set yet
        // (e.g. the first move right after `map follow`), fall back to the known
        // current room so the move still has a basis — mirroring the dark-room
        // handler. Without this, the first move always missed the reachable check
        // and fell through to the global match.
        const sources = state.possibleRooms.length > 0
            ? state.possibleRooms
            : (state.room ? [state.room] : []);

        // Did the move we just made (`direction`) lead from a possible room `p` to
        // candidate `r`? True when `p` has a mapped exit that way to `r` — or, for a
        // SPIN room, any of its exits, since those scramble the direction you leave by.
        const reachedByMove = (p: Room, r: Room): boolean =>
            p.exits.some((e) =>
                (p.hasTag("SPIN") || e.fromDirection === direction) &&
                e.toRoomNumber == r.roomNumber && idsMatch(e.toAreaId, r.areaId));

        // Rooms reachable from any source by the move we just made. Without a
        // directional move (look, or an unexpected room), we haven't gone
        // anywhere: "reachable" means the room is already one of the sources.
        const reachableFromPossible = (rooms: Room[]) => {
            if (!direction || direction === "look") {
                return rooms.filter(r => sources.some(p =>
                    p.roomNumber === r.roomNumber && idsMatch(p.areaId, r.areaId)));
            }
            return rooms.filter(r => sources.some(p => reachedByMove(p, r)));
        };

        // After a real directional move we have certainly LEFT the room we were in,
        // so it cannot be where we are now. This is the crux of the identical-rooms
        // stall: among equal-looking rooms the current one sits at distance 0, so
        // unless we drop it the sort below re-picks it every move and tracking never
        // advances. Two exceptions keep it eligible: a `look` (no move — we haven't
        // gone anywhere), and a room that links back to itself in the direction we
        // moved (a self-loop, where staying put is the correct outcome).
        const here = (direction && direction !== "look") ? state.room : null;
        const selfLoops = here !== null && here.exits.some((e) =>
            (here.hasTag("SPIN") || e.fromDirection === direction) &&
            e.toRoomNumber === here.roomNumber && idsMatch(e.toAreaId, here.areaId));
        const justLeft = selfLoops ? null : here;
        const stillEligible = (r: Room) => !justLeft
            || !(r && r.roomNumber === justLeft.roomNumber && idsMatch(r.areaId, justLeft.areaId));

        // Adopt the nearest candidate as the current room; the full set stays in
        // possibleRooms until a later move disambiguates.
        const pickRoom = (rooms: Room[], stage: string): boolean => {
            const pool = rooms.filter(stillEligible);
            if (pool.length === 0) {
                return false;
            }
            pool.sort((a, b) => distanceBetweenRooms(a, state.room) - distanceBetweenRooms(b, state.room));
            state.possibleRooms = pool;
            state.setCurrentRoom(pool[0]);
            debugLog(`now at "${pool[0].title}" (#${pool[0].roomNumber}) via ${stage}; ${pool.length} possible`);
            return true;
        };

        const candidateRoomsWithMatchingExits = mapper.listRoomsByTitleDescriptionAndVisibleExits(roomEvent.title, eventRoomDescription, incomingExits);

        if (pickRoom(reachableFromPossible(candidateRoomsWithMatchingExits), "reachable exits-match")) {
            return;
        }

        const candidateRooms = mapper.listRoomsByTitleAndDescription(roomEvent.title, eventRoomDescription);

        if (pickRoom(reachableFromPossible(candidateRooms), "reachable title/desc")) {
            return;
        }

        // Nothing reachable matched — we're lost; fall back to the best global match,
        // preferring candidates whose exits agree with what we can see.
        if (pickRoom(candidateRoomsWithMatchingExits, "global exits-match")) {
            return;
        }

        if (pickRoom(candidateRooms, "global title/desc")) {
            return;
        }

        // Nothing anywhere matches the room we just saw — we've stepped off the
        // mapped world. Stop claiming we're in the old room: clear the current
        // room (keeping the area as a hint) so the map shows no location until we
        // walk back onto something it knows.
        debugLog(`no match: exits-match=${candidateRoomsWithMatchingExits.length}, title/desc=${candidateRooms.length}, sources=${sources.length}; leaving current room`);
        state.room = null;
        state.possibleRooms = [];
        if (state.area) {
            mapper.setCurrentLocation(state.area.id);
        }
    }
}

let mapUpdateQueue = Promise.resolve();
mapEvent.on("room", (roomEvent: RoomEvent) => {
    mapUpdateQueue = mapUpdateQueue
        .then(() => handleRoomEvent(roomEvent))
        .then(async () => {
            const room = state.room;
            if (state.state === State.Mapping && room?.title === roomEvent.title
                && room.description === roomEvent.description.join("\n")) {
                await recordObservedDoors(mapper, room, parseRoomExitsDetailed(roomEvent.exits));
                state.refreshRoomAndArea();
            }
        })
        .then(() => hintShortcut(roomEvent))
        .catch((error) => {
            echo(`Automatic map update failed: ${error instanceof Error ? error.message : String(error)}`);
        });
});
