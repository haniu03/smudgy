/**
 * The geometry of the mapper's own links on one level. map-layout's route
 * planner chooses each route, around every other link as it is drawn: one
 * that leaves a wall facing away from its room, runs across a room or crosses
 * another link takes a route of rounded orthogonal turns, and any other runs
 * straight. Links that crowd a stretch no lane could separate are called out
 * at double width, each in a color of its own. A link between Up and Down
 * exits always runs straight, whatever levels its rooms are on.
 */

import type { GridPosition } from "./layout.ts";
import {
  isLinkCalloutColor,
  LINK_CALLOUT_THICKNESS,
  linkCalloutColor,
  planLinkRoutes,
  type RouteLink,
  type RoutePoint,
  type RouteSide,
} from "smudgy:@map-layout/link-routes.ts";

export const DEFAULT_LINK_COLOR = "#A4A4A4";
export const DEFAULT_LINK_THICKNESS = 1;

export interface RoutingEndpoint {
  roomNumber: number;
  side: RouteSide;
  portOffset: number;
  portMode: "AutoPinned" | "Manual";
}

/** A link's stored geometry and style, as the mapper writes it. */
export interface LinkGeometry {
  endpointA: RoutingEndpoint;
  endpointB: RoutingEndpoint;
  routing: "Stub" | "Simple" | "Manual" | "Automatic";
  segmentShape: "Direct" | "Orthogonal";
  corner: "Sharp" | "Rounded";
  routePoints: RoutePoint[];
  color: string;
  thickness: number;
}

/** Whether an exit leaves upward or downward. */
export function isVerticalDirection(direction: string | null | undefined): boolean {
  return direction === "Up" || direction === "Down";
}

/** One link on the level, as the mapper sees it. */
export type RoutingLink = {
  id: string;
  /** Layout ids of its rooms: keys of the planner's room positions. */
  from: string;
  to: string;
  geometry: LinkGeometry;
} & (
  | {
    /** The mapper's own link: the planner chooses its route out of these walls. */
    role: "route";
    sides: [RouteSide, RouteSide];
  }
  | {
    /** The mapper's own link between Up and Down exits, which always runs straight. */
    role: "vertical";
  }
  | {
    /** A link the mapper leaves as it is drawn, for routes to avoid. */
    role: "keep";
  }
);

export interface RoutingDecision {
  id: string;
  geometry: LinkGeometry;
  /** Whether the link takes a route. */
  routed: boolean;
  /** Whether the link is called out where it crowds a stretch. */
  callout: boolean;
}

function drawnPoints(geometry: LinkGeometry): RoutePoint[] | undefined {
  return geometry.routing === "Manual" || geometry.routing === "Automatic" ? geometry.routePoints : undefined;
}

/**
 * Decide the geometry of every `route` and `vertical` link. `rooms` holds every
 * room and planned room by layout id, for routes to avoid; `mapId` seeds the
 * callout colors.
 */
export function planLinkGeometry(
  rooms: ReadonlyMap<string, GridPosition>,
  links: readonly RoutingLink[],
  mapId: string,
): RoutingDecision[] {
  const decisions: RoutingDecision[] = [];
  const planned: RouteLink[] = [];
  const routed = new Map<string, Extract<RoutingLink, { role: "route" }>>();
  for (const link of links) {
    const { geometry } = link;
    if (link.role === "vertical") {
      // A hand-drawn route stays stored, dormant, for its author to restore;
      // the mapper's own route is dropped.
      const authored = geometry.routing === "Manual";
      decisions.push({
        id: link.id,
        routed: false,
        callout: false,
        geometry: {
          ...geometry,
          routing: "Simple",
          segmentShape: authored ? geometry.segmentShape : "Direct",
          routePoints: authored ? geometry.routePoints : [],
          ...withoutCallout(geometry, mapId),
        },
      });
      planned.push({
        id: link.id, from: link.from, to: link.to,
        fromSide: geometry.endpointA.side, toSide: geometry.endpointB.side,
        fromPort: geometry.endpointA.portOffset, toPort: geometry.endpointB.portOffset,
        routable: false,
      });
      continue;
    }
    if (link.role === "keep") {
      planned.push({
        id: link.id, from: link.from, to: link.to,
        fromSide: geometry.endpointA.side, toSide: geometry.endpointB.side,
        fromPort: geometry.endpointA.portOffset, toPort: geometry.endpointB.portOffset,
        points: drawnPoints(geometry),
        routable: false,
      });
      continue;
    }
    routed.set(link.id, link);
    planned.push({
      id: link.id, from: link.from, to: link.to,
      fromSide: link.sides[0], toSide: link.sides[1],
      fromPort: geometry.endpointA.portOffset, toPort: geometry.endpointB.portOffset,
      fromPortFixed: geometry.endpointA.portMode === "Manual",
      toPortFixed: geometry.endpointB.portMode === "Manual",
      routable: true,
    });
  }

  for (const plan of planLinkRoutes(rooms, planned)) {
    const link = routed.get(plan.id);
    if (!link) continue;
    const { geometry } = link;
    const style = plan.callout !== undefined && styledByMapper(geometry, mapId)
      ? { color: linkCalloutColor(mapId, plan.callout), thickness: LINK_CALLOUT_THICKNESS }
      : withoutCallout(geometry, mapId);
    decisions.push({
      id: link.id,
      routed: plan.points.length > 0,
      callout: plan.callout !== undefined,
      geometry: {
        ...geometry,
        endpointA: { ...geometry.endpointA, side: link.sides[0], portOffset: plan.fromPort },
        endpointB: { ...geometry.endpointB, side: link.sides[1], portOffset: plan.toPort },
        routing: "Automatic",
        segmentShape: "Direct",
        corner: "Rounded",
        routePoints: plan.points,
        ...style,
      },
    });
  }
  return decisions;
}

/** Whether the link's style is the default or a callout's, which the mapper may change. */
function styledByMapper(geometry: LinkGeometry, mapId: string): boolean {
  const color = geometry.color.toUpperCase();
  return (color === DEFAULT_LINK_COLOR && geometry.thickness === DEFAULT_LINK_THICKNESS) ||
    (geometry.thickness === LINK_CALLOUT_THICKNESS && isLinkCalloutColor(mapId, color));
}

/** A link's style with any callout the mapper gave it removed; an author's own style stays. */
export function withoutCallout(
  style: Readonly<{ color: string; thickness: number }>,
  mapId: string,
): { color: string; thickness: number } {
  return style.thickness === LINK_CALLOUT_THICKNESS && isLinkCalloutColor(mapId, style.color)
    ? { color: DEFAULT_LINK_COLOR, thickness: DEFAULT_LINK_THICKNESS }
    : { color: style.color, thickness: style.thickness };
}
