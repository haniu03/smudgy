import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mapEvent, type RoomEvent } from "./events.ts";

// Replay incoming lines through the registered trigger scripts, with only the
// Smudgy host and cross-package prompt event replaced by test doubles.
let fixtureId = 0;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes("/room-capturer.ts?")) {
      const name = specifier === "smudgy:core" ? "core"
        : specifier === "./mapper.ts" ? "mapper"
        : specifier === "smudgy:events/kapusniak/arctic-prompt/prompt" ? "prompt" : null;
      if (name) return { url: `capture-test:${name}/${fixtureId}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("capture-test:")) {
      const name = url.slice("capture-test:".length).split("/")[0];
      const source = name === "prompt"
        ? "export default globalThis.__roomCaptureTest.prompt;"
        : Object.keys(globalThis.__roomCaptureTest[name]).map(key =>
          `export const ${key} = globalThis.__roomCaptureTest.${name}.${key};`).join("\n");
      return { format: "module", source, shortCircuit: true };
    }
    if (url.includes("/room-capturer.ts?")) {
      return { format: "module", shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" }) };
    }
    return next(url, context);
  },
});

const promptRaw = "\x1b[32m\x1b[0;37m\x1b[32m358H \x1b[0;37m\x1b[32m92V \x1b[0;37m48154836X 41.86% 12875C [Att:0.00%] \x1b[0;37mT:28 Exits:N> ";
const title = (text: string) => `\x1b[36m${text}\x1b[0;37m`;

async function capture() {
  let triggers: Record<string, any> = {};
  let nextLineNumber = 1;
  const listeners: Function[] = [], rooms: RoomEvent[] = [], logs: string[] = [];
  const line = { number: 0, text: "", raw: "" };
  globalThis.__roomCaptureTest = {
    core: { line, echo: (text: string) => logs.push(text), createTriggers: (spec: typeof triggers) => {
      triggers = spec;
      return triggers;
    } },
    mapper: { options: { debugRaw: false }, debugLog: (text: string) => logs.push(text) },
    prompt: { on: (listener: Function) => listeners.push(listener) },
  };
  mapEvent.removeAllListeners();
  mapEvent.on("room", room => rooms.push(room));
  await import(`./room-capturer.ts?fixture=${++fixtureId}`);
  return {
    rooms, logs,
    async raw(raw: string, isPrompt = false) {
      line.number = nextLineNumber;
      if (!isPrompt) nextLineNumber++;
      line.raw = raw;
      line.text = raw.replace(/\x1b\[[0-9;]*m/g, "");
      for (const trigger of Object.values(triggers)) {
        if (trigger.enabled === false || (isPrompt && !trigger.prompt)) continue;
        if (trigger.antiPatterns?.some((pattern: RegExp) => pattern.test(line.text))) continue;
        for (const pattern of trigger.rawPatterns ?? trigger.patterns ?? []) {
          const match = pattern.exec(trigger.rawPatterns ? raw : line.text);
          if (match) { trigger.script({ ...match, ...match.groups }); break; }
        }
      }
      await Promise.resolve();
    },
    async prompt(raw = promptRaw, exits = "N", lineNumber = line.number) {
      for (const listener of listeners) listener({ lineNumber, raw, exits });
      await Promise.resolve();
    },
  };
}

test("captures a standalone title and its description", async () => {
  const h = await capture();
  await h.raw(title("The Reception"));
  await h.raw("    This is the reception of the lodge.");
  await h.prompt();
  assert.equal(h.rooms.length, 1);
  assert.equal(h.rooms[0].title, "The Reception");
  assert.deepEqual(h.rooms[0].description, ["    This is the reception of the lodge."]);
});

test("captures a room title appended to the previous prompt", async () => {
  const h = await capture();
  await h.raw(promptRaw + title("The Reception"));
  await h.raw("    This is the reception of the lodge.");
  await h.prompt();
  assert.equal(h.rooms.length, 1, "the prompt prefix must not hide the title");
  assert.equal(h.rooms[0].title, "The Reception");
  assert.deepEqual(h.rooms[0].description, ["    This is the reception of the lodge."]);
});

test("a raw prompt closes the previous room before Alchemical Lab", async () => {
  const h = await capture();
  await h.raw(title("Previous room"));
  await h.raw("    Previous room description.");
  await h.raw(promptRaw, true);
  await h.raw(title("Alchemical Lab"));
  await h.raw("    This is where all the noxious fumes are created.");
  await h.prompt();
  assert.equal(h.rooms.at(-1)?.title, "Alchemical Lab");
  assert.deepEqual(h.rooms.at(-1)?.description, ["    This is where all the noxious fumes are created."]);
});

test("replays The Reception transcript and captures each section exactly once", async () => {
  const h = await capture();
  const description = [
    "    This is the reception of the lodge, where you would sign in for a room.",
    "This is also a very popular place where adventurers sit around and share",
    "tales of their journeys. Some stairs in the back lead up to the quarters.",
  ];
  const objects = ["A pile of worn maps sits in the corner, free to adventurers."];
  const mobs = [
    "The spirit of Zrael, the master of the farm is hovering here.",
    "You see the outline of a life form here, carrying: a radiant pendant; a glowing scroll of recall; a glowing scroll of recall; a rotting wooden staff; a glowing scroll of recall.",
    "The manager of Traveler's Lodge stands here ready to sign you in.",
    "A tall and strong bouncer, hired to protect the lodge's customers, stands here.",
  ];
  await h.raw(promptRaw, true);
  await h.raw(promptRaw + title("The Reception"));
  // A provider notification for the prefix can arrive after its appended title.
  await h.prompt();
  assert.equal(h.rooms.length, 0, "the prefix belongs to the previous room");
  for (const text of description) await h.raw(text);
  await h.raw(`\x1b[33m\x1b[1m${objects[0]}`);
  await h.raw(`\x1b[0;37m\x1b[31m\x1b[1m${mobs[0]}`);
  for (const text of mobs.slice(1)) await h.raw(text);
  await h.raw("\x1b[0;37m");
  const endPrompt = promptRaw.replace("T:28", "T:20");
  await h.raw(endPrompt, true);
  await h.prompt(endPrompt);
  await h.raw(endPrompt); // The same fragment's completed line.
  assert.deepEqual(h.rooms, [{
    title: "The Reception", description, objects, mobs, exits: "N",
    line_number: 1, prompt_line_number: 11,
    prompt: endPrompt.replace(/\x1b\[[0-9;]*m/g, ""),
  }]);
});

test("replays Alchemical Lab without relying on the prompt provider", async () => {
  const h = await capture();
  const labPrompt = "\x1b[32m\x1b[0;37m\x1b[32m385H \x1b[0;37m\x1b[32m225V \x1b[0;37m16214104X 36.54% SC:Order 1207C [Att:10.03%] \x1b[0;37mT:8 Exits:EW> ";
  const description = [
    "    This is where all the noxious fumes are created. There are also many",
    "items of magic scattered about as this also serves as Anatole's store room.",
    "There is a small room to the east.",
  ];
  await h.raw(title("Alchemical Lab"));
  for (const text of description) await h.raw(text);
  await h.raw("\x1b[33m\x1b[1m\x1b[0;37m\x1b[31m\x1b[1mLinus the Alchemist, is here working diligently on a new formula.");
  await h.raw("\x1b[0;37m");
  await h.raw(labPrompt, true);
  await h.raw(labPrompt);
  await h.raw("");
  await h.raw("A Palanthian guard arrives from the west.");
  await h.raw("");
  await h.raw(labPrompt.replace("T:8", "T:7"), true);
  assert.equal(h.rooms.length, 1);
  assert.equal(h.rooms[0].title, "Alchemical Lab");
  assert.deepEqual(h.rooms[0].description, description);
  assert.deepEqual(h.rooms[0].objects, []);
  assert.deepEqual(h.rooms[0].mobs, ["Linus the Alchemist, is here working diligently on a new formula."]);
  assert.equal(h.rooms[0].exits, "EW");
});

test("a prompt prefix separates consecutive rooms and late events cannot close the new one", async () => {
  const h = await capture();
  await h.raw(title("First room"));
  await h.raw("    First description.");
  await h.raw(promptRaw + title("Second room"));
  assert.equal(h.rooms.length, 1);
  assert.equal(h.rooms[0].title, "First room");
  await h.prompt();
  await h.raw("    Second description.");
  await h.prompt(promptRaw, "N", 2); // Delayed older provider event.
  assert.equal(h.rooms.length, 1);
  await h.raw(promptRaw, true);
  assert.equal(h.rooms.length, 2);
  assert.equal(h.rooms[1].title, "Second room");
  assert.deepEqual(h.rooms[1].description, ["    Second description."]);
});

test("provider-first delivery and repeated prompt fragments emit only one room", async () => {
  const h = await capture();
  await h.raw(title("The Reception"));
  await h.raw("    The description.");
  await h.prompt(promptRaw, "N", 3);
  await h.raw(promptRaw, true);
  await h.raw(promptRaw, true);
  await h.raw(promptRaw);
  assert.equal(h.rooms.length, 1);
});

test("partial title and body fragments do not duplicate completed lines", async () => {
  const h = await capture();
  await h.raw(title("The Reception"), true);
  await h.raw(title("The Reception"));
  await h.raw("    A partially received", true);
  await h.raw("    A partially received description.", true);
  await h.raw("    A partially received description.");
  await h.raw(promptRaw, true);
  assert.deepEqual(h.rooms[0].description, ["    A partially received description."]);
});

test("comms and title-colored mob chatter do not replace the room", async () => {
  const h = await capture();
  await h.raw(promptRaw + title("Someone tells you 'hi'"));
  await h.raw(title("Mortals"));
  await h.raw(title("-----"));
  await h.raw(promptRaw, true);
  assert.equal(h.rooms.length, 0);
  await h.raw(title("Wrapped tell fragment"));
  await h.raw(title("Alchemical Lab"));
  await h.raw("    The room description.");
  await h.raw(title("The alchemist chats about potions."));
  await h.raw(promptRaw, true);
  assert.equal(h.rooms.length, 1);
  assert.equal(h.rooms[0].title, "Alchemical Lab");
  assert.deepEqual(h.rooms[0].description, ["    The room description."]);
});

test("prompt-prefixed titles retain all supported colors and closed exits", async () => {
  for (const color of ["\x1b[36m", "\x1b[35m", "\x1b[32m\x1b[1m"]) {
    const h = await capture();
    await h.raw(promptRaw + `��\x1b[0;37m${color}The Reception\x1b[0;37m`);
    await h.raw("    The description.");
    await h.raw("-5H 2V T:0 Exits:(N)EW>", true);
    assert.equal(h.rooms[0].title, "The Reception");
    assert.equal(h.rooms[0].exits, "(N)EW");
  }
});
