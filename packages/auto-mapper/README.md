# auto-mapper

Maps as you explore, from the room data your game already sends. Works with GMCP
(`Room.Info` — Aardwolf, IRE games, and most modern MUDs) and MSDP (`ROOM` or the flat
`ROOM_*` variables).

- **Rooms you've mapped are followed** — the map pane tracks your position, and speedwalks
  work over everything you've explored.
- **Rooms you haven't are drawn for you**, in *session maps*: one per game zone, kept only
  for this session, never written into your saved maps.
- **`savemap`** keeps what you've mapped (or `savemap <zone>` for one zone): the session
  map becomes a normal local map and mapping continues into it.
- **Saved zones stay saved.** On later sessions, a zone whose map you kept is picked up
  by name and mapping continues into it — no duplicate session copy. Rename a map if you
  want the auto-mapper to leave it alone.
- **Revisits keep the map honest.** Walking through a mapped room refreshes its title and
  terrain and picks up newly advertised exits. Exits are never removed unless you turn on
  `mapprune` (then compass exits the game stops reporting are pruned from revisited rooms).
- **Every room the game names is on the map.** Unexplored neighbors appear immediately as
  dimmed, unvisited rooms one step from where they were mentioned; walking into one fills
  it in — name, terrain, exits, server coordinates, even the right zone map if the guess
  was wrong. Exits whose destination the game doesn't identify appear as stubs instead.
  Rooms are placed by server coordinates when the game provides them, by your movement
  when it doesn't: the mapper watches the direction commands you send (and speedwalks
  send), so games that don't reveal exit destinations still map correctly. Non-compass
  exits ("enter grate", portals) are kept as special exits traversed by their command.
- Mazes and other rooms where the game withholds identity are left alone — the mapper
  never guesses. Overland/continent grids are followed but never drawn.

Development notes (not user docs): this is the first-party reference consumer of the
ephemeral map tier, `externalId` room identity, and the dual-protocol room-data producers
(`docs/gmcp-mapping.md` §5.3). It runs sandboxed under
`interop:read + mapper:write + automations:aliases + session:echo + gmcp:send`
(movement observation subscribes to `smudgy:events/sys` `send`, which rides
`interop:read`); the e2e coverage lives in `core/tests/auto_mapper_package.rs`.
