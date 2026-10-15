/**
 * Auto-mapper for ArcticMUD.
 *
 * Entry point and public API. Cross-package callers use the procedure surface.
 * Requires arctic-prompt — see README.md for setup and usage.
 */

import './mapper/room-capturer.ts';
import './mapper/alias.ts';
import { createProcedure, createState } from 'smudgy:core';
import { targets } from './mapper/targets.ts';
import { startTargetSharing } from './mapper/target-sharing.ts';

/** A v3 room address: use the room's actual areaId, including Private/Secret areas. */
export interface TargetLocation {
    areaId: string;
    roomNumber: number;
}

/** Create/replace a target in the receiving session, or remove it with location: null. */
export interface SetTargetRequest {
    name: string;
    location: TargetLocation | null;
}

/** Record a named destination for >$name in this session. Does not start walking. */
export const setTarget = createProcedure<SetTargetRequest>('setTarget', request => targets.set(request));

/** This session's current location, shared under its profile name with other sessions. */
export const sessionTarget = createState<SetTargetRequest>('sessionTarget');
startTargetSharing(sessionTarget);

export { mapEvent } from './mapper/events.ts';
export type { RoomEvent } from './mapper/events.ts';
export { onAreaChanged, onRoomChanged, onModeChanged, options, speedwalk, state, State } from './mapper/mapper.ts';
export type { MoveCommand } from './mapper/mapper.ts';
export { Direction, DirectionLetter, MoveCommands, RoomFlags } from './mapper/mapper.ts';

import './mapper/widget.tsx';
