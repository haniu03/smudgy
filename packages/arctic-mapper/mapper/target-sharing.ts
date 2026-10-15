import { getSessions, session, type EventSubscription, type Session, type StateHandle } from "smudgy:core";
import { created, connected, disconnected, destroyed } from "smudgy:events/sessions";
import { sessionTarget as remoteTarget } from "smudgy:state/@arctic-mapper";
import type { SetTargetRequest } from "../index.ts";
import { onRoomChanged, state } from "./mapper.ts";
import { targets } from "./targets.ts";

/** Publish our location and track the latest snapshot from every other session. */
export function startTargetSharing(publisher: StateHandle<SetTargetRequest>): void {
    const subscriptions = new Map<number, EventSubscription>();
    const publish = () => {
        const room = session.connected ? state.room : null;
        publisher.set({
            name: session.profile.name?.trim() || `Session ${session.id}`,
            location: room ? { areaId: room.areaId, roomNumber: room.roomNumber } : null,
        });
    };
    const watch = (other: Session) => {
        if (other.id === session.id) return;
        const view = remoteTarget.from(other);
        const receive = (snapshot: Readonly<SetTargetRequest> | undefined) => {
            if (!other.connected || !snapshot) targets.removeSession(other.id);
            else targets.set(snapshot, other.id);
        };
        if (!subscriptions.has(other.id)) subscriptions.set(other.id, view.watch(receive));
        // Watchers report later writes; explicitly read the current snapshot so
        // a newly loaded mapper can target a character already standing still.
        receive(view.value);
    };
    onRoomChanged(publish);
    created.on(watch);
    connected.on(other => { if (other.id === session.id) publish(); else watch(other); });
    disconnected.on(other => {
        if (other.id === session.id) publish();
        else targets.removeSession(other.id);
    });
    destroyed.on(other => {
        subscriptions.get(other.id)?.off();
        subscriptions.delete(other.id);
        targets.removeSession(other.id);
    });
    for (const other of getSessions()) watch(other);
    publish();
}
