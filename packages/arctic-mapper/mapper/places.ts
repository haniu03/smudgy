import { paletteColor } from "./palette.ts";

export function placeKey(place: MapPlace): string {
    return typeof place === "string" ? place : place.id;
}

export function placeName(place: MapPlace): string {
    return place === "map" ? "Map" : place === "private" ? "Private" : place.name;
}

// Match the map editor's alphabetical order, including deterministic ties.
function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export function comparePlaces(a: MapPlace, b: MapPlace): number {
    const rank = (place: MapPlace) => place === "private" ? 0 : place === "map" ? 2 : 1;
    return rank(a) - rank(b)
        || compareText(placeName(a).toLowerCase(), placeName(b).toLowerCase())
        || compareText(placeName(a), placeName(b))
        || compareText(placeKey(a), placeKey(b));
}

export function orderedPlaces(map: Pick<Area, "places">): MapPlace[] {
    return [...map.places].sort(comparePlaces);
}

/** The editor's explicit color, or the same seeded palette color it uses. */
export function placeColor(map: Pick<Area, "name" | "places">, place: MapPlace): string {
    if (place === "map") return "#a8a8a8";
    if (typeof place !== "string" && place.color) return place.color;
    const secrets = orderedPlaces(map).filter((p): p is Secret => typeof p !== "string");
    const index = place === "private" ? secrets.length : secrets.findIndex(p => p.id === place.id);
    return paletteColor([map.name, secrets[0]?.name ?? ""], Math.max(0, index));
}

/** The same ordering drives display, the editor, shortcuts and the prompt hint. */
export function roomNotes(room: Pick<Room, "combinedData"> | null): RoomPlaceData[] {
    return [...(room?.combinedData("notes") ?? [])].sort((a, b) => comparePlaces(a.source, b.source));
}

export function areaNotes(map: Pick<Area, "places" | "in">): RoomPlaceData[] {
    return orderedPlaces(map).flatMap(source => {
        const data = map.in(source).data("notes");
        return data === undefined ? [] : [{ source, data }];
    });
}

export function notesLinks<T>(room: Pick<Room, "combinedData"> | null, extract: (text: string) => T[]): T[] {
    return roomNotes(room).flatMap(note => extract(note.data));
}

/** Separate buffers: selecting a place never copies a note into another audience. */
export class NoteDrafts {
    readonly #drafts = new Map<string, string>();

    value(place: MapPlace, read: () => string | undefined): string {
        const key = placeKey(place);
        if (!this.#drafts.has(key)) this.#drafts.set(key, read() ?? "");
        return this.#drafts.get(key)!;
    }

    set(place: MapPlace, value: string) {
        this.#drafts.set(placeKey(place), value);
    }
}
