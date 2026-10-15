import type { SetTargetRequest, TargetLocation } from "../index.ts";

export interface SpeedwalkTarget {
    name: string;
    location: TargetLocation;
}

/** Targets belong to this session; automatic targets also remember their source. */
export class TargetRegistry {
    readonly #targets = new Map<string, SpeedwalkTarget & { sessionId?: number }>();
    readonly #sessionNames = new Map<number, string>();

    set(request: SetTargetRequest, sessionId?: number): void {
        if (typeof request?.name !== "string" || !request.name.trim()) {
            throw new TypeError("A speedwalk target needs a nonempty name.");
        }
        const name = request.name.trim();
        const key = name.toLowerCase();
        const location = request.location;
        if (location !== null && (typeof location?.areaId !== "string" || !location.areaId.trim()
            || !Number.isInteger(location.roomNumber) || location.roomNumber < 1 || location.roomNumber > 2147483647)) {
            throw new TypeError("A target location needs an areaId and a positive roomNumber, or null to remove it.");
        }
        if (sessionId !== undefined) this.removeSession(sessionId);
        if (location === null) {
            if (sessionId === undefined) this.#targets.delete(key);
            return;
        }
        this.#targets.set(key, { name, location: { areaId: location.areaId, roomNumber: location.roomNumber }, sessionId });
        if (sessionId !== undefined) this.#sessionNames.set(sessionId, key);
    }

    removeSession(sessionId: number): void {
        const key = this.#sessionNames.get(sessionId);
        if (key !== undefined && this.#targets.get(key)?.sessionId === sessionId) this.#targets.delete(key);
        this.#sessionNames.delete(sessionId);
    }

    find(prefix: string): SpeedwalkTarget {
        const wanted = prefix.trim().toLowerCase();
        const exact = this.#targets.get(wanted);
        if (exact) return exact;
        const matches = [...this.#targets.entries()]
            .filter(([key]) => wanted && key.startsWith(wanted))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, target]) => target);
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) throw new Error(`Target "$${prefix.trim()}" matches ${matches.map(target => target.name).join(", ")}. Use a longer name.`);
        throw new Error(`No speedwalk target matches "$${prefix.trim()}".`);
    }
}

export const targets = new TargetRegistry();
