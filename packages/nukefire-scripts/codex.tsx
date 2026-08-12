// =============================================================================
//  Codex pane — a browser for the NukeFire Knowledge console
// =============================================================================
//  The pane's input runs full-text searches over live help files, items,
//  commands, skills, and zones (KnowledgeClient pairs each reply to its
//  request and rejects on server errors). Results are clickable; an entry
//  renders its article body as Markdown — so any <command> links the server
//  embeds become clickable command chips — with its labelled fields above and
//  a button for the full terminal command when the body was truncated.
//
//  `codex <query>` from the main input opens the pane and searches.

import { createAlias, session } from "smudgy:core";
import {
  Button,
  Column,
  Markdown,
  Row,
  Scrollable,
  Space,
  Text,
  createWidget,
} from "smudgy:widgets";
import {
  KnowledgeClient,
  KnowledgeRequestError,
  type NukeFireKnowledgeEntry,
  type NukeFireKnowledgeResult,
  type NukeFireKnowledgeResults,
} from "smudgy://kapusniak/nukefire-gmcp";
import { widgetTextSize } from "./config.ts";
import { isPrimarySession } from "./multi.ts";
import { UI, domainColor } from "./theme.ts";

const PANE = "Codex";

const client = new KnowledgeClient();

type View =
  | { mode: "idle" }
  | { mode: "loading"; what: string }
  | { mode: "results"; page: NukeFireKnowledgeResults }
  | { mode: "entry"; entry: NukeFireKnowledgeEntry; from: NukeFireKnowledgeResults | null }
  | { mode: "error"; message: string };

let view: View = { mode: "idle" };
let shown = false;

function show(next: View): void {
  view = next;
  if (shown) mount();
}

function describeError(error: unknown): string {
  if (error instanceof KnowledgeRequestError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function search(query: string, offset = 0): void {
  const q = query.trim();
  if (q.length < 2) {
    show({ mode: "error", message: "queries need at least 2 characters" });
    return;
  }
  show({ mode: "loading", what: `searching “${q}”…` });
  client
    .query({ query: q, offset })
    .then((page) => show({ mode: "results", page }))
    .catch((error) => show({ mode: "error", message: describeError(error) }));
}

function openEntry(result: NukeFireKnowledgeResult): void {
  const from = view.mode === "results" ? view.page : view.mode === "entry" ? view.from : null;
  show({ mode: "loading", what: `fetching ${result.title}…` });
  client
    .get({ type: result.type, key: result.key })
    .then((entry) => show({ mode: "entry", entry, from }))
    .catch((error) => show({ mode: "error", message: describeError(error) }));
}

function resultRow(r: NukeFireKnowledgeResult) {
  return (
    <Column spacing={0}>
      <Row spacing={6}>
        <Text size={widgetTextSize(11)} color={domainColor(r.type)}>{r.type.toUpperCase()}</Text>
        <Button variant="link" onPress={() => openEntry(r)}>
          <Text size={widgetTextSize(14)} color={UI.bright}>{r.title}</Text>
        </Button>
        <Space width="fill" />
        <Text size={widgetTextSize(11)} color={UI.faint}>{r.meta}</Text>
      </Row>
      <Text size={widgetTextSize(12)} color={UI.dim}>{r.summary}</Text>
    </Column>
  );
}

function withMarkdownParagraphBreaks(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\n\n");
}

function body() {
  switch (view.mode) {
    case "idle":
      return [
        <Text size={widgetTextSize(13)} color={UI.faint}>
          Type a search in the input below — it covers live help files, items,
          commands, skills, and zones. Or use `codex &lt;query&gt;` from the main input.
        </Text>,
      ];
    case "loading":
      return [<Text size={widgetTextSize(13)} color={UI.dim}>{view.what}</Text>];
    case "error":
      return [<Text size={widgetTextSize(13)} color={UI.danger}>{view.message}</Text>];
    case "results": {
      const page = view.page;
      const rows = page.results.map(resultRow);
      const footer = (
        <Row spacing={8}>
          <Text size={widgetTextSize(12)} color={UI.dim}>
            {page.offset + page.count} of {page.matched} for “{page.query}”
          </Text>
          <Space width="fill" />
          {page.hasMore && (
            <Button variant="subtle" onPress={() => search(page.query, page.nextOffset)}>
              <Text size={widgetTextSize(12)} color={UI.gold}>next page →</Text>
            </Button>
          )}
        </Row>
      );
      return page.count === 0
        ? [<Text size={widgetTextSize(13)} color={UI.faint}>No matches for “{page.query}”.</Text>]
        : [...rows, footer];
    }
    case "entry": {
      const entry = view.entry;
      return [
        <Text size={widgetTextSize(16)} color={UI.bright}>{entry.title}</Text>,
        entry.summary !== "" && <Text size={widgetTextSize(13)} color={UI.dim}>{entry.summary}</Text>,
        ...entry.fields.map((f) => (
          <Row spacing={6}>
            <Text size={widgetTextSize(12)} color={UI.dim}>{f.label}:</Text>
            <Text size={widgetTextSize(12)} color={UI.text}>{f.value}</Text>
          </Row>
        )),
        <Markdown size={widgetTextSize(14)}>{withMarkdownParagraphBreaks(entry.body)}</Markdown>,
        entry.truncated && entry.terminalCommand !== "" && (
          <Button variant="subtle" onPress={() => session.send(entry.terminalCommand)}>
            <Text size={widgetTextSize(12)} color={UI.gold}>
              {entry.terminalLabel || `full text: ${entry.terminalCommand}`}
            </Text>
          </Button>
        ),
        entry.tags.length > 0 && (
          <Text size={widgetTextSize(11)} color={UI.faint}>tags: {entry.tags.join(", ")}</Text>
        ),
      ];
    }
  }
}

function mount(): void {
  const backTo = view.mode === "entry" ? view.from : null;
  createWidget(
    "nf-codex",
    <Column width="fill" height="fill" padding={6} spacing={5}>
      <Row spacing={8}>
        <Text size={widgetTextSize(14)} color="#9d8fe0">Codex</Text>
        <Space width="fill" />
        {backTo !== null && (
          <Button variant="subtle" onPress={() => show({ mode: "results", page: backTo })}>
            <Text size={widgetTextSize(12)} color={UI.dim}>← results</Text>
          </Button>
        )}
      </Row>
      <Scrollable width="fill" height="fill">
        <Column spacing={5}>{body()}</Column>
      </Scrollable>
    </Column>,
    { pane: PANE },
  );
}

export function open(): void {
  if (!isPrimarySession()) return;
  const parent = session.panes.get("Comms") ?? session.mainPane;
  parent.split("bottom", {
    name: PANE,
    height: 320,
    terminal: false,
    input: {
      placeholder: "search the Knowledge console… (min 2 characters)",
      onSubmit: (text) => search(text),
    },
  });
  shown = true;
  mount();
}

/** Open, reveal, and select Codex before searching for a linked subject. */
export function lookup(query: string): void {
  if (!isPrimarySession()) return;
  open();
  const codexPane = session.panes.get(PANE);
  codexPane?.show();
  codexPane?.select();
  codexPane?.input?.replace(query);
  search(query);
}

export function close(): void {
  shown = false;
  session.panes.get(PANE)?.close();
}

// `codex remort` from anywhere: open the pane and run the search.
createAlias(/^codex\s+(?<query>.+)$/, ({ query }) => {
  if (!isPrimarySession()) return;
  lookup(query);
}, { name: "codex" });
