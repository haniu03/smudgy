# NukeFire Mapper

`smudgy://kapusniak/nukefire-mapper` builds and follows a Smudgy map from
NukeFire's rich `NukeFire.Map.Local` GMCP snapshot.

Unlike a generic `Room.Info` mapper, it learns the whole visible BIGMAP
neighborhood at once:

- global room vnums and names;
- NukeFire zone numbers (which are not the same as `Room.Info.zone`);
- terrain and terrain-derived room colors;
- player-relative BIGMAP x/y/z grid positions;
- destination vnums for visible links;
- bidirectional versus one-way topology;
- live closed and locked door state.

`Room.Info` is used only to give the current NukeFire zone its human-readable
area name. Its all-zero coordinates, internal zone index, and ambiguous
`"closed"` exit values are deliberately not used for map topology.

## Behavior

Each snapshot is copied and processed in a serial mutation queue. Distinct
movement centers are retained so a quickly crossed neighborhood is not lost;
repeated updates for the same queued center are collapsed to the newest one.

Each adopted area is hydrated once into a VM-local mirror of its rooms,
positions, properties, exits, and connection geometry. Awaited mutations update
that mirror immediately, so normal movement does not repeatedly cross Smudgy's
atomic read boundary. In explicit durable mode this also decouples mapping from
Atlas cache visibility: an acknowledged room number can be used immediately
without polling until a refreshed cloud-area snapshot becomes readable.

NukeFire's grid is a local chart, not a globally Euclidean coordinate system.
The mapper embeds each chart on integral Smudgy cells and treats vnums and
links as authoritative when different viewpoints cannot all fit one geometry.
New connected components are placed in descending order of how strongly they
touch established topology. When a component has one or more established
neighbors, only those seam rooms are used as its initial chart anchors; an
unrelated player-centered origin cannot claim the useful seam cells first.
The planner first tries to solve every accumulated cardinal exit as an exact
difference constraint across the entire area. When those constraints are
consistent and do not assign two rooms to one cell, this produces a **golden
representation**. Existing rooms and whole coherent blocks may be reflowed to
reach it. This handles a late closet or angled cardinal link without banishing
the new room to an island.

All collision-free candidates, including a golden representation when one
exists, are compared lexicographically in this order:

1. minimize directed cardinal exits that leave their proper ray;
2. minimize connection segments that cross unrelated room cells;
3. minimize connections that cross other connections;
4. minimize excess length on correctly oriented cardinal exits;
5. minimize occupied bounding-box area, then perimeter, across map levels;
6. minimize the number of existing rooms moved.

Each priority completely dominates every priority below it: any number of long
but correctly oriented exits is preferable to one angled or backwards cardinal
exit. When a desired patch overlaps known rooms, the planner first tries
recursive, one-cell axis pushes adapted from Arctic's map push. A closure carries
perpendicular correct-ray cardinal bands, destination-cell occupants, rooms in
the swept band, and endpoints of crossed links. Reaching a locked room
invalidates that push direction. Whole-side half-plane expansion remains a competing fallback,
since it can be cleaner than a large recursive closure in dense geometry.
Coherent-block and regional translation candidates remain available for late
cardinal-link repair. After reflow, a vacuum pass closes globally empty rows and
columns whenever doing so improves the same lexicographic quality without
moving a locked room.
When a long link passes through rooms, the same repair also gathers cardinal
branches trailing behind those rooms and pushes them completely across the
protected line. This prevents a cleared room cell from being replaced by a
stretched branch link crossing the same connection.
Before the global vacuum, a bridge-lobe pass finds physical connections whose
removal divides the room graph. Either movable side may slide rigidly toward the
other endpoint until the bridge is adjacent or the lobe reaches its first room
collision. The best lexicographic improvement is accepted repeatedly. This
compacts local pockets even when other geometry occupies every intervening row
or column, while preserving all geometry inside the moved lobe.
Existing rooms with `nukefire.layout.locked=true` reserve their cell but are
never moved automatically. Setting `updateCoordinates: false` makes every
existing room immovable while continuing to place newly discovered rooms.

The expensive existing-room reflow is event-driven: it runs only when a
snapshot introduces a room or a traversal that is not already in the map.
Ordinary movement, GPS overlays, door-state changes, `Room.Info` refreshes, and
repeated snapshots retain existing coordinates. Area-wide connection routing is
likewise revisited only for topology growth or an actual coordinate update.
Unchanged room metadata and exits are compared in the VM mirror and generate no
Smudgy mutation calls. This keeps walking latency independent of the accumulated
map's reflow cost.

## Decision log

The default mapper appends structured diagnostics to
`$DATA/mapping-decisions.jsonl`, where `$DATA` is this package's private,
durable Smudgy data directory. The mapper echoes the resolved absolute path
once when it starts. The file uses JSON Lines: every line is an independent
timestamped record, so it remains readable while the client is running and can
be tailed or copied immediately after an undesirable decision. Records are
written in small asynchronous batches so filesystem latency does not block map
reconciliation.

The log contains:

- `layout-decision`: the raw `NukeFire.Map.Local` snapshot, room/vnum identity
  table, durable resident coordinates, directed edges, topology-growth trigger,
  the best stable/golden/push/reflow candidates, every accepted greedy repair
  and bridge/global vacuum operation, and the final lexicographic quality and
  coordinates;
- `routing-decisions`: connections whose geometry changed, their endpoint
  positions and directions, intervening room cells, and the selected direct or
  orthogonal geometry;
- `layout-error` and `mapping-error`: the reproducible input and error details;
- `session-start`: the mapper options which produced subsequent records.

Smudgy's bigint-backed mapper and connection ids are represented as decimal
strings because JSON has no native bigint value.

Ordinary movement which adds no room or traversal does not run the planner and
therefore does not add a layout-decision record. To use another relative file
inside package data, or to disable logging for a library-created instance:

```ts
const mapper = new NukeFireMapper({
  decisionLogFile: "diagnostics/my-map.jsonl",
  // decisionLogFile: false,
});
```

When a map looks wrong, preserve the latest `layout-decision` and any following
`routing-decisions` line. Together they contain enough input and candidate
history to replay and explain the choice without waiting for the problem to
occur again.

When non-Euclidean topology still requires a long connection, the mapper checks
its direct segment against every room on that level. An obstructed connection is
routed orthogonally through empty integral cells, with its endpoint walls moved
when necessary; unobstructed and adjacent links retain automatic direct routing.
Connection geometry is reconciled area-wide after each reflow, so previously
created links are repaired as well as newly discovered ones.

Rooms are keyed by their server-global vnum through Smudgy `externalId`, so the
package can enrich an existing NukeFire map instead of duplicating it. Areas are
tagged with `nukefire.zone` and rooms retain their `terrain` and
`nukefire.zone` properties.

Links are merged, never pruned. This matters because `Map.Local.truncated`
means the server may have clipped part of the neighborhood: absence from one
snapshot is not evidence that a room or exit disappeared. Newly discovered
same-area links are created atomically, including a reciprocal traversal when
the payload marks them bidirectional. Later snapshots update door state and
destinations.

Maps created by the default exported instance are session-only: they are never
saved or cloud-synced and disappear when the Smudgy session closes. Existing
durable NukeFire rooms are deliberately ignored while this mode is active, so
the temporary atlas can be rebuilt repeatedly without modifying the cloud map.
Library consumers can instead construct a durable mapper explicitly:

```ts
import {
  NukeFireMapper,
  nukefireMapper,
} from "smudgy://kapusniak/nukefire-mapper";

nukefireMapper.stop();
const durableMapper = new NukeFireMapper({
  storage: "local",
  updateCoordinates: true,
});
durableMapper.start(); // creates and reuses durable areas
```

The package entry already starts one default instance, so construct your own
only when importing a submodule or when the default instance has been stopped.

## Installation note

Disable the generic `smudgy://official/auto-mapper` when enabling this package.
Running two automatic mappers against the same GMCP stream can create competing
room and exit mutations. Existing durable NukeFire rooms are safe to keep: the
default session mapper ignores them, while an explicit durable mapper reuses
and enriches matching vnums.
