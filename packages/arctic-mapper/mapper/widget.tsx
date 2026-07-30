import { createWidget, removeWidget, Button, Column, Container, MapView, Markdown, Modal, Row, Scrollable, Text, TextEditor } from 'smudgy:widgets';
import { echo, mapper, session } from 'smudgy:core';

import { onAreaChanged, onRoomChanged, options, state } from './mapper.ts';


// The mapper's UI lives in two widgets-only panes on the session's right: "Notes"
// (split right off the main pane) holds the area/room info block and the notes
// editor; "Map" (split off the top of Notes) holds just the map view, which fills
// the pane in both directions — so the dividers size the map freely. `split()` is
// get-or-create and panes survive script reloads, so these handles are stable
// across package reloads; the sizes are only initial — the dividers are the user's
// afterwards. The `widgetSize` param (default 350, the prior built-in size) sets
// both initial extents, padded by the pane body's margins (20px horizontal,
// 16px vertical) so the map starts out `widgetSize` square.
const NOTES_PANE = session.mainPane.split("right", {
    name: "Notes",
    width: options.widgetSize + 20,
    terminal: false,
});
const MAP_PANE = NOTES_PANE.split("top", {
    name: "Map",
    height: options.widgetSize + 16,
    terminal: false,
});

// The map and the info block are separate widgets because re-creating a widget
// re-mounts its MapView, which visibly flashes the map — so the map is mounted
// ONCE and never re-rendered, while the info block re-renders freely as you move.
const MAP_WIDGET_ID = "00_map";
const INFO_WIDGET_ID = "01_map_info";

const HEADING_COLOR = "white";
const ROOM_TITLE_COLOR = "#9e9e9e";
const FLAG_COLOR = "#e0e0e0";
const FLAG_BG = "#3a3a3a";
// Base text size (px) for the panel's headings, notes, button labels, and notes editor,
// chosen via the `textSize` param (medium = 16, the prior built-in default).
const TEXT_SIZE = options.textSize;
// Flags read as secondary info, so render them a quarter below the base text size
// (at medium this is 12, matching the old hard-coded value).
const FLAG_SIZE = Math.round(TEXT_SIZE * 0.75);

// The notes editor is a single modal, reused for whichever heading you click. Its
// own widget so it overlays the rest of the Notes pane and tears down independently
// of the info block. It spans the pane's width.
const NOTES_EDITOR_ID = "02_notes_editor";
// Deliberately roomy: Iced's text editor handles overflowing text poorly, so give notes
// plenty of visible space before they need to scroll. Tune to taste.
const NOTES_EDITOR_HEIGHT = 480;
// A fresh editing buffer per open (TextEditor seeds `value` only when its id is new),
// so reopening always shows the latest saved notes rather than a stale draft.
let notesEditorSeq = 0;

// A heading line, right-aligned as the panel's visual accent. When `onEdit` is given
// the whole name becomes the click target (opening the notes editor); otherwise it's
// plain text. The label keeps the heading color via an explicit Text child, and the
// fill-width button lets a long name wrap within the panel instead of overflowing.
function heading(text: string, onEdit?: () => void, color: string = HEADING_COLOR) {
    const label = <Container width="fill" align_x="right"><Text color={color} size={TEXT_SIZE}>{text}</Text></Container>;
    return <Container width="fill" align_x="right">
        {onEdit
            ? <Button width="fill" variant="link" onPress={onEdit}>{label}</Button>
            : label}
    </Container>;
}

// Area/room notes, rendered as Markdown. Left-aligned prose (the right alignment on
// the headings is a visual accent; the notes read as body text).
function notes(text: string) {
    return <Container width="fill" align_x="left">
        <Markdown size={TEXT_SIZE}>{text}</Markdown>
    </Container>;
}

// A single flag pill. The Container carries the background; the inner Row carries the
// padding (Container has no padding prop of its own).
function flagChip(tag: string) {
    return <Container background={FLAG_BG}>
        <Row padding={4}><Text color={FLAG_COLOR} size={FLAG_SIZE}>{tag}</Text></Row>
    </Container>;
}

// A right-aligned row of a room's flags. A single (non-wrapping) Row, so a room with
// many long flags can overflow the panel width.
function flagsRow(tags: readonly string[]) {
    return <Container width="fill" align_x="right">
        <Row spacing={4}>{tags.map(flagChip)}</Row>
    </Container>;
}

// Open the notes editor over the Notes pane. `persist` does the actual write (room vs
// area); on save we re-read the cache and re-render the info block so the change
// shows at once.
function openNotesEditor(
    title: string,
    current: string,
    persist: (value: string) => Promise<OperationId | null>,
) {
    let draft = current;
    echo(current);
    const editorId = `${NOTES_EDITOR_ID}-input-${++notesEditorSeq}`;

    const commit = async () => {
        try {
            await persist(draft);
            removeWidget(NOTES_EDITOR_ID);
            state.refreshRoomAndArea();
            renderInfoWidget();
        } catch (error) {
            echo(`Could not save notes: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    // No onDismiss: a stray backdrop click shouldn't discard an in-progress edit;
    // Save and Discard are the only ways out.
    createWidget(NOTES_EDITOR_ID,
        <Modal>
            <Container background="#1e1e1e" width="fill">
                <Column width="fill" spacing={8} padding={16}>
                    <Text color={HEADING_COLOR} size={TEXT_SIZE}>{title}</Text>
                    <TextEditor id={editorId} value={current} height={NOTES_EDITOR_HEIGHT}
                                size={TEXT_SIZE}
                                placeholder="Notes (Markdown supported)"
                                onChange={(t) => { draft = t; }} />
                    <Row spacing={8}>
                        <Button variant="primary" onPress={commit}>Save</Button>
                        <Button onPress={() => removeWidget(NOTES_EDITOR_ID)}>Discard</Button>
                    </Row>
                </Column>
            </Container>
        </Modal>,
        { pane: NOTES_PANE });
}

// The live map: the Map pane's whole body, filling it in both directions. Mounted
// once; the MapView tracks the current location on its own.
function renderMapWidget() {
    createWidget(MAP_WIDGET_ID,
        <Container width="fill" height="fill"><MapView /></Container>,
        { pane: MAP_PANE });
}

// Area name + notes, then the current room's title + notes: the Notes pane's body.
// The headings + notes share a single vertical Scrollable so the block scrolls as
// one unit (preserving area -> room order) when the notes overflow the pane; the
// notes themselves render as Markdown.
function renderInfoWidget() {
    const area = state.area;
    const room = state.room;

    const areaName = area?.name ?? "";
    const areaNotes = area?.data("notes") ?? "";
    const roomTitle = room?.title ?? "";
    const roomNotes = room?.data("notes") ?? "";

    // Edit affordances only when there's something to write to.
    const editAreaNotes = area
        ? () => openNotesEditor(`${areaName || "Area"} notes`, areaNotes,
            (value) => mapper.setAreaProperty(area.id, "notes", value))
        : undefined;
    const editRoomNotes = room
        ? () => openNotesEditor(`${roomTitle || "Room"} notes`, roomNotes,
            (value) => mapper.setRoomProperty(room.area_id, room.room_number, "notes", value))
        : undefined;

    createWidget(INFO_WIDGET_ID,
        <Scrollable width="fill" height="fill" direction="vertical">
            <Column width="fill" spacing={2}>
                {heading(areaName, editAreaNotes)}
                {areaNotes ? notes(areaNotes) : null}
                {room ? heading(roomTitle, editRoomNotes, ROOM_TITLE_COLOR) : null}
                {room && room.tags.length > 0 ? flagsRow(room.tags) : null}
                {roomNotes ? notes(roomNotes) : null}
            </Column>
        </Scrollable>,
        { pane: NOTES_PANE });
}

renderMapWidget();
renderInfoWidget();
onAreaChanged(renderInfoWidget);
onRoomChanged(renderInfoWidget);
