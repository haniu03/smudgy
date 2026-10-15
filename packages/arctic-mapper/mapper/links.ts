import { idsMatch } from "./ids.ts";
import { placeKey } from "./places.ts";

type LinkWriter = Pick<AreaMutator, "createRoomExit" | "setRoomExit">;
type Destination = ExitArgs & { toAreaId: AreaId; toRoomNumber: RoomNumber };

export function linkCandidate(room: Pick<Room, "exits">, destination: Destination): Exit | undefined {
    const exits = room.exits.filter(e => e.fromDirection === destination.fromDirection);
    const connected = exits.find(e => e.toRoomNumber === destination.toRoomNumber
        && idsMatch(e.toAreaId, destination.toAreaId));
    if (connected) return connected;
    const stubs = exits.filter(e => e.toRoomNumber === null && (e.toAreaId === null || idsMatch(e.toAreaId, destination.toAreaId)));
    if (stubs.length > 1) throw new Error(`Multiple unlinked ${destination.fromDirection} exits; choose one in the map editor.`);
    return stubs[0];
}

/** A single-place room batch cannot update an attachment owned by another place. */
export function linkNeedsOtherPlace(room: Pick<Room, "place" | "exits">, destination: Destination): boolean {
    const exit = linkCandidate(room, destination);
    return !!exit && exit.toRoomNumber === null && placeKey(exit.place) !== placeKey(room.place);
}

/** Extend a dangling traversal in place. No door, command, flag or geometry is replaced. */
export async function extendExit(
    writer: LinkWriter,
    room: Pick<Room, "roomNumber" | "exits" | "place">,
    destination: Destination,
): Promise<ExitId> {
    const stub = linkCandidate(room, destination);
    if (stub && stub.toRoomNumber !== null) return stub.id;
    if (stub) {
        await writer.setRoomExit(room.roomNumber, stub.id, {
            toAreaId: destination.toAreaId,
            toRoomNumber: destination.toRoomNumber,
            toDirection: destination.toDirection,
        });
        return stub.id;
    }
    return writer.createRoomExit(room.roomNumber, destination);
}
