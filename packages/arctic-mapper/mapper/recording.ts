import { observedDoor } from "./doors.ts";

/** Update only unambiguous observed doors, through the exit's owning source. */
export async function recordObservedDoors(
    mapper: Pick<Mapper, "setRoomExit">,
    room: Room,
    observations: readonly { direction: ExitDirection; closed: boolean }[],
): Promise<void> {
    for (const observation of observations) {
        const exits = room.exits.filter(e => e.fromDirection === observation.direction);
        if (exits.length !== 1) continue;
        const exit = exits[0];
        const door = observedDoor(exit.door, observation.closed);
        if (door?.state !== exit.door?.state) {
            await mapper.setRoomExit(room.areaId, room.roomNumber, exit.id, { door });
        }
    }
}
