import { createWidget, removeWidget, Button, Checkbox, Column, Container, MapView, Markdown, Modal, Row, Scrollable, Text, TextEditor } from 'smudgy:widgets';
import { mapper, session } from 'smudgy:core';

import { onInfoChanged, options, state, State } from './mapper.ts';
import { areaNotes, NoteDrafts, orderedPlaces, placeColor, placeKey, placeName, roomNotes } from './places.ts';


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
const CONNECTION_DECISION_ID = "03_connection_decision";
const SECRET_EDITOR_ID = "04_recording_secret";
const ROOM_MOVE_ID = "05_room_move";

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
let secretEditorSeq = 0;
let recordingExpanded = false;
let recordingError = "";
let recordingMapId: AreaId | undefined;
let movingRoom = false;

async function moveRoomToPlace(room: Room, place: MapPlace) {
    if (movingRoom) return;
    const mapId = state.area?.mapId ?? state.area?.id;
    movingRoom = true;
    recordingError = "";
    renderInfoWidget();
    const finish = (error = "") => {
        movingRoom = false;
        removeWidget(ROOM_MOVE_ID);
        // A move may finish after the player has walked to another map.
        if ((state.area?.mapId ?? state.area?.id) === mapId) {
            recordingError = error;
        }
        renderInfoWidget();
    };
    try {
        const current = mapper.getAreaById(room.areaId).room(room.roomNumber);
        if (!current) throw new Error("This room is no longer available.");
        if (typeof current.prepareMoveTo !== "function") {
            throw new Error("Moving rooms requires a Smudgy build with Room.prepareMoveTo support.");
        }
        const prepared = await current.prepareMoveTo(place);
        let submitted = false;
        const commit = async () => {
            if (submitted) return;
            submitted = true;
            removeWidget(ROOM_MOVE_ID);
            try {
                const moved = await prepared.commit({ confirm: prepared.requiresConfirmation });
                // The host also sends a location event. Adopt the result only if the
                // player is still in the room we moved, never after walking away.
                if (state.room?.areaId === room.areaId && state.room.roomNumber === room.roomNumber) {
                    state.setCurrentRoom(moved);
                }
                finish();
            } catch (caught) {
                finish(`Could not move room: ${caught instanceof Error ? caught.message : String(caught)}`);
            }
        };
        if (!prepared.requiresConfirmation) { await commit(); return; }
        createWidget(ROOM_MOVE_ID,
            <Modal><Container background="#1e1e1e" width="fill">
                <Column width="fill" spacing={8} padding={16}>
                    <Text size={TEXT_SIZE}>{`Move #${room.roomNumber} · ${room.title} to ${placeName(place)}`}</Text>
                    <Scrollable height={240} width="fill"><Column spacing={8}>
                        {prepared.messages.map(message => <Text size={TEXT_SIZE}>{message}</Text>)}
                    </Column></Scrollable>
                    <Row spacing={8}>
                        <Button variant="primary" onPress={() => { void commit(); }}>Confirm move</Button>
                        <Button onPress={() => { submitted = true; finish(); }}>Cancel</Button>
                    </Row>
                </Column>
            </Container></Modal>, { pane: NOTES_PANE });
    } catch (caught) {
        finish(`Could not move room: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
}

function openRecordingSecretEditor(map: Area) {
    let name = "";
    let created: Secret | undefined;
    let busy = false;
    let error = "";
    const inputId = `${SECRET_EDITOR_ID}-${++secretEditorSeq}`;
    const create = async () => {
        if (busy) return;
        const title = name.trim();
        if (!title) { error = "Enter a Secret name."; render(); return; }
        busy = true; error = ""; render();
        try {
            const currentMap = mapper.getAreaById(map.id);
            // Omit color: use the same automatic palette as the map editor.
            created ??= await currentMap.secrets.create({ name: title });
            state.selectRecordingPlace(mapper.getAreaById(map.id), created);
            recordingError = "";
            removeWidget(SECRET_EDITOR_ID);
            renderInfoWidget();
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
            busy = false; render();
        }
    };
    const render = () => createWidget(SECRET_EDITOR_ID,
        <Modal><Container background="#1e1e1e" width="fill">
            <Column width="fill" spacing={8} padding={16}>
                <Text size={TEXT_SIZE}>New Secret in {map.name}</Text>
                <TextEditor id={inputId} value={name} height={64} size={TEXT_SIZE}
                    placeholder="Secret name" onChange={text => { if (!busy) name = text; }} />
                <Text size={FLAG_SIZE}>Color: automatic</Text>
                {error ? <Text color="#ffb38a" size={TEXT_SIZE}>{error}</Text> : null}
                <Row spacing={8}>
                    <Button variant="primary" onPress={busy ? undefined : () => { void create(); }}>
                        {busy ? "Creating…" : "Create and select"}
                    </Button>
                    <Button onPress={busy ? undefined : () => removeWidget(SECRET_EDITOR_ID)}>Cancel</Button>
                </Row>
            </Column>
        </Container></Modal>, { pane: NOTES_PANE });
    render();
}

function recordingControls(map: Area) {
    if (recordingMapId !== map.id) {
        recordingMapId = map.id; recordingExpanded = false; recordingError = "";
    }
    let selected: MapPlace | undefined;
    try { selected = state.recordingPlaces.place(map, state.area?.place); }
    catch (caught) { recordingError = caught instanceof Error ? caught.message : String(caught); }
    const room = state.room;
    return <Column width="fill" spacing={4}>
        <Checkbox checked={options.autoAdjustMapLayout} onToggle={checked => {
            options.autoAdjustMapLayout = checked;
            renderInfoWidget();
        }}>Automatically adjust map layout</Checkbox>
        <Button width="fill" onPress={() => { recordingExpanded = !recordingExpanded; renderInfoWidget(); }}>
            <Row spacing={6}>
                <Text size={TEXT_SIZE}>Record into</Text>
                {selected ? placeBadge(map, selected) : <Text>Unavailable place</Text>}
                <Text>{recordingExpanded ? "▴" : "▾"}</Text>
            </Row>
        </Button>
        {recordingExpanded ? <Scrollable height={160} width="fill"><Column width="fill" spacing={4}>
            <Column width="fill" spacing={4}>{orderedPlaces(map).map(place => {
                const writable = typeof place === "string" || (place.actions.includes("add") && place.actions.includes("edit"));
                return <Button width="fill" onPress={!writable ? undefined : () => {
                    try {
                        const fresh = mapper.getAreaById(map.id);
                        const choice = typeof place === "string" ? place : fresh.secrets.get(place.id);
                        state.selectRecordingPlace(fresh, choice);
                        recordingExpanded = false; recordingError = "";
                    } catch (caught) { recordingError = caught instanceof Error ? caught.message : String(caught); }
                    renderInfoWidget();
                }}><Row spacing={6}>{placeBadge(map, place)}{!writable ? <Text size={FLAG_SIZE}>Read only</Text> : null}</Row></Button>;
            })}</Column>
            {map.storage === "cloud" ? <Button width="fill" onPress={() => {
                recordingExpanded = false; renderInfoWidget(); openRecordingSecretEditor(map);
            }}>New Secret…</Button> : null}
        </Column></Scrollable> : null}
        {room && selected && placeKey(room.place) !== placeKey(selected) ? <Button width="fill"
            onPress={movingRoom ? undefined : () => { void moveRoomToPlace(room, selected!); }}>
            {movingRoom ? "Moving room…" : `Move current room to ${placeName(selected)}`}
        </Button> : null}
        {recordingError ? <Text color="#ffb38a" size={FLAG_SIZE}>{recordingError}</Text> : null}
    </Column>;
}

export interface ExistingRoomConnectionOption {
    roomNumber: RoomNumber;
    x: number;
    y: number;
    level: number;
}

export type ExistingRoomConnectionDecision =
    | { type: "connect"; roomNumber: RoomNumber }
    | { type: "create" };

/** Ask a mapping question over the map pane and pause the caller until it is answered. */
export function requestExistingRoomConnection(
    title: string,
    options: readonly ExistingRoomConnectionOption[],
    canReflow = true,
): Promise<ExistingRoomConnectionDecision> {
    if (options.length === 0) return Promise.resolve({ type: "create" });

    return new Promise((resolve) => {
        const finish = (decision: ExistingRoomConnectionDecision) => {
            removeWidget(CONNECTION_DECISION_ID);
            resolve(decision);
        };

        createWidget(CONNECTION_DECISION_ID,
            <Modal>
                <Container background="#1e1e1e" width="fill">
                    <Column width="fill" spacing={8} padding={16}>
                        <Text color={HEADING_COLOR} size={TEXT_SIZE}>Possible map connection</Text>
                        <Markdown size={TEXT_SIZE}>
                            {`Another mapped room named \`${title}\` looks identical and could connect here${canReflow ? " by shifting some rooms on the map" : " in the selected recording place"}.`}
                        </Markdown>
                        <Text size={TEXT_SIZE}>
                            These may be the same room reached by different routes, or two separate rooms that look alike.
                        </Text>
                        <Column width="fill" spacing={8}>
                            {options.map((option) =>
                                <Button variant="primary" onPress={() => finish({ type: "connect", roomNumber: option.roomNumber })}>
                                    {`${canReflow ? "Shift map and connect" : "Connect"} to #${option.roomNumber} at ${option.x}, ${option.y}, ${option.level}`}
                                </Button>
                            )}
                        </Column>
                        <Button onPress={() => finish({ type: "create" })}>Create a separate room</Button>
                    </Column>
                </Container>
            </Modal>,
            { pane: MAP_PANE });
    });
}

// A heading line, right-aligned as the panel's visual accent. When `onEdit` is given
// the whole name becomes the click target (opening the notes editor); otherwise it's
// plain text. The label keeps the heading color via an explicit Text child, and the
// fill-width button lets a long name wrap within the panel instead of overflowing.
function placeBadge(map: Area, place: MapPlace) {
    return <Container background={FLAG_BG}>
        <Row padding={4}><Text color={placeColor(map, place)} size={FLAG_SIZE}>{placeName(place)}</Text></Row>
    </Container>;
}

function heading(text: string, onEdit?: () => void, color: string = HEADING_COLOR, map?: Area, place?: MapPlace) {
    const label = <Row width="fill" spacing={4}>
        <Container width="fill" align_x="right"><Text color={color} size={TEXT_SIZE}>{text}</Text></Container>
        {map && place && place !== "map" ? placeBadge(map, place) : null}
    </Row>;
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

// Edit one place's notes at a time, keeping each place's draft while switching.
function openNotesEditor(map: Area, room?: Room, initialPlace?: MapPlace) {
    // Pin the target while walking. Every write uses a fresh handle at this address.
    const places = orderedPlaces(map);
    let selected: MapPlace = initialPlace ?? room?.place ?? state.area?.place ?? "map";
    let expanded = false;
    let busy = false;
    let error = "";
    let selectionUnavailable = false;
    if (initialPlace === undefined) {
        try { selected = state.recordingPlaces.place(map, selected); }
        catch (caught) { selectionUnavailable = true; error = caught instanceof Error ? caught.message : String(caught); }
    }
    const drafts = new NoteDrafts();
    let editorId = `${NOTES_EDITOR_ID}-input-${++notesEditorSeq}`;
    const title = `${room?.title || map.name || "Map"} notes`;
    const view = (place: MapPlace): RoomView | AreaView => {
        if (!room) return mapper.getAreaById(map.id).in(place);
        const current = mapper.getAreaById(room.areaId).room(room.roomNumber);
        if (!current) throw new Error("This room is no longer available.");
        return current.in(place);
    };
    const commit = async (remove = false) => {
        if (busy) return;
        const place = selected;
        const draft = drafts.value(place, () => view(place).data("notes"));
        busy = true;
        error = "";
        render();
        try {
            if (remove) await view(place).deleteData("notes");
            else await view(place).setData("notes", draft);
            removeWidget(NOTES_EDITOR_ID);
            state.refreshRoomAndArea();
            renderInfoWidget();
        } catch (caught) {
            busy = false;
            error = `Could not ${remove ? "delete" : "save"} notes: ${caught instanceof Error ? caught.message : String(caught)}`;
            render();
        }
    };
    const render = () => {
        const place = selected;
        let current: string | undefined;
        let readable = true;
        try { current = view(place).data("notes"); }
        catch (caught) {
            readable = false;
            error = caught instanceof Error ? caught.message : String(caught);
        }
        const draft = drafts.value(place, () => current);
        const canSave = !selectionUnavailable && readable && (typeof place === "string" || place.actions.includes("edit"));
        const canDelete = !selectionUnavailable && readable && (typeof place === "string" || place.actions.includes("remove"));
        // The script widget API has no native select. This button expands a bounded
        // dropdown of place choices; the separate editor buffers survive selection.
        createWidget(NOTES_EDITOR_ID,
            <Modal>
                <Container background="#1e1e1e" width="fill">
                    <Column width="fill" spacing={8} padding={16}>
                        <Text color={HEADING_COLOR} size={TEXT_SIZE}>{title}</Text>
                        <Button width="fill" onPress={busy ? undefined : () => { expanded = !expanded; render(); }}>
                            <Row spacing={8}>
                                <Text size={TEXT_SIZE}>Place</Text>
                                {selectionUnavailable ? <Text>Choose a place</Text> : placeBadge(map, place)}
                                <Text>{expanded ? "▴" : "▾"}</Text>
                            </Row>
                        </Button>
                        {expanded ? <Scrollable height={160} width="fill">
                            <Column width="fill" spacing={4}>
                                {places.map(choice => <Button width="fill" onPress={busy ? undefined : () => {
                                    selected = choice;
                                    selectionUnavailable = false;
                                    expanded = false;
                                    error = "";
                                    editorId = `${NOTES_EDITOR_ID}-input-${++notesEditorSeq}`;
                                    render();
                                }}>{placeBadge(map, choice)}</Button>)}
                            </Column>
                        </Scrollable> : null}
                        {canSave ? <TextEditor id={editorId} value={draft} height={NOTES_EDITOR_HEIGHT}
                            size={TEXT_SIZE} placeholder="Notes (Markdown supported)"
                            onChange={(text) => { if (!busy) drafts.set(place, text); }} />
                            : <Scrollable height={NOTES_EDITOR_HEIGHT}>{notes(current || "No notes in this place.")}</Scrollable>}
                        {!canSave ? <Text size={FLAG_SIZE}>You can read this place’s notes but cannot edit them.</Text> : null}
                        {error ? <Text color="#ff8a80" size={TEXT_SIZE}>{error}</Text> : null}
                        <Row spacing={8}>
                            <Button variant="primary" onPress={!busy && canSave ? () => { void commit(); } : undefined}>
                                {busy ? "Saving…" : "Save"}
                            </Button>
                            <Button onPress={!busy && canDelete && current !== undefined ? () => { void commit(true); } : undefined}>Delete</Button>
                            <Button onPress={busy ? undefined : () => removeWidget(NOTES_EDITOR_ID)}>Discard</Button>
                        </Row>
                    </Column>
                </Container>
            </Modal>, { pane: NOTES_PANE });
    };
    render();
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
    const map = area ? mapper.getAreaById(area.mapId ?? area.id) : undefined;
    const place = room?.place ?? area?.place;
    const recording = state.state === State.Mapping;
    const roomTitle = room ? `${recording ? `#${room.roomNumber} · ` : ""}${room.title}` : "";
    const noteBlocks = (entries: RoomPlaceData[], target?: Room) => map ? <Column width="fill" spacing={4}>{entries.map(note =>
        <Column width="fill" spacing={2}>
            {entries.length > 1 || note.source !== "map" ? <Button variant="link" onPress={() => openNotesEditor(map, target, note.source)}>
                {placeBadge(map, note.source)}
            </Button> : null}
            {notes(note.data)}
        </Column>)}</Column> : null;

    createWidget(INFO_WIDGET_ID,
        <Scrollable width="fill" height="fill" direction="vertical">
            <Column width="fill" spacing={2}>
                {recording ? <Container background="#593021"><Row padding={4} spacing={6}>
                    <Text color="#ffb38a" size={TEXT_SIZE}>● Recording</Text>
                    {!room ? <Text size={FLAG_SIZE}>Room unknown</Text> : null}
                </Row></Container> : null}
                {recording && map ? recordingControls(map) : null}
                {heading(map?.name ?? "", map ? () => openNotesEditor(map) : undefined, HEADING_COLOR, map, place)}
                {map ? noteBlocks(areaNotes(map)) : null}
                {room ? heading(roomTitle, map ? () => openNotesEditor(map, room) : undefined, ROOM_TITLE_COLOR, map, room.place) : null}
                {room && room.tags.length > 0 ? flagsRow(room.tags) : null}
                {noteBlocks(roomNotes(room), room ?? undefined)}
            </Column>
        </Scrollable>,
        { pane: NOTES_PANE });
}

renderMapWidget();
renderInfoWidget();
// State updates can replace area and room together. Render their final snapshots
// once, without ever re-mounting the MapView.
let renderScheduled = false;
onInfoChanged(() => {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
        renderScheduled = false;
        renderInfoWidget();
    });
});
