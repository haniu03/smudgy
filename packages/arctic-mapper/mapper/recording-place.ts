import { extendExit } from "./links.ts";
import { orderedPlaces, placeKey } from "./places.ts";

/** Explicit choices belong to the parent map, not the room we happen to enter. */
export class RecordingPlaces {
    readonly #selected = new Map<string, string>();

    place(map: Area, current: MapPlace = "map"): MapPlace {
        if (!this.#selected.has(map.id)) this.#selected.set(map.id, placeKey(current));
        const key = this.#selected.get(map.id)!;
        if (key === "map" || key === "private") return key;
        // A removed or unreadable Secret must never silently fall back to Map.
        return map.secrets.get(key);
    }

    select(map: Area, place: MapPlace): void {
        if (!orderedPlaces(map).some(p => placeKey(p) === placeKey(place))) {
            throw new Error("This recording place is no longer available.");
        }
        if (typeof place !== "string" && (!place.actions.includes("add") || !place.actions.includes("edit"))) {
            throw new Error("Recording requires permission to add and edit this Secret's content.");
        }
        recordingArea(map, place); // Validate before replacing a working selection.
        this.#selected.set(map.id, placeKey(place));
    }
}

export function recordingArea(map: Area, place: MapPlace): Area {
    if (place === "map") return map;
    if (typeof place !== "string") return place.area;
    const area = map.in("private").area;
    if (!area) throw new Error("Selecting Private for recording requires a Smudgy build with AreaView.area support.");
    return area;
}

/** The place that keeps a new link out of `room`: a Secret's or Private's own room keeps its
 *  own exits, and a map room keeps the recording place's door. */
export function linkOwner(room: Pick<Room, "place">, recording: MapPlace): MapPlace {
    return room.place === "map" ? recording : room.place;
}

/** New links follow {@link linkOwner}; existing stubs retain their identity and owner. */
export async function extendRecordedExit(
    mapper: Pick<Mapper, "setRoomExit">,
    room: Room,
    place: MapPlace,
    destination: ExitArgs & { toAreaId: AreaId; toRoomNumber: RoomNumber },
): Promise<ExitId> {
    const owner = linkOwner(room, place);
    return extendExit({
        createRoomExit: (_number, exit) => room.in(owner).createExit(exit),
        setRoomExit: async (_number, id, update) => { await mapper.setRoomExit(room.areaId, room.roomNumber, id, update); },
    }, room, destination);
}
