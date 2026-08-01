// Engine-layer tests: pure TinTin parsing/pattern/interpolation semantics,
// no smudgy host required. Run with: node --test test/engine.test.ts
// (Node >= 23.6 strips types natively.)

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTinTin, canonicalCommand, nodeArgumentText, bodyFor, discoverFileCommandChar } from "../engine/parse.ts";
import type { CommandNode, SendNode } from "../engine/parse.ts";
import { compileTinTinPattern, jsRegexSource } from "../engine/pattern.ts";
import {
  decodeTinTinOutputEscapes, splitTinTinItems, variablePath, staticTinTinValue,
  parseStyledFragments, highlightStyleOptions, occurrenceByteRanges,
} from "../engine/text.ts";
import { interpolate, evalExpression, evalCondition, stringifyTinTin } from "../engine/eval.ts";
import type { Env } from "../engine/eval.ts";
import { formatTinTin, tinTinStrftime, tinTinListOption } from "../engine/format.ts";
import { tinTinKeySpec } from "../engine/keys.ts";
import {
  defaultPathDirs, expandLegacySpeedwalk, zipPath, unzipPath,
} from "../engine/path.ts";

function fakeEnv(
  variables: Record<string, unknown> = {},
  slots: Record<number, string> = {},
  regexSlots: Record<number, string> = {},
): Env {
  const store: Record<string, unknown> = structuredClone(variables);
  const resolve = (path: string[]): unknown => {
    let value: unknown = store[path[0]];
    for (const selector of path.slice(1)) {
      if (value === null || typeof value !== "object") return undefined;
      value = (value as Record<string, unknown>)[selector];
    }
    return value;
  };
  return {
    getVar: resolve,
    hasVar: (path) => resolve(path) !== undefined,
    setVar: (path, value) => { store[path[0]] = value; },
    deleteVar: (path) => { delete store[path[0]]; },
    sizeVar: (path) => {
      const value = resolve(path);
      if (value === null || value === undefined) return 0;
      if (Array.isArray(value)) return value.length;
      if (typeof value === "object") return Object.keys(value as object).length;
      return 1;
    },
    keyVar: () => "",
    slot: (n) => slots[n],
    regexSlot: (n) => regexSlots[n],
    warn: () => {},
  };
}

// ---- parse -----------------------------------------------------------------

test("commands resolve by first-prefix abbreviation", () => {
  assert.equal(canonicalCommand("ali"), "alias");
  assert.equal(canonicalCommand("a"), "action");
  assert.equal(canonicalCommand("SHOW"), "showme");
  assert.equal(canonicalCommand("zzz"), null);
});

test("parses a definition with a nested body", () => {
  const parsed = parseTinTin("#alias {gt} {guildtell %0}", { commandChar: "#" });
  assert.equal(parsed.nodes.length, 1);
  const node = parsed.nodes[0] as CommandNode;
  assert.equal(node.kind, "command");
  assert.equal(node.name, "alias");
  assert.equal(node.args[0].value, "gt");
  assert.equal(node.args[1].value, "guildtell %0");
  const body = bodyFor(node, 1);
  assert.equal(body.length, 1);
  assert.equal(body[0].kind, "send");
  assert.equal((body[0] as SendNode).text, "guildtell %0");
});

test("semicolons split at depth zero only, and escape", () => {
  const parsed = parseTinTin("#showme hi;say hello", { commandChar: "#" });
  assert.deepEqual(parsed.nodes.map((node) => node.kind), ["command", "send"]);

  const braced = parseTinTin("#alias {two} {say one;say two}", { commandChar: "#" });
  const node = braced.nodes[0] as CommandNode;
  assert.equal(node.args[1].value, "say one;say two");
  assert.equal(bodyFor(node, 1).length, 2);

  const escaped = parseTinTin("say a\\;b", { commandChar: "#" });
  assert.equal(escaped.nodes.length, 1);
});

test("alternate command characters work", () => {
  const parsed = parseTinTin("/showme hi", { commandChar: "/" });
  const node = parsed.nodes[0] as CommandNode;
  assert.equal(node.kind, "command");
  assert.equal(node.name, "showme");
});

test("unbraced if-body consumes the remainder of the command", () => {
  const parsed = parseTinTin("#if {1} #showme yes", { commandChar: "#" });
  const node = parsed.nodes[0] as CommandNode;
  assert.equal(node.name, "if");
  const body = bodyFor(node, 1);
  assert.equal(body.length, 1);
  assert.equal((body[0] as CommandNode).name, "showme");
});

test("multi-line braced arguments fold into one logical command", () => {
  const parsed = parseTinTin("#alias {x}\n{\nsay a;\nsay b\n}", { commandChar: "#" });
  assert.equal(parsed.nodes.length, 1);
  const node = parsed.nodes[0] as CommandNode;
  assert.equal(bodyFor(node, 1).length, 2);
});

test("nodeArgumentText joins unbraced tails", () => {
  const parsed = parseTinTin("#showme hello there world", { commandChar: "#" });
  assert.equal(nodeArgumentText(parsed.nodes[0] as CommandNode, 0), "hello there world");
});

// ---- pattern ---------------------------------------------------------------

test("numbered slots compile to capture groups with a slot map", () => {
  const compiled = compileTinTinPattern("%1 tells you %2");
  assert.equal(compiled.source, "(.*?) tells you (.*)");
  assert.deepEqual(compiled.captureMap, { "1": 1, "2": 2 });
  assert.equal(compiled.unsupported, false);
});

test("typed atoms and case modes compile", () => {
  assert.equal(compileTinTinPattern("%d gold").source, "([0-9]*?) gold");
  assert.equal(compileTinTinPattern("%ihello").source, "(?i)hello");
});

test("PCRE2-only constructs are detected, not emitted blindly", () => {
  const compiled = compileTinTinPattern("{(?=ahead)}rest");
  assert.equal(compiled.unsupported, true);
  assert.ok(compiled.unsupportedFeatures.includes("lookaround"));
});

test("literal negative lookahead becomes a runtime guard", () => {
  const compiled = compileTinTinPattern("You see {?!nothing}");
  assert.deepEqual(compiled.negativeLiterals, ["nothing"]);
  assert.equal(compiled.unsupported, false);
});

test("raw patterns are flagged and seed variables expand", () => {
  assert.equal(compileTinTinPattern("~%1 arrives").raw, true);
  const seeded = compileTinTinPattern("$target flees", { variables: { target: "orc" } });
  assert.equal(seeded.source, "orc flees");
});

test("compiled patterns round-trip to JS regexes when possible", () => {
  const compiled = compileTinTinPattern("%iyes");
  const js = jsRegexSource(compiled);
  assert.ok(js);
  assert.ok(new RegExp(js.source, js.flags).test("YES"));
});

// ---- text ------------------------------------------------------------------

test("output escapes decode; unknown escapes stay literal", () => {
  assert.equal(decodeTinTinOutputEscapes("a\\nb\\tc"), "a\nb\tc");
  assert.equal(decodeTinTinOutputEscapes("\\e[1m"), "\x1b[1m");
  assert.equal(decodeTinTinOutputEscapes("\\;"), ";");
  assert.equal(decodeTinTinOutputEscapes("\\q"), "\\q");
});

test("splitTinTinItems honors braces and quotes", () => {
  assert.deepEqual(splitTinTinItems("{a}{b c}{d}"), ["a", "b c", "d"]);
  assert.deepEqual(splitTinTinItems("one;two {a;b};three"), ["one", "two a;b", "three"]);
});

test("variable paths and static values parse", () => {
  assert.deepEqual(variablePath("hp[current][max]"), ["hp", "current", "max"]);
  assert.equal(staticTinTinValue("42"), 42);
  assert.deepEqual(staticTinTinValue("{a}{1}{b}{2}"), { a: 1, b: 2 });
});

test("color codes split into styled fragments", () => {
  const fragments = parseStyledFragments("<118>bright green<088> plain");
  assert.equal(fragments.length, 2);
  assert.deepEqual(fragments[0].style, { fg: { color: "red", bold: true } });
  assert.equal(fragments[0].text, "bright green");
  assert.deepEqual(fragments[1].style, { fg: "default", bg: "default" });
});

test("highlight color words translate to style options", () => {
  const warnings: string[] = [];
  const options = highlightStyleOptions("bold red on blue", (message) => warnings.push(message));
  assert.deepEqual(options, { fg: { color: "red", bold: true }, bg: "blue" });
  assert.equal(warnings.length, 0);
});

test("occurrence scan finds every non-overlapping match as byte ranges", () => {
  assert.deepEqual(occurrenceByteRanges("orc and orc and orc", "orc"), [
    { begin: 0, end: 3 },
    { begin: 8, end: 11 },
    { begin: 16, end: 19 },
  ]);
  // Non-overlapping: "aaa" holds one "aa", not two.
  assert.deepEqual(occurrenceByteRanges("aaa", "aa"), [{ begin: 0, end: 2 }]);
  assert.deepEqual(occurrenceByteRanges("no match here", "orc"), []);
  assert.deepEqual(occurrenceByteRanges("anything", ""), []);
  // Offsets are UTF-8 bytes: "é" is 2 bytes, "個" is 3.
  assert.deepEqual(occurrenceByteRanges("é orc 個 orc", "orc"), [
    { begin: 3, end: 6 },
    { begin: 11, end: 14 },
  ]);
});

// ---- eval ------------------------------------------------------------------

test("interpolation resolves slots, variables, and escapes", () => {
  const env = fakeEnv({ target: "orc", list: ["a", "b", "c"] }, { 0: "all args", 1: "first" });
  assert.equal(interpolate("kill %1 (%0)", env), "kill first (all args)");
  assert.equal(interpolate("kill $target", env), "kill orc");
  assert.equal(interpolate("&list items", env), "3 items");
  assert.equal(interpolate("100%% and @@home", env), "100% and @home");
});

test("unresolvable slots stay literal", () => {
  const env = fakeEnv();
  assert.equal(interpolate("keep %5", env), "keep %5");
});

test("tables stringify the TinTin way", () => {
  assert.equal(stringifyTinTin({ a: 1, b: "x" }), "{a}{1}{b}{x}");
  assert.equal(stringifyTinTin(["p", "q"]), "{p}{q}");
});

test("expression precedence and arithmetic", () => {
  const env = fakeEnv();
  assert.equal(evalExpression("1 + 2 * 3", env), 7);
  assert.equal(evalExpression("(1 + 2) * 3", env), 9);
  assert.equal(evalExpression("2 ** 3", env), 8);
  assert.equal(evalExpression("7 % 4", env), 3);
});

test("comparisons are numeric when both sides are numbers", () => {
  const env = fakeEnv({ hp: "90", maxhp: "100" });
  assert.equal(evalCondition("$hp < $maxhp", env), true);
  assert.equal(evalCondition("$hp == 90", env), true);
  assert.equal(evalCondition("abc < abd", env), true);
});

test("logical operators use TinTin truthiness", () => {
  const env = fakeEnv({ name: "bob", zero: "0" });
  assert.equal(evalCondition("$name && 1", env), true);
  assert.equal(evalCondition("$zero || 0", env), false);
  assert.equal(evalCondition("!$zero", env), true);
});

test("quoted right-hand sides match as patterns", () => {
  const env = fakeEnv({ who: "a goblin" });
  assert.equal(evalCondition('$who == "a %w"', env), true);
  assert.equal(evalCondition('$who != "an %w"', env), true);
});

// ---- adversarial-review regressions ----------------------------------------

test("quoted-pattern equality is fully anchored, like TinTin's \\A...\\Z", () => {
  const env = fakeEnv({ name: "Bobby", x: "nothing here" });
  assert.equal(evalCondition('$name == "Bob"', env), false);
  assert.equal(evalCondition('$x == {no}', env), false);
  assert.equal(evalCondition('$x != {die}', env), true);
  assert.equal(evalCondition('$name == "Bob%w"', env), true);
});

test("invalid quoted patterns fall back to equality instead of throwing", () => {
  const env = fakeEnv({ x: "whatever" });
  assert.equal(evalCondition('$x == "{[}"', env), false);
  assert.equal(evalCondition('$x == "{+}"', env), false);
  assert.equal(evalCondition('$x == "abc%I"', env), false);
  // Falling back to equality still matches when the strings are identical.
  assert.equal(evalCondition('"{[}" == "{[}"', fakeEnv()), true);
});

test("jsRegexSource rejects Rust-only sources JS would misread", () => {
  assert.equal(jsRegexSource(compileTinTinPattern("abc\\Z")), null);
  assert.equal(jsRegexSource(compileTinTinPattern("%Ihello")), null);
  assert.ok(jsRegexSource(compileTinTinPattern("a\\\\zb")), "escaped backslash before z is a literal, fine in JS");
  // V8 supports (?s:...) modifier groups, so %u passes through unchanged.
  assert.ok(jsRegexSource(compileTinTinPattern("%u")));
});

test("interpolate unescapes literal \\; like the converter's literals", () => {
  const env = fakeEnv();
  assert.equal(interpolate("say a\\;b", env), "say a;b");
  assert.equal(evalCondition('"a\\;b" === "a;b"', env), true);
});

test(".. packs a range into TinTin's single number", () => {
  assert.equal(evalExpression("2..5", fakeEnv()), 100000002100000005);
});

test("&N reads regex capture slots, distinct from %N", () => {
  const env = fakeEnv({}, { 1: "outer" }, { 0: "whole", 1: "inner" });
  assert.equal(interpolate("%1/&1/&0", env), "outer/inner/whole");
  assert.equal(interpolate("&5 stays", env), "&5 stays");
});

test("empty spelling is not a command", () => {
  assert.equal(canonicalCommand(""), null);
});

// ---- format ----------------------------------------------------------------

test("#format specifiers: %s width/precision, %d, %p, %%", () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  assert.equal(formatTinTin("[%5s]", ["hi"], warn), "[   hi]");
  assert.equal(formatTinTin("[%-5s]", ["hi"], warn), "[hi   ]");
  assert.equal(formatTinTin("[%.3s]", ["abcdef"], warn), "[abc]");
  assert.equal(formatTinTin("%d gold", ["12.9"], warn), "12 gold");
  assert.equal(formatTinTin("<%p>", ["  x  "], warn), "<x>");
  assert.equal(formatTinTin("100%%", [], warn), "100%");
  assert.equal(warnings.length, 0);
  assert.equal(formatTinTin("%q", ["z"], warn), "%q");
  assert.equal(warnings.length, 1);
});

test("strftime subset renders a fixed date", () => {
  const date = new Date(2026, 6, 28, 14, 5, 9); // Tue Jul 28 2026
  assert.equal(tinTinStrftime("%Y-%m-%d", date), "2026-07-28");
  assert.equal(tinTinStrftime("%a %H:%M:%S", date), "Tue 14:05:09");
  assert.equal(tinTinStrftime("%T %p", date), "14:05:09 PM");
  // Calendar day-of-year survives a DST-shortened day and any local zone.
  assert.equal(tinTinStrftime("%j", new Date(2026, 6, 1, 0, 30)), "182");
});

test("list options resolve by prefix with aliases", () => {
  assert.equal(tinTinListOption("cr"), "create");
  assert.equal(tinTinListOption("clr"), "clear");
  assert.equal(tinTinListOption("srt"), "sort");
  assert.equal(tinTinListOption("length"), "size");
  assert.equal(tinTinListOption("bogus"), "bogus");
});

// ---- paths -----------------------------------------------------------------

test("default pathdirs pair compass and vertical directions", () => {
  const dirs = defaultPathDirs();
  assert.equal(dirs.n.reverse, "s");
  assert.equal(dirs.s.reverse, "n");
  assert.equal(dirs.ne.reverse, "sw");
  assert.equal(dirs.u.reverse, "d");
});

test("speedwalks zip with counts and unzip in both forms", () => {
  const dirs = defaultPathDirs();
  const steps = [
    { dir: "n", reverse: "s" }, { dir: "n", reverse: "s" }, { dir: "n", reverse: "s" },
    { dir: "e", reverse: "w" }, { dir: "ne", reverse: "sw" },
  ];
  assert.equal(zipPath(steps), "3n;e;ne");
  assert.deepEqual(unzipPath("3n;e;ne", dirs).steps, steps);
  // Compact single-letter form.
  const compact = unzipPath("3n2e", dirs);
  assert.equal(compact.literals.length, 0);
  assert.equal(zipPath(compact.steps), "3n;2e");
});

test("legacy input speedwalks use TinTin's v1 one-letter grammar", () => {
  assert.deepEqual(expandLegacySpeedwalk("ssw2n"), ["s", "s", "w", "n", "n"]);
  assert.deepEqual(expandLegacySpeedwalk("2ne"), ["n", "n", "e"]);
  assert.deepEqual(expandLegacySpeedwalk("ne2s"), ["n", "e", "s", "s"]);
  assert.deepEqual(expandLegacySpeedwalk("unde"), ["u", "n", "d", "e"]);
  assert.equal(expandLegacySpeedwalk("look"), null);
  assert.deepEqual(expandLegacySpeedwalk("0n2u"), ["u", "u"]);
  assert.equal(expandLegacySpeedwalk("1234n"), null, "counts stop at three digits");
  assert.equal(expandLegacySpeedwalk("NEWS"), null, "uppercase avoids speedwalk expansion");
  assert.equal(expandLegacySpeedwalk("2north"), null);
  assert.equal(expandLegacySpeedwalk("2n3"), null);
});

test("compact runs take the longest known direction, not one letter", () => {
  const dirs = defaultPathDirs();
  assert.deepEqual(unzipPath("2sw2ne", dirs).steps.map((step) => step.dir), ["sw", "sw", "ne", "ne"]);
});

test("whitespace separates like semicolons; unknown names load literally", () => {
  const dirs = defaultPathDirs();
  assert.deepEqual(unzipPath("n e 2s", dirs).steps.map((step) => step.dir), ["n", "e", "s", "s"]);
  const withLiteral = unzipPath("open;2n", dirs);
  assert.deepEqual(withLiteral.steps.map((step) => step.dir), ["open", "n", "n"]);
  assert.deepEqual(withLiteral.steps[0].reverse, "open");
  assert.deepEqual(withLiteral.literals, ["open"]);
});

test("multi-char and digit-bearing directions are never count-prefixed", () => {
  const dirs = { ...defaultPathDirs(), "3rd": { dir: "3rd", reverse: "3rd" } };
  const route = [{ dir: "sw", reverse: "ne" }, { dir: "sw", reverse: "ne" }, { dir: "3rd", reverse: "3rd" }];
  assert.equal(zipPath(route), "sw;sw;3rd");
  assert.deepEqual(unzipPath("sw;sw;3rd", dirs).steps, route);
});

test("prototype members never read as directions", () => {
  const dirs = defaultPathDirs();
  const result = unzipPath("constructor", dirs);
  assert.deepEqual(result.steps, [{ dir: "constructor", reverse: "constructor" }]);
  assert.deepEqual(result.literals, ["constructor"]);
});

test("file command char discovery skips leading comments", () => {
  assert.equal(discoverFileCommandChar("#alias {a} {b}"), "#");
  assert.equal(discoverFileCommandChar("/* header */\n#alias {a} {b}"), "#");
  assert.equal(discoverFileCommandChar("  /* a */ /* b */\n/showme hi"), "/");
  assert.equal(discoverFileCommandChar("hello"), "#");
  assert.equal(discoverFileCommandChar(""), "#");
});

// ---- keys ------------------------------------------------------------------

test("macro key sequences resolve to smudgy key names", () => {
  assert.deepEqual(tinTinKeySpec("\\e[15~"), { key: "F5" });
  assert.deepEqual(tinTinKeySpec("\\eOP"), { key: "F1" });
  assert.deepEqual(tinTinKeySpec("\\e[A"), { key: "ArrowUp" });
  assert.deepEqual(tinTinKeySpec("f12"), { key: "F12" });
  assert.equal(tinTinKeySpec("\\ex"), null);
});
