// tintin-emulator: type TinTin++ commands at the input line.
//
// One sys:input handler is the command entry point. It runs before smudgy's
// raw-prefix handling and command-separator splitting, so a TinTin command
// line is seen whole: `#alias {k} {kill %1;kick}` must not be shredded at
// `;` before the parser gets it. Lines starting with the command character
// are cancelled and interpreted; everything else passes through. Optional
// SPEEDWALK handling is a low-priority native alias so user aliases win first.
//
// Definitions (#alias, #action, #gag, #highlight, #substitute, #ticker)
// become native smudgy automations, visible in the automations window, and
// persist in this package's vars for replay on the next load.

import { echo, input, getSettings, style } from "smudgy:core";
import { submission } from "smudgy:core";
import { submit } from "smudgy:events/sys";
import { get } from "smudgy:params";
import { asciiPunctuation, parseTinTin, formatDiagnostic, TINTIN_COMMANDS } from "./engine/parse.ts";
import { executeNodes, setDispatcherCommandChar } from "./runtime/dispatcher.ts";
import {
  setCommandChar, replayStored, makeExecutionEnv, syncSpeedwalkAutomation,
} from "./runtime/definitions.ts";
import { echoNote } from "./runtime/output.ts";
import { pathRecordCommand } from "./runtime/paths.ts";

function resolveCommandChar(): string {
  const configured = String(get("commandChar") ?? "#").trim();
  if (!asciiPunctuation(configured)) {
    if (configured !== "") {
      echoNote(`command character ${JSON.stringify(configured)} must be a single punctuation character; using "#"`);
    }
    return "#";
  }
  // The lexer consumes these structurally, so a command line starting with
  // one would be re-split into plain sends after being cancelled.
  if (["{", "}", "\\", ";"].includes(configured)) {
    echoNote(`command character ${JSON.stringify(configured)} is TinTin syntax itself; using "#"`);
    return "#";
  }
  const settings = getSettings();
  if (configured === "=" || configured === settings.commandSeparator ||
    settings.rawLinePrefix.startsWith(configured)) {
    echoNote(`command character ${JSON.stringify(configured)} collides with a reserved input prefix; using "#"`);
    return "#";
  }
  return configured;
}

const commandChar = resolveCommandChar();
setCommandChar(commandChar);
setDispatcherCommandChar(commandChar);
const speedwalk = get("speedwalk") === true;

// Tab completion for every TinTin command spelling.
input.completion.add(...TINTIN_COMMANDS.map((name) => `${commandChar}${name}`));

function runTinTinLine(text: string): void {
  const parsed = parseTinTin(text, { source: "input", commandChar });
  for (const item of parsed.diagnostics) {
    if (item.code === "unknown-command" || item.code === "missing-command") continue;
    echo(style.warn`#NOTE: ${formatDiagnostic(item)}`);
  }
  executeNodes(parsed.nodes, makeExecutionEnv());
}

submit.on(() => {
  const text = submission.text;
  if (!text.startsWith(commandChar)) return;
  // TinTin command lines never reach the MUD; the interpreter decides what
  // (if anything) gets sent.
  submission.cancel();
  runTinTinLine(text);
});

const replayed = replayStored();
syncSpeedwalkAutomation(speedwalk, pathRecordCommand);
if (replayed > 0) {
  echo(style.echo`tintin-emulator restored ${replayed} definition${replayed === 1 ? "" : "s"}. Type ${commandChar}help for the supported commands.`);
}
