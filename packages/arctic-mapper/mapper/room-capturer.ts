// deno-lint-ignore-file no-control-regex

enum RoomState {
  DESCRIPTION,
  OBJECTS,
  MOBS,
}

let roomTitle = "";
let roomDesc: string[] = [];
let roomObjects: string[] = [];
let roomMobs: string[] = [];
let state = RoomState.DESCRIPTION;
let sawRoom = false;
let roomNameLineNumber = 0;

import { mapEvent } from "./events.ts";
import { debugLog, options } from "./mapper.ts";
import { createTriggers, echo, line, Matches } from "smudgy:core";

import promptEvent from 'smudgy:events/kapusniak/arctic-prompt/prompt';

const snip = (s: string) => s.length > 60 ? `${s.slice(0, 60)}…` : s;

const ESC = String.fromCharCode(27);
const visualizeEscapes = (s: string) => s.split(ESC).join("\\e");

const triggers = createTriggers({
  // `map debug raw` dump: every line with its escape sequences made visible.
  rawDebug: {
    rawPatterns: [/^(?<raw>.*)$/],
    prompt: true,
    script: ({ raw }) => {
      if (!options.debugRaw || raw.startsWith("[raw]") || raw.startsWith("[mapper]")) {
        return;
      }
      echo(`[raw] ${visualizeEscapes(raw)}`);
    },
  },
  roomTitle: {
    rawPatterns: [
        // Room titles arrive as dark cyan, dark purple, or bright green. A
        // preceding color run (e.g. a tell) closes at the START of the next
        // line, leaving its reset on the front of the title - so allow an
        // optional leading reset.
        //
        // With `prompt ga` and `prompt newline` both on, the prompt's trailing
        // IAC GA is flushed onto the FRONT of the following line - the title -
        // arriving as one or more U+FFFD replacement chars, so also allow an
        // optional leading run of those.
        /^(?:�)*(?:\u001b\[0;37m)?\u001b\[36m(?<roomName>.*)\u001b\[0;37m$/,
        /^(?:�)*(?:\u001b\[0;37m)?\u001b\[35m(?<roomName>[^\u001b]*)\u001b\[0;37m$/,
        /^(?:�)*(?:\u001b\[0;37m)?\u001b\[32m\u001b\[1m(?<roomName>[^\u001b]*)\u001b\[0;37m$/
    ],
    antiPatterns: [
      /^-*$/,
      /^Mortals$/,
      /shouts '.*'$/,
      /tells your group '.*'$/,
      /tells your clan '.*'$/,
    ],
    script: onRoomTitle,
  },
  roomDesc: {
    rawPatterns: [
      /^(?<roomDescLine>[^\u001b]+)$/,
      /^(\x1b\[33m\x1b\[1m)?\x1b\[0;37m\x1b\[31m\x1b\[1m(?<mobLine>.*)$/,
      /^\x1b\[33m\x1b\[1m(?<objectLine>.*)$/,
      /^(?<notARoomDescLine>.*)$/,
    ],
    enabled: false,
    script: onRoomDesc,
  },
  visionFailed: {
    patterns: [
      /^It is pitch black\.$/
    ],
    script: () => {
      debugLog("vision failed");
      mapEvent.emit("visionFailed");
    }
  },
  moveFailed: {
    patterns: [
      /^You are too exhausted.$/,
      /^Alas, you cannot go that way\.\.\.$/,
      /^You can't seem to move without a boat\.$/,
      /^The [a-z]+ seems to be closed\.$/,
      /^Come on! I'm relaxing!$/,
      /^[A-Za-z]+ is blocking you\.$/
    ],
    script: () => {
      debugLog("move failed");
      mapEvent.emit("moveFailed");
    }
  }
});

// A prompt terminates a room block: snapshot what we captured and emit it.
promptEvent.on(({lineNumber, raw, exits}) => {
  bodyStarted = false;

  if (!sawRoom) {
    return;
  }
  sawRoom = false;
  triggers.roomDesc.enabled = false;

  const room = {
    title: roomTitle,
    description: roomDesc,
    objects: roomObjects,
    mobs: roomMobs,
    line_number: roomNameLineNumber,
    prompt_line_number: lineNumber,
    prompt: raw,
    exits: exits ?? "",
  };

  debugLog(`room captured: "${snip(roomTitle)}" (${roomDesc.length} desc, ${roomObjects.length} obj, ${roomMobs.length} mob lines, exits "${room.exits}")`);

  // Defer so every prompt listener observes pre-move state before the map
  // updates the current room.
  queueMicrotask(() => mapEvent.emit("room", room));
});

// Comms (tells, shouts) are colored identically to room titles; a line with
// a comm verb is never a title.
const COMM_OPENER = /^You (tell|shout)\b|tells you '|tells your group '|tells your clan '|shouts '/;

// True once the room body (description/objects/mobs) has started arriving.
// Within one prompt window there is only ever one room, so a title-colored
// line after the body began is mob chatter, not a new title.
let bodyStarted = false;

// deno-lint-ignore no-explicit-any
function onRoomTitle(matches: any) {
  const text: string = matches.roomName;

  if (COMM_OPENER.test(text)) {
    debugLog(`ignored comm line: "${snip(text)}"`);
    return;
  }

  if (sawRoom && bodyStarted) {
    debugLog(`ignored title-colored line after body: "${snip(text)}"`);
    return;
  }

  if (sawRoom) {
    debugLog(`title candidate replaced: "${snip(roomTitle)}" -> "${snip(text)}"`);
  } else {
    debugLog(`title candidate: "${snip(text)}"`);
  }

  // The last title-colored line before the body wins; earlier candidates
  // (e.g. wrapped comm fragments with no verb on them) are forgotten.
  roomTitle = text;
  roomDesc = [];
  roomObjects = [];
  roomMobs = [];
  state = RoomState.DESCRIPTION;
  triggers.roomDesc.enabled = true;
  sawRoom = true;
  bodyStarted = false;
  roomNameLineNumber = line.number;
}

// deno-lint-ignore no-explicit-any
function onRoomDesc(matches: Matches) {
  const matched = new Set(Object.keys(matches));
  if (matched.has("roomDescLine")) {
    bodyStarted = true;
    if (state == RoomState.DESCRIPTION) {
      roomDesc.push(matches.roomDescLine);
    } else if (state == RoomState.OBJECTS) {
      roomObjects.push(matches.roomDescLine);
    } else if (state == RoomState.MOBS) {
      roomMobs.push(matches.roomDescLine);
    }
  } else if (matched.has("objectLine")) {
    bodyStarted = true;
    roomObjects.push(matches.objectLine);
    state = RoomState.OBJECTS;
  } else if (matched.has("mobLine")) {
    bodyStarted = true;
    roomMobs.push(matches.mobLine);
    state = RoomState.MOBS;
  } else if (matched.has("notARoomDescLine")) {
    return;
  }
}
