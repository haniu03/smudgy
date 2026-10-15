/** Area names use the same exact-then-prefix rule for both speedwalk forms. */
export function findAreaByName(areas: readonly Area[], prefix: string): Area | undefined {
    const wanted = prefix.trim().toLowerCase();
    if (!wanted) return undefined;
    return areas.find(area => area.name.toLowerCase() === wanted)
        ?? areas.find(area => area.name.toLowerCase().startsWith(wanted));
}

type RouteMapper = Pick<Mapper, "getPathBetweenRooms" | "getAreaById">;

/** Compare mapped route costs, not unrelated coordinates in different areas. */
export function roomRouteCost(mapper: RouteMapper, here: Room, room: Room): number {
    if (room.areaId === here.areaId && room.roomNumber === here.roomNumber) return 0;
    const path = mapper.getPathBetweenRooms(here.areaId, here.roomNumber, room.areaId, room.roomNumber);
    if (path.length < 2) return Infinity;
    let cost = 0;
    for (let i = 1; i < path.length; i++) {
        const [fromArea, fromNumber] = path[i - 1];
        const [toArea, toNumber] = path[i];
        const exits = mapper.getAreaById(fromArea).room(fromNumber)?.exits ?? [];
        const weights = exits.filter(exit => exit.toAreaId === toArea && exit.toRoomNumber === toNumber)
            .map(exit => exit.weight);
        cost += Math.min(...weights);
    }
    return cost;
}

/** Search only the named area's candidates; never fall back to another area. */
export function findNearestRoomWithTagsInArea(
    mapper: RouteMapper,
    here: Room,
    area: Area,
    all: string[],
    none: string[],
): Room | undefined {
    if (all.length === 0 && none.length === 0) return undefined;
    // The area's indexed lookup also finds tags and rooms in readable places.
    const candidates = all.length > 0
        ? area.findRoomsWithTag(all[0])
        : area.roomNumbers.map(number => area.room(number)).filter((room): room is Room => !!room);
    let best: Room | undefined;
    let bestCost = Infinity;
    for (const room of candidates) {
        if (!all.every(tag => room.hasTag(tag)) || none.some(tag => room.hasTag(tag))) continue;
        const cost = roomRouteCost(mapper, here, room);
        if (cost < bestCost) {
            best = room;
            bestCost = cost;
        }
    }
    return best;
}
