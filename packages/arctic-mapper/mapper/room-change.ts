/** A likely change of physical rooms, rather than a map/UI location refresh. */
export interface RoomChangedEvent {
    /** True only when the destination could be resolved on the loaded map. */
    mapped: boolean;
    areaId: string | null;
    roomNumber: number | null;
    /** Null when darkness or blindness prevents seeing the room. */
    title: string | null;
}

type Location = { areaId: string; roomNumber: number };
type RoomText = { title: string; description: readonly string[] };
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** One previous observation is enough; never retain room contents or scan the map. */
export class RoomChangeTracker {
    private previous: { title: string | null; description: string | null; location: Location | null } | null = null;

    reset(): void {
        this.previous = null;
    }

    observe(room: RoomText | null, direction: string | undefined, location: Location | null): RoomChangedEvent | null {
        const previous = this.previous;
        const moved = direction !== undefined && direction !== "look";
        const title = room ? normalize(room.title) : null;
        const description = room ? normalize(room.description.join(" ")) || null : null;
        const sameMappedRoom = previous?.location != null && location != null
            && previous.location.areaId === location.areaId
            && previous.location.roomNumber === location.roomNumber;
        // Missing descriptions (brief mode, darkness, blindness) aren't changes.
        const changedText = previous?.title != null && title !== null
            && (previous.title !== title || (previous.description !== null
                && description !== null && previous.description !== description));
        const changed = !sameMappedRoom && (moved || changedText);

        this.previous = {
            title: title ?? (!moved ? previous?.title ?? null : null),
            description: description ?? (!moved && !changedText ? previous?.description ?? null : null),
            location: location ? { ...location } : null,
        };
        if (!changed) return null;
        return { mapped: location !== null, areaId: location?.areaId ?? null,
            roomNumber: location?.roomNumber ?? null, title: room?.title ?? null };
    }
}
