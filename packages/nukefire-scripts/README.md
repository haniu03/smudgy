# nukefire-scripts

The NukeFire **command deck**: panels and widgets built on
`smudgy://kapusniak/nukefire-gmcp`, in the spirit of the official NukeFire
desktop HUD but running inside smudgy.

## Panels

| Panel | Where | What it does |
| --- | --- | --- |
| **HUD** | main pane, or above shared session tabs | HP/Mana/Move/Devotion bars bound straight to `Char.Vitals`; name/gold/TNL/position from `Char.Status`; an opponent bar appears while `Char.Vitals.opponent` exists. With the all-tabs layout, each player gets a display-only numbered focus badge, ordinary name/class/level text, and three glossy gradient HP/MN/MV bars whose values tween rather than snap. Compact stacks identity above responsive bars; Wide places fixed-size bars beside identity. |
| **Affects** | left | `NukeFire.Affects` with local countdowns (`remaining` vs. payload receipt time, 5s ticker), `+N APPLY` modifier lines, `grants` chips, hidden-permanent note. The Target section shows `Char.TargetAffects` — hit **scan** while fighting. |
| **Comms** | under Affects | `Comm.Channel` feed with a compact channel dropdown, timestamps, and optional full ANSI rendering. Grats and SSF are selectable; non-GMCP `(Skynet)` lines are mirrored into All and Skynet with their terminal styles preserved. The pane's own input speaks on the selected channel. |
| **Map** | right | The smudgy `MapView`, a room header bound to `Room.Info`, and a live GPS strip bound to `Char.GPS`. Mounts once — the map keeps its zoom across room changes. |
| **Radar** | under Map | `NukeFire.Map.Local` drawn on a Canvas: terrain-colored cells, exit links (gold = active GPS route, red-dashed = closed door, wedges = up/down), pulsing you-are-here ring, breathing destination diamond. Exit chips below walk you (closed doors offer `open <dir>`). |
| **Atlas** | a tab behind Map | The full GPS catalog via `fetchGpsCatalog()`. Filter with the pane input (name/zone/category/alias/tag, Enter applies); an exact zone-number match sorts first. Clicking a destination sets the route and immediately sends `path gps walk`. A failed catalog load retries when the next `Room.Info` arrives. |
| **Deck** | bottom | `NukeFire.Context` service cards: status lines colored by tone, action buttons. The nested BIGMAP action in Zone Intelligence is omitted because Radar already provides it. `confirm` actions raise a Modal; actions with `arguments` are proposed into the command input for you to complete. |
| **Codex** | under Comms (off by default) | Knowledge-console browser. Search from the pane input or `codex <query>`; entries render as Markdown with fields, tags, and a full-text terminal command button. |

## Configuration

Package settings independently control whether HUD, Affects, Comms, Map,
Radar, Atlas, Deck, and Codex open. The former NF checkbox strip and `nfui`
alias are intentionally gone; change these options in the package settings and
reload the package instead.

`Chat rendering` offers **Plain** (the prior channel-tinted and compact auction
presentation) and **Full ANSI** (the unmodified message text rendered with the
server's foreground/background colors and text attributes).
Chat terminal size and the baseline widget text size are separate numeric
settings.

Additional sessions either retain the default evenly stacked column on the
right or join one shared set of main-terminal tabs with a session-vitals pane
above them. F1–F4 select the target
session's tab before focusing its input; Ctrl+F1–F4 keeps the magnify behavior
in the stacked layout and selects the corresponding tab in the tabbed layout.
The tabbed-session vitals style can be **Compact** for narrow panes (down to
roughly 350px) or **Wide** for a horizontal, fixed-bar presentation.

## Known guesses to verify in game

- **GPS command syntax** — the catalog only documents the destination index
  as "the GPS target argument". `theme.ts` currently sends `gps set <index>` and
  `gps clear`; check `help gps` and adjust `gpsSet`/`GPS_CLEAR` if needed.
- The `codex` alias and auction item links can still open Codex even when its
  load-time visibility option is disabled.

## Shared state

Other packages can consume via `smudgy:state/kapusniak/nukefire-scripts`:
`sessionVitals` (direct it with `.from(session)`), `panesOpen`, `hudMeta`, and
`radarScene` (the current radar Canvas scene).
