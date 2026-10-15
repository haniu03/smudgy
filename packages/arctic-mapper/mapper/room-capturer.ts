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
import { createTriggers, echo, line, type Matches } from "smudgy:core";

import promptEvent from 'smudgy:events/kapusniak/arctic-prompt/prompt';

const snip = (s: string) => s.length > 60 ? `${s.slice(0, 60)}…` : s;

const ESC = String.fromCharCode(27);
const visualizeEscapes = (s: string) => s.split(ESC).join("\\e");

// A prompt fragment can be delivered again as the prefix of the next complete
// line. Match its HP anchor and terminator while allowing any optional fields
// and color runs between them, just as arctic-prompt does for displayed text.
const PROMPT_PREFIX = /^(?:�|\x1b\[[0-9;]*m)*-?\d+H\b[^>\r\n]*>[ \t]*/;
const SGR = /\x1b\[[0-9;]*m/g;
const TITLE_PATTERNS = [
  // A preceding color run may leave a reset, or a GA may leave replacement
  // characters, before the cyan, purple, or bright-green room title.
  /^(?:�)*(?:\x1b\[0;37m)?\x1b\[36m(?<roomName>.*)\x1b\[0;37m$/,
  /^(?:�)*(?:\x1b\[0;37m)?\x1b\[35m(?<roomName>[^\x1b]*)\x1b\[0;37m$/,
  /^(?:�)*(?:\x1b\[0;37m)?\x1b\[32m\x1b\[1m(?<roomName>[^\x1b]*)\x1b\[0;37m$/,
];
const BODY_PATTERNS = [
  /^(?<roomDescLine>[^\x1b]+)$/,
  /^(\x1b\[33m\x1b\[1m)?\x1b\[0;37m\x1b\[31m\x1b\[1m(?<mobLine>.*)$/,
  /^\x1b\[33m\x1b\[1m(?<objectLine>.*)$/,
];

createTriggers({
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
  roomPrompt: {
    rawPatterns: [PROMPT_PREFIX],
    prompt: true,
    script: ({ 0: raw }) => { consumePrompt(raw); },
  },
  roomLine: {
    rawPatterns: [/^(?<raw>.*)$/],
    script: ({ raw }) => onRoomLine(raw),
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

// Use the provider as well, including prompts recognized by future versions.
// Its event may arrive after the raw line (or after a newer room has begun).
promptEvent.on(finishRoom);

function finishRoom({ lineNumber, raw, exits }: { lineNumber: number; raw: string; exits?: string }) {
  if (!sawRoom || lineNumber <= roomNameLineNumber) {
    return;
  }
  sawRoom = false;
  bodyStarted = false;

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
}

function consumePrompt(raw: string): string {
  const prefix = PROMPT_PREFIX.exec(raw)?.[0];
  if (prefix) {
    const prompt = prefix.replace(SGR, "").replace(/^�+/, "");
    const exits = /\bExits:([NESWUD()]*)>/.exec(prompt)?.[1];
    finishRoom({ lineNumber: line.number, raw: prompt, exits });
    return raw.slice(prefix.length);
  }
  return raw;
}

function onRoomLine(raw: string) {
  // Only complete lines contribute title/body text. Idle fragments may be
  // replayed with more text later; the prompt-only trigger handles those.
  raw = consumePrompt(raw);

  for (const pattern of TITLE_PATTERNS) {
    const match = pattern.exec(raw);
    if (match?.groups) {
      onRoomTitle(match.groups.roomName);
      return;
    }
  }
  if (!sawRoom) return;
  for (const pattern of BODY_PATTERNS) {
    const match = pattern.exec(raw);
    if (match?.groups) {
      onRoomDesc(match.groups);
      return;
    }
  }
}

// Comms (tells, shouts) are colored identically to room titles; a line with
// a comm verb is never a title.
const COMM_OPENER = /^You (tell|shout)\b|tells you '|tells your group '|tells your clan '|shouts '/;

// True once the room body (description/objects/mobs) has started arriving.
// Within one prompt window there is only ever one room, so a title-colored
// line after the body began is mob chatter, not a new title.
let bodyStarted = false;

function onRoomTitle(text: string) {
  if (COMM_OPENER.test(text) || /^-*$/.test(text) || text === "Mortals") {
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
  sawRoom = true;
  bodyStarted = false;
  roomNameLineNumber = line.number;
}

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
  }
}
