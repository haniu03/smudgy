// TinTin++ lexer and parser, ported from tools/tt2smudgy (converter.mjs) and
// kept behaviorally identical to TinTin++ 2.02.61: semicolons split only at
// brace depth zero, escaped semicolons stay literal, physical lines inside
// braces fold into their logical command, and command spellings resolve by
// first-prefix match against the alphabetical command table.
//
// No smudgy imports in here; the test suite runs this under plain node.

/** TinTin++ 2.02.61's alphabetically ordered command table (src/command.c). */
export const TINTIN_COMMANDS: readonly string[] = Object.freeze([
  "action", "alias", "all", "banner", "bell", "break", "buffer", "button",
  "case", "cat", "chat", "class", "commands", "config", "continue", "cr",
  "cursor", "daemon", "debug", "default", "delay", "dictionary", "draw", "echo",
  "edit", "else", "elseif", "end", "event", "foreach", "format", "function",
  "gag", "grep", "help", "highlight", "history", "if", "ignore", "info", "kill",
  "killall", "line", "list", "local", "log", "loop", "macro", "map", "math",
  "message", "nop", "parse", "path", "pathdir", "port", "prompt", "read",
  "regexp", "replace", "return", "run", "scan", "screen", "script", "send",
  "session", "showme", "snoop", "split", "ssl", "substitute", "switch", "system",
  "tab", "test", "textin", "ticker", "unaction", "unalias", "unbutton", "undelay",
  "unevent", "unfunction", "ungag", "unhighlight", "unlocal", "unmacro",
  "unpathdir", "unprompt", "unsplit", "unsubstitute", "untab", "unticker",
  "unvariable", "variable", "while", "write", "zap",
]);

/** Which argument index of each command is a body of further commands. */
const BODY_ARGUMENTS = new Map<string, number[]>([
  ["action", [1]], ["alias", [1]], ["case", [1]], ["default", [0]],
  ["delay", [1]], ["else", [0]], ["elseif", [1]], ["event", [1]],
  ["foreach", [2]], ["function", [1]], ["if", [1, 2]], ["loop", [3]],
  ["macro", [1]],
  ["parse", [2]], ["regexp", [2, 3]], ["switch", [1]], ["ticker", [1]],
  ["while", [1]],
]);

/** Which argument index of each command is a TinTin pattern. */
export const PATTERN_ARGUMENTS = new Map<string, number>([
  ["action", 0], ["alias", 0], ["gag", 0], ["highlight", 0],
  ["prompt", 0], ["regexp", 1], ["substitute", 0],
]);

const STRUCTURED_STATEMENTS = new Set<string>([
  "break", "case", "continue", "default", "else", "elseif", "foreach", "if",
  "loop", "parse", "regexp", "return", "switch", "while",
]);

export interface SourcePosition {
  line: number;
  column: number;
}

export interface Span {
  source: string;
  start: SourcePosition;
  end: SourcePosition;
}

export interface Diagnostic {
  source: string;
  line: number;
  column: number;
  severity: string;
  code: string;
  message: string;
}

export function diagnostic(
  source: string,
  line: number,
  column: number,
  code: string,
  message: string,
  severity = "warning",
): Diagnostic {
  return { source, line, column, severity, code, message };
}

export function formatDiagnostic(item: Diagnostic): string {
  const at = item.line ? `${item.source}:${item.line}:${item.column || 1}` : item.source;
  return `${at}: ${item.message}`;
}

export function asciiPunctuation(ch: string): boolean {
  if (!ch || ch.length !== 1) return false;
  const code = ch.charCodeAt(0);
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

function normalizeText(text: unknown): string {
  const value = String(text ?? "");
  return (value.startsWith("\uFEFF") ? value.slice(1) : value).replace(/\r\n?/g, "\n");
}

interface LexToken {
  kind: "segment" | "comment";
  text: string;
  span: Span;
  _origins?: SourcePosition[];
}

export interface LexResult {
  commandChar: string;
  tokens: LexToken[];
  diagnostics: Diagnostic[];
}

export interface LexOptions {
  source?: string;
  commandChar?: string;
  discoverCommand?: boolean;
  baseLine?: number;
  baseColumn?: number;
  sourceOrigins?: SourcePosition[] | null;
  allowComments?: boolean;
}

function discoverCommandChar(text: string, source: string, diagnostics: Diagnostic[]): string {
  if (!text) return "#";
  const first = text[0];
  if (asciiPunctuation(first)) return first;
  diagnostics.push(diagnostic(
    source, 1, 1, "invalid-command-character",
    `TinTin++ requires the first file character to be punctuation; using "#" instead of ${JSON.stringify(first)}`,
  ));
  return "#";
}

function endPosition(origin: SourcePosition | undefined, text: string): SourcePosition {
  if (!origin) return { line: 1, column: 1 };
  const last = text.at(-1) ?? "";
  return { line: origin.line, column: origin.column + Math.max(1, last.length) };
}

function publicSpan(source: string, start: SourcePosition, end: SourcePosition): Span {
  return {
    source,
    start: { line: start.line, column: start.column },
    end: { line: end.line, column: end.column },
  };
}

/**
 * Split a TinTin++ script into top-level command/literal segments and comments.
 */
export function lexTinTin(text: unknown, {
  source = "input.tin",
  commandChar,
  discoverCommand = commandChar === undefined,
  baseLine = 1,
  baseColumn = 1,
  sourceOrigins = null,
  allowComments = true,
}: LexOptions = {}): LexResult {
  const value = normalizeText(text);
  const diagnostics: Diagnostic[] = [];
  const activeCommandChar = discoverCommand
    ? discoverCommandChar(value, source, diagnostics)
    : (commandChar ?? "#");
  const tokens: LexToken[] = [];
  let line = baseLine;
  let column = baseColumn;
  let i = 0;
  let braceDepth = 0;
  let buffer = "";
  let origins: SourcePosition[] = [];

  const origin = (): SourcePosition => sourceOrigins?.[i] ?? ({ line, column });
  const advance = (ch: string) => {
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  };
  const append = (ch: string, at: SourcePosition = origin()) => {
    buffer += ch;
    for (let n = 0; n < ch.length; n++) origins.push({ ...at, column: at.column + n });
  };
  const flush = () => {
    const first = buffer.search(/\S/);
    if (first < 0) {
      buffer = "";
      origins = [];
      return;
    }
    let last = buffer.length - 1;
    while (last >= first && /\s/.test(buffer[last])) last--;
    const tokenText = buffer.slice(first, last + 1);
    const tokenOrigins = origins.slice(first, last + 1);
    const start = tokenOrigins[0];
    const end = endPosition(tokenOrigins.at(-1), tokenText);
    tokens.push({ kind: "segment", text: tokenText, span: publicSpan(source, start, end), _origins: tokenOrigins });
    buffer = "";
    origins = [];
  };

  while (i < value.length) {
    const ch = value[i];
    const next = value[i + 1] ?? "";

    if (allowComments && braceDepth === 0 && ch === "/" && next === "*") {
      flush();
      const start = origin();
      let commentDepth = 1;
      let commentText = "";
      advance(ch); advance(next); i += 2;
      while (i < value.length && commentDepth > 0) {
        const current = value[i];
        const following = value[i + 1] ?? "";
        if (current === "/" && following === "*") {
          commentDepth += 1;
          commentText += "/*";
          advance(current); advance(following); i += 2;
        } else if (current === "*" && following === "/") {
          commentDepth -= 1;
          if (commentDepth > 0) commentText += "*/";
          advance(current); advance(following); i += 2;
        } else {
          commentText += current;
          advance(current); i += 1;
        }
      }
      if (commentDepth > 0) {
        diagnostics.push(diagnostic(source, start.line, start.column, "unterminated-comment", "unterminated /* ... */ comment"));
      }
      tokens.push({
        kind: "comment",
        text: commentText.trim(),
        span: publicSpan(source, start, { line, column }),
      });
      continue;
    }

    if (ch === "\\" && next === ";") {
      append(ch); advance(ch); i += 1;
      append(next); advance(next); i += 1;
      continue;
    }

    if (ch === "{") braceDepth += 1;
    if (ch === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) {
        const at = origin();
        diagnostics.push(diagnostic(source, at.line, at.column, "unexpected-close-brace", "unexpected closing brace"));
        braceDepth = 0;
      }
    }

    if (ch === ";" && braceDepth === 0) {
      flush();
      advance(ch); i += 1;
      continue;
    }

    if (ch === "\n") {
      if (braceDepth === 0) {
        let look = i + 1;
        while (/\s/.test(value[look] ?? "") && look < value.length) look++;
        if (value[look] === "{") {
          buffer = buffer.replace(/[ \t]+$/g, "");
          origins.length = buffer.length;
          if (buffer) append(" ", origin());
          while (i < look) {
            advance(value[i]);
            i += 1;
          }
        } else {
          flush();
          advance(ch); i += 1;
        }
      } else {
        buffer = buffer.replace(/[ \t]+$/g, "");
        origins.length = buffer.length;
        let look = i + 1;
        while (value[look] === " " || value[look] === "\t" || value[look] === "\n") look++;
        const previous = buffer.at(-1) ?? "";
        const following = value[look] ?? "";
        if (buffer && previous !== ";" && previous !== "{" && following !== "}") append(" ", origin());
        while (i < look) {
          advance(value[i]);
          i += 1;
        }
      }
      continue;
    }

    append(ch);
    advance(ch);
    i += 1;
  }

  flush();
  if (braceDepth !== 0) {
    const at = sourceOrigins?.length
      ? endPosition(sourceOrigins.at(-1), "x")
      : { line, column };
    diagnostics.push(diagnostic(source, at.line, at.column, "unbalanced-braces", `command file ended with brace depth ${braceDepth}`));
  }
  return { commandChar: activeCommandChar, tokens, diagnostics };
}

/**
 * The command character a TinTin file declares: its first character after
 * leading whitespace and comment blocks. TinTin strips comments before
 * looking, so a file opening with a header comment still reads as `#`.
 * Falls back to `#` when the first real character is not punctuation.
 */
export function discoverFileCommandChar(text: unknown): string {
  const value = normalizeText(text);
  let index = 0;
  for (;;) {
    while (index < value.length && /\s/.test(value[index])) index += 1;
    if (value[index] === "/" && value[index + 1] === "*") {
      let depth = 1;
      index += 2;
      while (index < value.length && depth > 0) {
        if (value[index] === "/" && value[index + 1] === "*") { depth += 1; index += 2; }
        else if (value[index] === "*" && value[index + 1] === "/") { depth -= 1; index += 2; }
        else index += 1;
      }
      continue;
    }
    break;
  }
  const first = value[index] ?? "";
  return asciiPunctuation(first) ? first : "#";
}

/** Resolve a possibly abbreviated spelling to its canonical command name. */
export function canonicalCommand(spelling: string): string | null {
  const lower = spelling.toLowerCase();
  if (!lower) return null;
  return TINTIN_COMMANDS.find((name) => name.startsWith(lower)) ?? null;
}

export interface Argument {
  value: string;
  raw: string;
  braced: boolean;
  unterminated?: boolean;
  span: Span;
  _origins: SourcePosition[];
  _start: number;
}

function argumentSpan(source: string, origins: SourcePosition[], start: number, end: number): Span {
  const first = origins[start] ?? origins[0] ?? { line: 1, column: 1 };
  const last = origins[Math.max(start, end - 1)] ?? first;
  return publicSpan(source, first, endPosition(last, "x"));
}

export function parseArguments(text: string, origins: SourcePosition[], source: string, startIndex: number): Argument[] {
  const args: Argument[] = [];
  let i = startIndex;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    if (text[i] === "{") {
      let depth = 1;
      i += 1;
      const valueStart = i;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") depth -= 1;
        if (depth > 0) i += 1;
      }
      const valueEnd = i;
      if (i < text.length && text[i] === "}") i += 1;
      args.push({
        value: text.slice(valueStart, valueEnd),
        raw: text.slice(start, i),
        braced: true,
        unterminated: depth !== 0,
        span: argumentSpan(source, origins, start, i),
        _origins: origins.slice(valueStart, valueEnd),
        _start: start,
      });
    } else {
      while (i < text.length && !/\s/.test(text[i])) i++;
      args.push({
        value: text.slice(start, i),
        raw: text.slice(start, i),
        braced: false,
        span: argumentSpan(source, origins, start, i),
        _origins: origins.slice(start, i),
        _start: start,
      });
    }
  }
  return args;
}

export interface BodyGroup {
  argument: number;
  nodes: TinTinNode[];
}

interface NodeBase {
  span: Span;
}

export interface CommentNode extends NodeBase {
  kind: "comment";
  text: string;
}

export interface SendNode extends NodeBase {
  kind: "send";
  text: string;
  escaped: boolean;
  raw: string;
}

export interface CommandNode extends NodeBase {
  kind: "command" | "statement";
  name: string;
  spelling: string;
  abbreviated: boolean;
  known: boolean;
  args: Argument[];
  bodies?: BodyGroup[];
  raw: string;
}

export type TinTinNode = CommentNode | SendNode | CommandNode;

function bodyIndices(name: string, args: Argument[]): number[] {
  if (name === "class" && args[1]?.value.toLowerCase() === "assign") return [2];
  return BODY_ARGUMENTS.get(name) ?? [];
}

function parseLexed(lexed: LexResult, source: string, diagnostics: Diagnostic[]): TinTinNode[] {
  const nodes: TinTinNode[] = [];
  for (const token of lexed.tokens) {
    if (token.kind === "comment") {
      nodes.push({ kind: "comment", text: token.text, span: token.span });
      continue;
    }

    const text = token.text;
    const origins = token._origins ?? [];
    if (text[0] !== lexed.commandChar) {
      const escaped = text[0] === "\\";
      nodes.push({
        kind: "send",
        text: escaped ? text.slice(1) : text,
        escaped,
        raw: text,
        span: token.span,
      });
      continue;
    }

    let i = 1;
    while (i < text.length && !/[\s{]/.test(text[i])) i++;
    const spelling = text.slice(1, i);
    const name = canonicalCommand(spelling);
    const args = parseArguments(text, origins, source, i);
    const node: CommandNode = {
      kind: name !== null && STRUCTURED_STATEMENTS.has(name) ? "statement" : "command",
      name: name ?? spelling.toLowerCase(),
      spelling,
      abbreviated: Boolean(name && name !== spelling.toLowerCase()),
      known: Boolean(name),
      args,
      raw: text,
      span: token.span,
    };

    if (!spelling) {
      diagnostics.push(diagnostic(source, token.span.start.line, token.span.start.column, "missing-command", "command character is not followed by a command"));
    } else if (!name) {
      diagnostics.push(diagnostic(
        source,
        token.span.start.line,
        token.span.start.column,
        "unknown-command",
        `${JSON.stringify(spelling)} is not a built-in TinTin++ command; it may be a user-defined alias`,
      ));
    }
    for (const arg of args) {
      if (arg.unterminated) {
        diagnostics.push(diagnostic(source, arg.span.start.line, arg.span.start.column, "unterminated-argument", "unterminated braced argument"));
      }
    }

    const bodies: BodyGroup[] = [];
    for (const index of bodyIndices(node.name, args)) {
      const arg = args[index];
      if (!arg) continue;
      // An unbraced TinTin body consumes the remainder of the logical command,
      // not only its first whitespace-delimited argument. Real script sets use
      // this for forms such as `#if {condition} #read defaults.tin`.
      const bodyText = arg.braced ? arg.value : text.slice(arg._start);
      const bodyOrigins = arg.braced ? arg._origins : origins.slice(arg._start);
      const nested = parseInternal(bodyText, {
        source,
        commandChar: lexed.commandChar,
        discoverCommand: false,
        baseLine: arg.span.start.line,
        baseColumn: arg.span.start.column + (arg.braced ? 1 : 0),
        sourceOrigins: bodyOrigins,
        allowComments: false,
      });
      diagnostics.push(...nested.diagnostics);
      bodies.push({ argument: index, nodes: nested.nodes });
      if (!arg.braced) break;
    }
    if (bodies.length) node.bodies = bodies;
    nodes.push(node);
  }
  return nodes;
}

export interface ParseResult {
  source: string;
  commandChar: string;
  nodes: TinTinNode[];
  diagnostics: Diagnostic[];
}

function parseInternal(text: unknown, options: LexOptions & { source: string }): ParseResult {
  const lexed = lexTinTin(text, options);
  const diagnostics = [...lexed.diagnostics];
  const nodes = parseLexed(lexed, options.source, diagnostics);
  return { source: options.source, commandChar: lexed.commandChar, nodes, diagnostics };
}

export function walkNodes(nodes: TinTinNode[], visit: (node: TinTinNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.kind === "command" || node.kind === "statement") {
      for (const body of node.bodies ?? []) walkNodes(body.nodes, visit);
    }
  }
}

/** Parse one TinTin++ input into a source-located syntax tree. */
export function parseTinTin(text: unknown, {
  source = "input.tin",
  commandChar,
}: { source?: string; commandChar?: string } = {}): ParseResult {
  return parseInternal(normalizeText(text), {
    source,
    commandChar,
    discoverCommand: commandChar === undefined,
    baseLine: 1,
    baseColumn: 1,
  });
}

/** The whole argument tail of a command, starting at argument `index`. */
export function nodeArgumentText(node: CommandNode, index = 0): string {
  const arg = node.args?.[index];
  if (!arg) return "";
  if (arg.braced) return arg.value;
  return node.args.slice(index).map((item) => item.value).join(" ");
}

/** The parsed body attached to argument `argument`, or an empty list. */
export function bodyFor(node: CommandNode, argument = 1): TinTinNode[] {
  return node.bodies?.find((body) => body.argument === argument)?.nodes ?? [];
}
