// =============================================================================
//  Notes pane — Markdown notes for the current map and room
// =============================================================================
//  The Map widget mounts once so its MapView keeps zoom and pan, and Markdown
//  is parsed once, so notes live in a pane of their own beneath the Map and
//  re-render as you move. Each map and each room keeps its notes in its own
//  `notes` property. Selecting a heading edits those notes in a modal over the
//  Map pane, which has the room to write in.

import { mapper, session } from "smudgy:core";
import {
  areasLoaded,
  merged as mapsMerged,
  room as mapRoomChanged,
} from "smudgy:events/map";
import {
  Button,
  Column,
  Container,
  Markdown,
  Modal,
  Row,
  Scrollable,
  Space,
  Text,
  TextEditor,
  createWidget,
  removeWidget,
} from "smudgy:widgets";
import { widgetMetric, widgetTextSize } from "./config.ts";
import { roomVnum } from "./map-activity.ts";
import { currentMappedRoom } from "./map.tsx";
import { NOTES_PROPERTY, followMerge, noteText, type NoteTarget } from "./notes-model.ts";
import { UI, themeBackground } from "./theme.ts";

const PANE = "Notes";
const MAP_PANE = "Map";
const NOTES_WIDGET = "nf-notes";
const EDITOR_WIDGET = "nf-notes-editor";

interface Editing {
  target: NoteTarget;
  draft: string;
  /** Whether the target had notes when the editor opened. */
  existing: boolean;
  /** A fresh buffer per open: TextEditor seeds `value` only for a new id. */
  editorId: string;
  busy: boolean;
  error: string;
}

let shown = false;
let editing: Editing | undefined;
let editorSeq = 0;

function areaById(id: string): Area | undefined {
  return mapper.areas.find((area) => area.id === id);
}

function areaTarget(area: Area): NoteTarget {
  return { kind: "area", areaId: area.id, name: area.name || "Map" };
}

function roomTarget(room: Room): NoteTarget {
  return {
    kind: "room",
    areaId: room.areaId,
    roomNumber: room.roomNumber,
    vnum: roomVnum(room.externalId),
    name: room.title || `Room ${room.roomNumber}`,
  };
}

/** A room by its game number when it has one, which survives combined maps. */
function resolveRoom(target: Extract<NoteTarget, { kind: "room" }>): Room | undefined {
  if (target.vnum !== undefined) return mapper.findRoomByExternalId(String(target.vnum));
  return areaById(target.areaId)?.room(target.roomNumber);
}

function readNotes(target: NoteTarget): string | undefined {
  return target.kind === "area"
    ? areaById(target.areaId)?.data(NOTES_PROPERTY)
    : resolveRoom(target)?.data(NOTES_PROPERTY);
}

/** Blank notes delete the property rather than store an empty value. */
async function writeNotes(target: NoteTarget, text: string | undefined): Promise<void> {
  if (target.kind === "area") {
    const area = areaById(target.areaId);
    if (!area) throw new Error("this map is no longer available");
    if (text === undefined) await mapper.deleteAreaProperty(area.id, NOTES_PROPERTY);
    else await mapper.setAreaProperty(area.id, NOTES_PROPERTY, text);
    return;
  }
  const room = resolveRoom(target);
  if (!room) throw new Error("this room is no longer on the map");
  if (text === undefined) await mapper.deleteRoomProperty(room.areaId, room.roomNumber, NOTES_PROPERTY);
  else await mapper.setRoomProperty(room.areaId, room.roomNumber, NOTES_PROPERTY, text);
}

function heading(label: string, name: string, onEdit: () => void) {
  return (
    <Button width="fill" variant="link" onPress={onEdit}>
      <Row width="fill" spacing={6}>
        <Text size={widgetTextSize(10)} color={UI.gold}>{label}</Text>
        <Text size={widgetTextSize(12)} color={UI.bright}>{name}</Text>
        <Space width="fill" />
        <Text size={widgetTextSize(10)} color={UI.faint}>edit</Text>
      </Row>
    </Button>
  );
}

function notesBody(text: string) {
  return (
    <Container width="fill" align_x="left">
      <Markdown size={widgetTextSize(12)}>{text}</Markdown>
    </Container>
  );
}

function mount(): void {
  if (!shown) return;
  const room = currentMappedRoom();
  const area = room ? areaById(room.areaId) : undefined;
  const areaNotes = noteText(area?.data(NOTES_PROPERTY));
  const roomNotes = noteText(room?.data(NOTES_PROPERTY));
  createWidget(
    NOTES_WIDGET,
    <Scrollable width="fill" height="fill" direction="vertical">
      <Column width="fill" padding={6} spacing={4}>
        {!room || !area
          ? <Text size={widgetTextSize(11)} color={UI.faint}>Notes appear here once this room is on the map.</Text>
          : [
            heading("AREA", area.name || "Map", () => openEditor(areaTarget(area))),
            areaNotes !== undefined && notesBody(areaNotes),
            heading("ROOM", room.title || `Room ${room.roomNumber}`, () => openEditor(roomTarget(room))),
            roomNotes !== undefined && notesBody(roomNotes),
            areaNotes === undefined && roomNotes === undefined &&
            <Text size={widgetTextSize(10)} color={UI.faint}>No notes yet. Select AREA or ROOM to write some.</Text>,
          ]}
      </Column>
    </Scrollable>,
    { pane: PANE },
  );
}

function closeEditor(): void {
  editing = undefined;
  removeWidget(EDITOR_WIDGET);
}

async function save(remove: boolean): Promise<void> {
  const state = editing;
  if (!state || state.busy) return;
  state.busy = true;
  state.error = "";
  renderEditor();
  try {
    await writeNotes(state.target, remove ? undefined : noteText(state.draft));
    if (editing === state) closeEditor();
    mount();
  } catch (caught) {
    state.busy = false;
    state.error = `Could not ${remove ? "delete" : "save"} notes: ${caught instanceof Error ? caught.message : String(caught)}`;
    if (editing === state) renderEditor();
  }
}

function renderEditor(): void {
  const state = editing;
  if (!state) return;
  const idle = !state.busy;
  createWidget(
    EDITOR_WIDGET,
    <Modal>
      <Column width="fill" height="fill" padding={widgetMetric(8)}>
        <Container width="fill" height="fill" background={themeBackground.bind()}>
          <Column width="fill" height="fill" padding={widgetMetric(12)} spacing={widgetMetric(8)}>
            <Row width="fill" spacing={6}>
              <Text size={widgetTextSize(10)} color={UI.gold}>
                {state.target.kind === "area" ? "AREA NOTES" : "ROOM NOTES"}
              </Text>
              <Text size={widgetTextSize(12)} color={UI.bright}>{state.target.name}</Text>
            </Row>
            <TextEditor
              id={state.editorId}
              value={state.draft}
              height="fill"
              size={widgetTextSize(12)}
              placeholder="Notes (Markdown supported)"
              onChange={(text) => {
                if (!state.busy) state.draft = text;
              }}
            />
            {state.error !== "" &&
              <Text size={widgetTextSize(11)} color={UI.danger}>{state.error}</Text>}
            <Row width="fill" spacing={8}>
              <Button
                variant="subtle"
                onPress={idle && state.existing ? () => void save(true) : undefined}
              >
                <Text size={widgetTextSize(11)} color={state.existing ? UI.warning : UI.faint}>Delete</Text>
              </Button>
              <Space width="fill" />
              <Button variant="subtle" onPress={idle ? closeEditor : undefined}>
                <Text size={widgetTextSize(11)} color={UI.dim}>Discard</Text>
              </Button>
              <Button variant="primary" onPress={idle ? () => void save(false) : undefined}>
                <Text size={widgetTextSize(11)} color={UI.bright}>{state.busy ? "Saving…" : "Save"}</Text>
              </Button>
            </Row>
          </Column>
        </Container>
      </Column>
    </Modal>,
    { pane: MAP_PANE },
  );
}

/** Edit one map's or room's notes. The target stays put while you walk. */
function openEditor(target: NoteTarget): void {
  const mapPane = session.panes.get(MAP_PANE);
  if (!mapPane) return;
  // Atlas shares the Map pane's tab group; bring the map forward to edit over it.
  mapPane.select();
  // The headings stay clickable beside an open editor; never drop its draft.
  if (editing) return;
  const current = readNotes(target);
  editing = {
    target,
    draft: current ?? "",
    existing: current !== undefined,
    editorId: `${EDITOR_WIDGET}-${++editorSeq}`,
    busy: false,
    error: "",
  };
  renderEditor();
}

mapRoomChanged.on(() => mount());
areasLoaded.on(() => mount());
mapsMerged.on((merge) => {
  if (editing) editing.target = followMerge(editing.target, merge);
  mount();
});

export function open(): void {
  const mapPane = session.panes.get(MAP_PANE);
  if (!mapPane) return;
  mapPane.split("bottom", { name: PANE, height: widgetMetric(180), terminal: false });
  shown = true;
  mount();
}

export function close(): void {
  shown = false;
  closeEditor();
  session.panes.get(PANE)?.close();
}
