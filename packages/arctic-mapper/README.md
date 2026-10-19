# ArcticMUD Auto-Mapper for smudgy

Smudgy support for mapping rooms in ArcticMUD

## Modes

| Command | Mode |
|---|---|
| `map off` | Mapper does nothing |
| `map follow` | Tracks your position on the existing map; never modifies it |
| `map active` | Like follow, but `n/e/s/w/u/d` consult the map: closed doors are opened first, and exits with a movement command send that instead |
| `map record` | Like follow, but unknown rooms are created and linked as you move |

Movement is captured from the `n/s/e/w/u/d` command aliases (abbreviations
supported) and from `You follow <name> <direction>.` messages, then matched
against the next room the MUD sends. Failed moves ("Alas, you cannot go that
way...") pop the pending move so the queue stays in sync. Directions also accept
`alone` or any of its abbreviations (`a`, `al`, `alo`, `alon`), such as `north alone`
or `n a`. These commands retain their original text, including in Active mode
after automatic door opening.

Room capture accepts a title on its own line or immediately after a prompt.
It recognizes prompt boundaries directly, so a missing or delayed prompt event
does not leave the previous room's capture open. Repeated prompt fragments do
not capture the same room twice.

## Map & Notes panes

The mapper's UI lives in two panes split off the right of the session when the
package loads: **Map** (the live map, filling the pane) stacked above **Notes**
(area/room headings, notes, flags, and the notes editor). Resize either with
the dividers or drag them elsewhere in the grid; both persist across script
reloads.

The area and room headings both show a **Private** or Secret badge when the
current room lives there. Secret and Private badges use the map editor's colors,
including its default palette. In `map record`, the panel shows **Recording**
and the current room's number; the indicator changes as soon as the mode changes.

The recording controls include **Automatically adjust map layout**, unchecked
by default. The choice lasts for this script run and survives mode changes.
When unchecked, new rooms use the first free cell along the movement direction
and existing rooms stay fixed. When checked, automatic layout planning runs only
if the new room would worsen the map's weighted defect score; ordinary growth
in footprint or link length does not trigger it. `map reflow` and an explicit
**Shift map and connect** choice remain available either way.

While recording, **Record into** selects **Map**, **Private**, or a writable
**Secret**. Secrets appear alphabetically, with the map editor's badge colors;
read-only Secrets cannot be selected. The choice is remembered separately for
each map during this script run, including when you follow an existing link back
into a Map room. Changing it affects new rooms and the new links recorded on
Map rooms; a new link from a Private or Secret room stays with that room's place.
It does not move existing rooms. Existing unlinked exits are still extended in
their own place, preserving their metadata. If the selected Secret becomes unavailable,
recording reports the problem instead of switching to Map. If the current room
belongs to a different place, **Move current room to …** moves it to the selected
place. The move carries its own data and links, and follows any new room number.
If the server requires an access review, the panel shows it before **Confirm move**;
Cancel leaves the room where it is. Moving requires the host's `Room.prepareMoveTo`
API and permission to remove from the current place and add to the destination.

Choose **New Secret…**, enter a name, and press **Create and select**. This creates
a Secret on the current cloud map and selects it for recording. The color is
omitted so the map editor's automatic palette applies. Creation requires access
to create a Secret on that map. Local/session maps offer Map only. Selecting
Private uses the host's `AreaView.area` accessor, so it requires a Smudgy build
containing that API addition and support for empty Private areas. Private can be
selected before it has any rooms or notes; selection creates no content. With
no current room, `map refresh` creates the
starting room in the chosen place.

Each area and room can keep a separate `notes` field in **Map**, **Private**,
and each readable **Secret**. Click a heading or a note's place badge to open
the editor. Headings default to the selected recording place, including after
leaving recording mode; an existing note's badge opens that note's own place.
When an area or room has only a Map note, its Map badge is hidden.
The **Place** dropdown selects the field to view, create, edit, or
delete. Switching places preserves separate drafts; Save and Delete affect only
the selected place. Writes require that place's permissions. A note editor stays
on the room it was opened for if you walk elsewhere.

Notes and place choices appear in this order: **Private**, **Secrets alphabetically**,
then **Map**. The note link hotkeys, the prompt's shortcut hint, and `map send_link [n]`
use links in that same order, preserving Markdown link order within each note.
Places with no links are skipped. For example, with two Private links, the third
link (`map send_link 3`) is the first link in the first Secret that has links, or
Map if none do.

**Enable room note link hotkeys** registers these shortcuts for the first link
in the current room's notes:

- `Ctrl+Enter`: send the command in the current session.
- `Ctrl+Alt+Enter`: send the command in all sessions on the same server, including this one.
- `Ctrl+Shift+Enter`: send the command in all other sessions on the same server.

Each shortcut uses the link from the initiating session's room. The command runs
through each receiving session's aliases.
**Show first room note link in the prompt** inserts that link's text before the
prompt's `>`. These options are independent and default to enabled. Changes take
effect on package reload. `map send_link [n]` remains available with either option
disabled.

The package requests `secrets: write` (which includes read) and `manage` for Secret creation.
Local and session maps offer only their Map notes.

## Settings

Configured in the package's options (prompted at install; editable any time and
applied on reload):

| Option | Choices | Effect |
|---|---|---|
| **Mapper mode on load** | Active / Follow / Off | Which mode the mapper starts in. Active and Follow match `map active` / `map follow`; you can still switch live with the `map` commands above. (`map record` stays a live-only mode.) |
| **Enable room note link hotkeys** (`noteLinkHotkeys`) | On / Off | Run the first room note link locally (Ctrl+Enter), in all same-server sessions (Ctrl+Alt+Enter), or in all other same-server sessions (Ctrl+Shift+Enter). Defaults to On. |
| **Show first room note link in the prompt** (`noteLinkPromptHint`) | On / Off | Insert the first room note link's text in the prompt. Defaults to On. |
| **Map panel text size** | Extra small / Small / Medium / Large / Extra large | Base text size for the map panel's headings, room/area notes (Markdown), button labels, and the notes editor. Flags render a quarter smaller. Medium (16 px) is the prior built-in default. |
| **Map panel widget size (px)** | Any number | The initial size of the map/notes panes: the panes' width and the Map pane's height, in pixels (the map starts out square, then simply fills its pane as you move the dividers). Defaults to 350 (the prior built-in size); a non-positive value falls back to the default. |
| **Vertical movement display** | Auto / Normal / Isometric | Creation preference for new `up`/`down` links. **Auto** infers the nearest mapped section. **Normal** uses separate map levels. **Isometric** keeps the rooms on one level and chooses NE/NW or SE/SW from the surrounding geometry. Existing links retain the style encoded by their endpoint levels. |

## Command reference

```
map help                         Show help
map area                         List areas
map area create <name>           Create a durable area (cloud when signed in, otherwise local)
map select <area> [room]         Select the current area and room
map rooms                        List rooms in the selected area
map move <direction>             Move the selection along an existing exit
map path <from> <to>             Path between two rooms (tags: <number> or <area>#<number>)
map push <direction>             Shift the selected room and everything connected, one step
map reflow                       Thoroughly search and reflow the current area
map z [auto|levels|projected]    Show or change the live U/D creation preference
map refresh                      Re-look and re-capture the current room
map debug [on|off]               Toggle diagnostic logging of capture/tracking decisions
map send_link [n]                Run the nth note link (Private, Secrets alphabetically, Map)

map room move <direction>        Same as map move
map room color <color>           Set the room color
map room link <dir> <tag> [oneway]   Link the selected room to another
map room unlink <direction>      Delete exits in a direction
map room shift <direction>       Move the selected room one step on the grid
map room delete                  Delete the selected room
map room show                    Print title/description/coords/exits
map room flag set|clear <flag>   Set or clear a room flag; any name works (e.g. SPIN)
map room automerge               Merge the nearest duplicate room into this one

map exit <dir>                   Show the exit's door, commands and flags
map exit <dir> open <cmd>        Command that opens the exit's door (e.g. "unlock n;open n", "part brush")
map exit <dir> name <name>       Door name used by the default open command
map exit <dir> command <cmd>     Command sent instead of the direction (e.g. "enter hole")
map exit <dir> clear open|command|door|name   Remove an open/movement command, door, or door name
map exit <dir> closed|locked [true|false]   Set the door's state
map exit <dir> hidden [true|false]          Set the hidden flag
```

Before recording a new room, the mapper snapshots the destination place and
proposes a position without moving existing rooms. With **Automatically adjust
map layout** enabled, it compares the weighted defect score before and after
that proposed addition. One wrong directional line weighs as much as eight
crossings and blocked routes, and one that joins rooms on the wrong levels as
much as seventeen. Only a worse score triggers the standard integral-grid
layout pass. The proposed room and its links are included in that comparison;
the room is created once, after choosing a placement. A planned adjustment is
applied only when it improves on the simple placement. Across places, existing
rooms stay fixed even with automatic adjustment enabled. `map reflow`
adds the bounded thorough tournament: it compares the selected room, an
unanchored result, rooms around remaining directional violations, and other
structural anchors before applying one winning patch. The snapshot exists
only for that operation; ordinary movement does not maintain or recompute a
shadow map.

Before creating a look-alike room, recording checks the current area for an
exact title/description match with an unconnected exit back toward the room
you left. If it finds one, the map panel asks whether to rearrange and connect
to that room or keep the rooms separate and create a new one.

Connecting to a room extends an existing unlinked exit in place, retaining its
identity, door name/state/opening command, movement command, hidden flag, weight,
and connection. This applies both to newly recorded rooms and existing rooms
found along another route, including the return exit. Existing parallel links
are retained; multiple eligible unlinked exits require a choice in the map editor.

## Speedwalks

`>` walks you to the nearest room matching what follows, along the cheapest
mapped route (closed doors are opened on the way, movement commands used):

```
>inn              Nearest room flagged INN
>inn.peace        Nearest room flagged BOTH INN and PEACE
>!peace.guild     Nearest GUILD room that is NOT PEACE
>dr               Tags expand by prefix within the current area (e.g. DRUID_GUILD)
>inn@sol          Nearest INN in the area named by "sol"
>inn.!peace@sol   Nearest INN without PEACE in that area
>inn a           Nearest INN, taking directional steps alone
>inn@sol alone   INN in the named area, taking directional steps alone
>@sol             Nearest room of the first area whose NAME starts with "sol"
>@l vi            Word by word: "Lost Village" (not "Lost Valley")
>@sol alo        Walk to the named area alone
>$zurek          Walk to the target named Zurek
>$z a            Walk to the uniquely matching target alone
```

Tag speedwalks (`>inn`) match room flags set with `map room flag set <FLAG>`.
Area speedwalks (`>@sol`) match area names instead — case-insensitive, exact
name beating a longer prefix. Failing both, each word you type can start the
same word of the name, so `>@l vi` reaches "Lost Village" without typing
`>@lost vi`. Combine a tag filter and an area with `>tags@area`;
tag abbreviations then expand within the named area. Area names may contain spaces.
An optional final `alone` (or `a`, `al`, `alo`, `alon`) applies to directional
movement steps, including directions within mapped exit commands. Door-opening
commands and other custom commands keep their existing arguments.

### Named targets and other sessions

`>$name` walks to a recorded destination. Names are case-insensitive: an exact
name wins, otherwise a unique prefix is accepted. Ambiguous prefixes list the
matches. `>$name a` accepts the same `alone` abbreviations as other speedwalks.

Each connected session running arctic-mapper shares its current mapped room
under its **profile name**, updating whenever its location changes. With profiles
Kapusniak and Zurek on the same server, use `>$z` from Kapusniak and `>$k` from
Zurek. Newly loaded sessions receive existing locations immediately. An unknown
room, disconnection, or closed session removes its automatic target.

Scripts can create or replace targets through the `setTarget` procedure. A
location is `{ areaId: string, roomNumber: number }`: use the room's actual area
ID, including a Private or Secret area's ID. This preserves the place even when
different places contain the same room number.

```ts
import { byName, mapper } from 'smudgy:core';
import { setTarget } from 'smudgy:procedures/@arctic-mapper';

const here = mapper.getCurrentLocation();
if (here?.room !== undefined) {
    const target = {
        name: 'foo',
        location: { areaId: here.area, roomNumber: here.room },
    };
    setTarget.post(target); // Record foo in this session; use >$foo or >$f.

    const other = byName('Zurek');
    if (other) setTarget.to(other).post(target); // Also record foo in Zurek.
}
```

To remove a target from this session:

```ts
setTarget.post({ name: 'foo', location: null });
```

The procedure records a destination without starting a walk. Targets last until
removed or scripts reload; automatic session targets are populated again on
load. Names share one namespace, so a later update with the same name replaces
the previous destination. Walking requires the destination's map/place to be
available in the receiving session and reachable from its current room.

Packages calling this procedure declare `smudgy:@arctic-mapper` in `requires`
and request `interop: write`; `.to(other)` also needs `session: reach-others`.
Arctic-mapper requests `session: reach-others` for automatic session sharing.

### Exit commands and doors

Three ways to traverse an exit, and how to model each:

| You'd normally type | Model it as |
|---|---|
| `n` | Nothing — a plain exit |
| `open door n` then `n` | `map exit n closed true` (default open command is `open door n`) |
| `part brush` then `n` | `map exit n open part brush` |
| `enter hole` (no direction works) | `map exit n command enter hole` |

In `map active` mode, typing `n` (or any abbreviation) checks the mapped
exit: the open command goes out first when the exit's door is closed or has
its own open command, then the direction — or the exit's movement command
in its place. Multi-step commands can be separated with `;`. The move is
still recorded as a step in that direction, so tracking works as usual.
Anything sent through aliases/speedwalks that types directions benefits too;
raw sends bypass it.

Live door state is read from the prompt: in `Exits:(E)S>`, the parenthesized
E exit is currently closed. Active mode uses this to skip the open command
when the prompt shows the door already open, and to open doors the map
doesn't know about; hidden exits never appear in the prompt, so their open
commands are always sent. `map record` and `map refresh` give parenthesized
exits a closed door when creating them, including a new room's return exit.
They also update observed doors on existing exits, preserving names and opening
commands. A closed observation preserves a known locked state; an open exit
does not imply that a door exists. Ambiguous parallel exits are left unchanged.

Each exit keeps its own door: its state (open, closed or locked; locked
implies closed) and the command that opens it. `map exit <dir> open <cmd>`
on an exit without a door gives it a closed door with that command, and
changing the state keeps the door's open command. `closed false` leaves an
open door; `clear door` removes the door with its open command. The movement
command lives on the exit itself, apart from the door. When no opening command
is saved, a named door uses `open <name> <direction>`, otherwise `open door <direction>`.
Both active movement and speedwalks follow this rule.

The `SPIN` flag matters to following: rooms flagged `SPIN` let the movement
tracker consider every exit, not just the direction you moved.  Generally,
if you _land_ in a seemingly-random room, you should flag the room you
came from as `SPIN`, not the room you ended up in.
