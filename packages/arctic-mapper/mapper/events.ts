import { EventEmitter } from "node:events";

export interface RoomEvent {
    title: string;
    description: string[];
    objects: string[];
    mobs: string[];
    exits: string;
    line_number: number;
    prompt_line_number: number;
    prompt: string;
}

export const mapEvent = new EventEmitter<{
    room: [RoomEvent],
    visionFailed: [],
    moveFailed: [],
}>();
