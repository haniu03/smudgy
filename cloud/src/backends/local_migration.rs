//! The v1 → v2 area-document migration (§8.3/§8.4 of the Connection plan):
//! an explicit legacy DTO for the pre-Connection `AreaWithDetails` shape and
//! [`migrate_v1`], the Rust mirror of the cloud backfill
//! (`smudgy-web/smudgy-api/migrations/20260721000000_connections.sql`).
//!
//! The v2 types deliberately do **not** tolerate v1 input — a v1 exit has
//! `style`/`color` and no `connection_id`, so it cannot deserialize as a
//! [`crate::Exit`]. Every v1 document (local authoritative file or JSON
//! import) passes through [`LegacyAreaV1`] and this migration instead, and
//! the migration mirrors the cloud backfill rule-for-rule so a map migrated
//! locally and the same map migrated server-side agree:
//!
//! - **Pairing** is conservative and deterministic: two exits pair only when
//!   they are distinct, traverse the same two distinct same-area rooms in
//!   opposite directions, every *present* `to_direction` matches the
//!   partner's `from_direction`, and each is the other's **only** such
//!   candidate. Self-loops, cross-area exits, ambiguity, and contradictions
//!   never pair; every unpaired exit gets a one-member Connection. No exit
//!   is ever deleted or rewritten beyond gaining its `connection_id`.
//! - **Appearance** maps per field (style → routing/dash, color kept when
//!   plausible), preferring the non-default value; when both members are
//!   non-default and disagree, the exit with the lower origin room number,
//!   then the lower exit UUID, wins the field.
//! - **Anchors** follow §1.5: every endpoint is pinned at its exit
//!   direction's semantic home slot (cardinals at their wall midpoint,
//!   diagonals at their corner inset, up/down/in/out at their fixed home
//!   corners; only `Special`/`Other` consult the partner bearing). Ports are
//!   never redistributed to make room for wall-mates — endpoints sharing a
//!   slot simply coincide until an author moves one by hand, so an exit's
//!   port never depends on what else the room has.

use std::collections::{BTreeSet, HashMap};

use serde::Deserialize;

use crate::{
    Area, AreaWithDetails, Connection, ConnectionDash, ConnectionEndpoint, ConnectionId,
    ConnectionKind, ConnectionRouting, CornerStyle, DEFAULT_CONNECTION_COLOR,
    DEFAULT_CONNECTION_THICKNESS, Exit, ExitDirection, ExitId, Label, LinkedAreaInfo, MapPoint,
    PortMode, Property, RoomNumber, RoomSide, RoomWithDetails, SegmentShape, Shape,
    connection::{MAX_COLOR_LEN, default_anchor_for_direction},
};

/// The pre-Connection (v1) `AreaWithDetails` document shape: no
/// `format_version`, no `connections`, and exits that carry their own
/// `style`/`color` instead of a `connection_id`.
#[derive(Debug, Clone, Deserialize)]
pub struct LegacyAreaV1 {
    #[serde(flatten)]
    pub area: Area,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub properties: Vec<Property>,
    #[serde(default)]
    pub rooms: Vec<LegacyRoomV1>,
    #[serde(default)]
    pub labels: Vec<Label>,
    #[serde(default)]
    pub shapes: Vec<Shape>,
    #[serde(default)]
    pub linked_areas: Vec<LinkedAreaInfo>,
}

/// A v1 room: identical to [`RoomWithDetails`] except its exits are v1.
#[derive(Debug, Clone, Deserialize)]
pub struct LegacyRoomV1 {
    pub room_number: RoomNumber,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub level: i32,
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub properties: Vec<Property>,
    #[serde(default)]
    pub exits: Vec<LegacyExitV1>,
    #[serde(default)]
    pub tags: BTreeSet<String>,
    #[serde(default)]
    pub is_secret: bool,
    #[serde(default)]
    pub external_id: Option<String>,
}

/// A v1 exit: per-exit `style` (any of `Normal`/`Dashed`/`Dotted`/
/// `Meandering`/`Stub`; anything else is treated as the `Normal` default —
/// the v1 writer could only produce those five) and `color`, and no
/// `connection_id`.
#[allow(clippy::struct_excessive_bools)] // the v1 wire shape, verbatim
#[derive(Debug, Clone, Deserialize)]
pub struct LegacyExitV1 {
    pub id: ExitId,
    pub from_direction: ExitDirection,
    #[serde(default)]
    pub to_area_id: Option<crate::AreaId>,
    #[serde(default)]
    pub to_room_number: Option<RoomNumber>,
    #[serde(default)]
    pub to_direction: Option<ExitDirection>,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub is_hidden: bool,
    #[serde(default)]
    pub is_closed: bool,
    #[serde(default)]
    pub is_locked: bool,
    #[serde(default = "default_weight")]
    pub weight: f32,
    #[serde(default)]
    pub command: String,
    #[serde(default = "default_style")]
    pub style: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub to_unknown: bool,
    #[serde(default)]
    pub to_area_token: Option<String>,
    #[serde(default)]
    pub is_secret: bool,
}

fn default_weight() -> f32 {
    1.0
}

fn default_style() -> String {
    "Normal".to_string()
}

/// §8.1 appearance: `Stub` becomes `Stub` routing; everything else routes
/// `Simple` (`Meandering` had no stored route and drew solid).
fn legacy_routing(style: &str) -> ConnectionRouting {
    if style == "Stub" {
        ConnectionRouting::Stub
    } else {
        ConnectionRouting::Simple
    }
}

/// §8.1 appearance: `Dashed`/`Dotted` keep their dash; everything else is
/// `Solid`.
fn legacy_dash(style: &str) -> ConnectionDash {
    match style {
        "Dashed" => ConnectionDash::Dashed,
        "Dotted" => ConnectionDash::Dotted,
        _ => ConnectionDash::Solid,
    }
}

/// §8.1 color survival — the mirror of the cloud backfill's shape check
/// (`backfill_color`): a trimmed, non-empty, ≤64-byte value shaped like a
/// hex, named, or functional color survives verbatim; anything else
/// normalizes to [`DEFAULT_CONNECTION_COLOR`]. Deliberately permissive (the
/// v2 write path canonicalizes anything new; rendering falls back safely on
/// parse failure).
fn legacy_color(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_COLOR_LEN {
        return DEFAULT_CONNECTION_COLOR.to_string();
    }
    let hex = trimmed
        .strip_prefix('#')
        .is_some_and(|h| (3..=8).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit()));
    let named = trimmed.bytes().all(|b| b.is_ascii_alphabetic());
    let functional = ["rgb(", "rgba(", "hsl(", "hsla("]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix));
    if hex || named || functional {
        trimmed.to_string()
    } else {
        DEFAULT_CONNECTION_COLOR.to_string()
    }
}

/// A flattened v1 exit with its origin room, the unit the pairing and port
/// passes work over.
struct FlatExit {
    room: RoomNumber,
    exit: LegacyExitV1,
}

/// One room's placement facts, for anchors, bearings, and kinds.
#[derive(Clone, Copy)]
struct SiteInfo {
    x: f32,
    y: f32,
    level: i32,
}

fn side_ordinal(side: RoomSide) -> usize {
    RoomSide::ALL
        .iter()
        .position(|candidate| *candidate == side)
        .unwrap_or(0)
}

fn endpoint(room_number: RoomNumber, side: RoomSide, port_offset: f32) -> ConnectionEndpoint {
    ConnectionEndpoint {
        room_number,
        side,
        port_offset,
        port_mode: PortMode::AutoPinned,
    }
}

/// §1.5 anchor via [`default_anchor_for_direction`], with the backfill's
/// bearing plumbing: named directions have fixed home slots and ignore the
/// bearing; only `Special`/`Other` anchor on the wall nearest it (East `0.5`
/// on a zero bearing).
fn anchor_for(direction: ExitDirection, bearing: MapPoint) -> (RoomSide, f32) {
    default_anchor_for_direction(direction, Some(bearing))
}

/// Migrates one v1 area document to the v2 Connection contract. The §8.1
/// algorithm mirrored in Rust — see the module docs for the rules. Pure and
/// infallible: every well-formed v1 document has a v2 form, every exit
/// keeps its identity, and none is lost. Reciprocal-looking links that
/// stayed one-way (ambiguous or contradictory returns) are reported through
/// `log::warn`.
#[must_use]
#[allow(clippy::too_many_lines)] // one linear mirror of the cloud backfill passes
#[allow(clippy::missing_panics_doc)] // internal expects on invariants this function establishes
pub fn migrate_v1(legacy: LegacyAreaV1) -> AreaWithDetails {
    let area_id = legacy.area.id;

    // Room placement facts. Same-area destinations referenced by exits but
    // absent from the document are materialized as blank placeholders below
    // (the cloud schema's FK guarantees them; a local v1 file cannot), so
    // every v2 endpoint reference resolves.
    let mut sites: HashMap<RoomNumber, SiteInfo> = legacy
        .rooms
        .iter()
        .map(|room| {
            (
                room.room_number,
                SiteInfo {
                    x: room.x,
                    y: room.y,
                    level: room.level,
                },
            )
        })
        .collect();

    let mut rooms: Vec<LegacyRoomV1> = legacy.rooms;
    let exits: Vec<FlatExit> = rooms
        .iter()
        .flat_map(|room| {
            room.exits.iter().map(|exit| FlatExit {
                room: room.room_number,
                exit: exit.clone(),
            })
        })
        .collect();

    for flat in &exits {
        if flat.exit.to_area_id == Some(area_id)
            && let Some(to_room) = flat.exit.to_room_number
            && !sites.contains_key(&to_room)
        {
            sites.insert(
                to_room,
                SiteInfo {
                    x: 0.0,
                    y: 0.0,
                    level: 0,
                },
            );
            rooms.push(LegacyRoomV1 {
                room_number: to_room,
                title: String::new(),
                description: String::new(),
                level: 0,
                x: 0.0,
                y: 0.0,
                color: String::new(),
                properties: Vec::new(),
                exits: Vec::new(),
                tags: BTreeSet::new(),
                is_secret: false,
                external_id: None,
            });
        }
    }

    let site = |room: RoomNumber| sites.get(&room).copied();
    let same_area = |exit: &LegacyExitV1| exit.to_area_id == Some(area_id);

    // --- Pairing (backfill 4a): the candidate relation, then mutual
    // uniqueness. The relation is symmetric, so "each is the other's only
    // candidate" is exactly "both candidate sets have size one".
    let is_candidate = |e: &FlatExit, f: &FlatExit| -> bool {
        e.exit.id != f.exit.id
            && same_area(&e.exit)
            && same_area(&f.exit)
            && e.exit.to_room_number == Some(f.room)
            && f.exit.to_room_number == Some(e.room)
            && e.exit.to_room_number != Some(e.room)
            && e.exit
                .to_direction
                .is_none_or(|d| d == f.exit.from_direction)
            && f.exit
                .to_direction
                .is_none_or(|d| d == e.exit.from_direction)
    };
    let candidates: Vec<Vec<usize>> = exits
        .iter()
        .map(|e| {
            exits
                .iter()
                .enumerate()
                .filter(|(_, f)| is_candidate(e, f))
                .map(|(j, _)| j)
                .collect()
        })
        .collect();

    let mut paired_with: HashMap<usize, usize> = HashMap::new();
    for (i, cands) in candidates.iter().enumerate() {
        if let [j] = cands.as_slice()
            && candidates[*j].len() == 1
        {
            // Keep each pair once, primary first: lower origin room number,
            // then lower exit UUID (the same order that breaks appearance
            // ties).
            let (e, f) = (&exits[i], &exits[*j]);
            if (e.room, e.exit.id.0) < (f.room, f.exit.id.0) {
                paired_with.insert(i, *j);
            }
        }
    }

    // Reciprocal-looking links that stayed one-way: a loose (rooms-only)
    // reciprocal counterpart existed, but ambiguity or contradiction kept
    // the exit unpaired.
    let mut stayed_one_way: Vec<ExitId> = Vec::new();
    let in_a_pair =
        |i: usize| paired_with.contains_key(&i) || paired_with.values().any(|j| *j == i);
    for (i, e) in exits.iter().enumerate() {
        if in_a_pair(i) || !same_area(&e.exit) || e.exit.to_room_number == Some(e.room) {
            continue;
        }
        let loose_reciprocal = exits.iter().any(|f| {
            f.exit.id != e.exit.id
                && same_area(&f.exit)
                && Some(f.room) == e.exit.to_room_number
                && f.exit.to_room_number == Some(e.room)
        });
        if loose_reciprocal {
            stayed_one_way.push(e.exit.id);
        }
    }
    if !stayed_one_way.is_empty() {
        log::warn!(
            "area {} ({}): {} reciprocal-looking exit(s) stayed one-way in the v1 migration \
             (ambiguous or contradictory returns): {:?}",
            legacy.area.name,
            area_id,
            stayed_one_way.len(),
            stayed_one_way,
        );
    }

    // --- Connections (backfill 4b/4c) + membership.
    let mut connections: Vec<Connection> = Vec::new();
    let mut membership: HashMap<ExitId, ConnectionId> = HashMap::new();

    let blank_connection = |a: ConnectionEndpoint,
                            b: Option<ConnectionEndpoint>,
                            kind: ConnectionKind,
                            routing: ConnectionRouting,
                            dash: ConnectionDash,
                            color: String| Connection {
        id: ConnectionId::new(),
        endpoint_a: a,
        endpoint_b: b,
        kind,
        routing,
        segment_shape: SegmentShape::Direct,
        corner: CornerStyle::Sharp,
        route_points: Vec::new(),
        dash,
        color,
        thickness: DEFAULT_CONNECTION_THICKNESS,
    };

    for (&i, &j) in &paired_with {
        let (e, f) = (&exits[i], &exits[j]);
        // Canonical endpoint A is the lower room number (§1.4 inv. 9).
        let (a, b) = if e.room < f.room { (e, f) } else { (f, e) };
        let a_pos = site(a.room).unwrap_or(SiteInfo {
            x: 0.0,
            y: 0.0,
            level: 0,
        });
        let b_pos = site(b.room).unwrap_or(a_pos);
        let (a_side, a_port) = anchor_for(
            a.exit.from_direction,
            MapPoint::new(b_pos.x - a_pos.x, b_pos.y - a_pos.y),
        );
        let (b_side, b_port) = anchor_for(
            b.exit.from_direction,
            MapPoint::new(a_pos.x - b_pos.x, a_pos.y - b_pos.y),
        );

        // Per-field appearance: prefer the non-default value; when both are
        // non-default and disagree, the primary (lower room, lower UUID)
        // exit `e` wins.
        let routing = if legacy_routing(&e.exit.style) == ConnectionRouting::Simple {
            legacy_routing(&f.exit.style)
        } else {
            legacy_routing(&e.exit.style)
        };
        let dash = if legacy_dash(&e.exit.style) == ConnectionDash::Solid {
            legacy_dash(&f.exit.style)
        } else {
            legacy_dash(&e.exit.style)
        };
        let color = if legacy_color(&e.exit.color) == DEFAULT_CONNECTION_COLOR {
            legacy_color(&f.exit.color)
        } else {
            legacy_color(&e.exit.color)
        };

        let kind = if a_pos.level == b_pos.level {
            ConnectionKind::Internal
        } else {
            ConnectionKind::CrossLevel
        };
        let connection = blank_connection(
            endpoint(a.room, a_side, a_port),
            Some(endpoint(b.room, b_side, b_port)),
            kind,
            routing,
            dash,
            color,
        );
        membership.insert(e.exit.id, connection.id);
        membership.insert(f.exit.id, connection.id);
        connections.push(connection);
    }

    for (i, flat) in exits.iter().enumerate() {
        if in_a_pair(i) {
            continue;
        }
        let e = &flat.exit;
        let origin = site(flat.room).unwrap_or(SiteInfo {
            x: 0.0,
            y: 0.0,
            level: 0,
        });
        let dest_site = same_area(e)
            .then_some(e.to_room_number)
            .flatten()
            .and_then(site);
        let self_loop = same_area(e) && e.to_room_number == Some(flat.room);
        let has_b = same_area(e) && e.to_room_number.is_some();

        let o_bearing = MapPoint::new(
            dest_site.map_or(0.0, |d| d.x - origin.x),
            dest_site.map_or(0.0, |d| d.y - origin.y),
        );
        let (o_side, o_port) = anchor_for(e.from_direction, o_bearing);

        let (kind, a, b) = if !has_b {
            let leaves_area = e.to_unknown || (!same_area(e) && e.to_area_id.is_some());
            let kind = if leaves_area {
                ConnectionKind::External
            } else {
                ConnectionKind::Dangling
            };
            (kind, endpoint(flat.room, o_side, o_port), None)
        } else if self_loop {
            // The loop bulges on one wall: the arrival end follows
            // `to_direction` when present, else shares the origin wall.
            // Canonical order: (side ordinal, default offset, origin role
            // first).
            let (d_side, d_port) = match e.to_direction {
                Some(direction) => anchor_for(direction, MapPoint::new(0.0, 0.0)),
                None => (o_side, o_port),
            };
            let origin_end = endpoint(flat.room, o_side, o_port);
            let dest_end = endpoint(flat.room, d_side, d_port);
            let flipped = (side_ordinal(d_side), d_port) < (side_ordinal(o_side), o_port);
            let (a, b) = if flipped {
                (dest_end, origin_end)
            } else {
                (origin_end, dest_end)
            };
            (ConnectionKind::SelfLoop, a, Some(b))
        } else {
            // One-way same-area: the arrival end anchors from
            // `to_direction`, or the bearing back toward the origin when
            // absent; canonical A is the lower room number.
            let to_room = e.to_room_number.expect("has_b requires a destination room");
            let d_bearing = MapPoint::new(
                origin.x - dest_site.map_or(origin.x, |d| d.x),
                origin.y - dest_site.map_or(origin.y, |d| d.y),
            );
            let (d_side, d_port) = match e.to_direction {
                Some(direction) => anchor_for(direction, d_bearing),
                None => anchor_for(ExitDirection::Other, d_bearing),
            };
            let kind = match dest_site {
                Some(dest) if dest.level != origin.level => ConnectionKind::CrossLevel,
                _ => ConnectionKind::Internal,
            };
            let origin_end = endpoint(flat.room, o_side, o_port);
            let dest_end = endpoint(to_room, d_side, d_port);
            let (a, b) = if to_room < flat.room {
                (dest_end, origin_end)
            } else {
                (origin_end, dest_end)
            };
            (kind, a, Some(b))
        };

        let connection = blank_connection(
            a,
            b,
            kind,
            legacy_routing(&e.style),
            legacy_dash(&e.style),
            legacy_color(&e.color),
        );
        membership.insert(e.id, connection.id);
        connections.push(connection);
    }

    // --- Assemble the v2 document: every exit keeps its identity and gains
    // exactly its Connection membership.
    let rooms: Vec<RoomWithDetails> = rooms
        .into_iter()
        .map(|room| RoomWithDetails {
            room_number: room.room_number,
            title: room.title,
            description: room.description,
            level: room.level,
            x: room.x,
            y: room.y,
            color: room.color,
            properties: room.properties,
            exits: room
                .exits
                .into_iter()
                .map(|exit| Exit {
                    connection_id: membership[&exit.id],
                    id: exit.id,
                    from_direction: exit.from_direction,
                    to_area_id: exit.to_area_id,
                    to_room_number: exit.to_room_number,
                    to_direction: exit.to_direction,
                    path: exit.path,
                    is_hidden: exit.is_hidden,
                    is_closed: exit.is_closed,
                    is_locked: exit.is_locked,
                    weight: exit.weight,
                    command: exit.command,
                    to_unknown: exit.to_unknown,
                    to_area_token: exit.to_area_token,
                    is_secret: exit.is_secret,
                })
                .collect(),
            tags: room.tags,
            is_secret: room.is_secret,
            external_id: room.external_id,
        })
        .collect();

    AreaWithDetails {
        area: legacy.area,
        format_version: crate::AREA_FORMAT_VERSION,
        // A v1 content hash described the v1 projection; the migrated
        // document has none until a server projects it again.
        content_hash: None,
        properties: legacy.properties,
        rooms,
        labels: legacy.labels,
        shapes: legacy.shapes,
        connections,
        linked_areas: legacy.linked_areas,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::too_many_lines)]

    use super::*;
    use crate::connection::CORNER_INSET;
    use chrono::Utc;
    use uuid::Uuid;

    // Fixture identity mirroring the server harness
    // (`smudgy-api/tests/migration_harness.rs`): the hex index appears in
    // both the area UUID tail and its exits' UUID block.
    fn fx_area_id(fx: u32) -> crate::AreaId {
        crate::AreaId(
            Uuid::parse_str(&format!("aaaaaaaa-0000-4000-8000-{fx:012x}")).expect("area uuid"),
        )
    }

    fn fx_exit_id(fx: u32, n: u32) -> ExitId {
        ExitId(
            Uuid::parse_str(&format!("eeeeeeee-{fx:04x}-4000-8000-{n:012x}")).expect("exit uuid"),
        )
    }

    struct FixtureBuilder {
        fx: u32,
        rooms: Vec<LegacyRoomV1>,
    }

    impl FixtureBuilder {
        fn new(fx: u32) -> Self {
            Self {
                fx,
                rooms: Vec::new(),
            }
        }

        fn room(mut self, number: i32, x: f32, y: f32, level: i32, is_secret: bool) -> Self {
            self.rooms.push(LegacyRoomV1 {
                room_number: RoomNumber(number),
                title: format!("room {number}"),
                description: String::new(),
                level,
                x,
                y,
                color: String::new(),
                properties: Vec::new(),
                exits: Vec::new(),
                tags: BTreeSet::new(),
                is_secret,
                external_id: None,
            });
            self
        }

        #[allow(clippy::too_many_arguments)]
        fn exit(
            mut self,
            n: u32,
            from_room: i32,
            from: ExitDirection,
            to: Option<(crate::AreaId, i32)>,
            to_direction: Option<ExitDirection>,
            style: &str,
            color: &str,
            is_secret: bool,
        ) -> Self {
            let exit = LegacyExitV1 {
                id: fx_exit_id(self.fx, n),
                from_direction: from,
                to_area_id: to.map(|(area, _)| area),
                to_room_number: to.map(|(_, room)| RoomNumber(room)),
                to_direction,
                path: String::new(),
                is_hidden: false,
                is_closed: false,
                is_locked: false,
                weight: 1.0,
                command: String::new(),
                style: style.to_string(),
                color: color.to_string(),
                to_unknown: false,
                to_area_token: None,
                is_secret,
            };
            self.rooms
                .iter_mut()
                .find(|room| room.room_number == RoomNumber(from_room))
                .expect("exit's from-room must be declared first")
                .exits
                .push(exit);
            self
        }

        fn build(self) -> LegacyAreaV1 {
            LegacyAreaV1 {
                area: Area {
                    id: fx_area_id(self.fx),
                    user_id: None,
                    atlas_id: None,
                    atlas_name: None,
                    name: format!("fixture {:#x}", self.fx),
                    created_at: Utc::now(),
                    rev: 7,
                    access: None,
                    owner_nickname: None,
                    copied_from_area_id: None,
                    copied_from_rev: None,
                    copied_at: None,
                    family_token: None,
                },
                content_hash: Some("stale-v1-hash".to_string()),
                properties: Vec::new(),
                rooms: self.rooms,
                labels: Vec::new(),
                shapes: Vec::new(),
                linked_areas: Vec::new(),
            }
        }
    }

    /// The §8.1 global guarantees on a migrated document: exit identity
    /// preserved, every exit's `connection_id` resolves, member counts 1–2,
    /// backfill defaults (`AutoPinned`, empty routes, default thickness,
    /// ports in range), `format_version` 2.
    fn assert_backfill_invariants(migrated: &AreaWithDetails, expected_exits: usize) {
        assert_eq!(migrated.format_version, crate::AREA_FORMAT_VERSION);
        assert!(migrated.content_hash.is_none(), "v1 hash must not survive");
        let all_exits: Vec<&Exit> = migrated
            .rooms
            .iter()
            .flat_map(|room| room.exits.iter())
            .collect();
        assert_eq!(all_exits.len(), expected_exits, "no exit is ever lost");
        let mut members: HashMap<ConnectionId, usize> = HashMap::new();
        for exit in &all_exits {
            assert!(
                migrated
                    .connections
                    .iter()
                    .any(|connection| connection.id == exit.connection_id),
                "exit {} must reference a present Connection",
                exit.id
            );
            *members.entry(exit.connection_id).or_default() += 1;
        }
        for connection in &migrated.connections {
            let count = members.get(&connection.id).copied().unwrap_or(0);
            assert!(
                (1..=2).contains(&count),
                "connection {} has {count} members",
                connection.id
            );
            assert!(connection.route_points.is_empty(), "routes start empty");
            assert!((connection.thickness - DEFAULT_CONNECTION_THICKNESS).abs() < f32::EPSILON);
            assert_eq!(connection.endpoint_a.port_mode, PortMode::AutoPinned);
            assert!((0.0..=1.0).contains(&connection.endpoint_a.port_offset));
            if let Some(b) = connection.endpoint_b {
                assert_eq!(b.port_mode, PortMode::AutoPinned);
                assert!((0.0..=1.0).contains(&b.port_offset));
            }
            assert_eq!(connection.segment_shape, SegmentShape::Direct);
            assert_eq!(connection.corner, CornerStyle::Sharp);
        }
    }

    fn conn_of(migrated: &AreaWithDetails, exit_id: ExitId) -> &Connection {
        let exit = migrated
            .rooms
            .iter()
            .flat_map(|room| room.exits.iter())
            .find(|exit| exit.id == exit_id)
            .expect("exit present");
        migrated
            .connections
            .iter()
            .find(|connection| connection.id == exit.connection_id)
            .expect("membership resolves")
    }

    /// Role-agnostic `(room, side)` endpoint set, sorted — assertions that
    /// must not depend on which endpoint became A.
    fn endpoint_set(connection: &Connection) -> Vec<(i32, RoomSide)> {
        let mut endpoints = vec![(
            connection.endpoint_a.room_number.0,
            connection.endpoint_a.side,
        )];
        if let Some(b) = connection.endpoint_b {
            endpoints.push((b.room_number.0, b.side));
        }
        endpoints.sort_by_key(|(room, side)| (*room, side_ordinal(*side)));
        endpoints
    }

    fn assert_port(actual: f32, expected: f32, ctx: &str) {
        assert!(
            (actual - expected).abs() < 1e-5,
            "{ctx}: expected {expected}, got {actual}"
        );
    }

    /// Every wall endpoint of a connection on `(room, side)`, in role order.
    fn wall_ports(
        migrated: &AreaWithDetails,
        room: i32,
        side: RoomSide,
    ) -> Vec<(ConnectionId, f32)> {
        let mut out = Vec::new();
        for connection in &migrated.connections {
            if connection.endpoint_a.room_number.0 == room && connection.endpoint_a.side == side {
                out.push((connection.id, connection.endpoint_a.port_offset));
            }
            if let Some(b) = connection.endpoint_b
                && b.room_number.0 == room
                && b.side == side
            {
                out.push((connection.id, b.port_offset));
            }
        }
        out
    }

    #[test]
    fn fixture_a_clean_reciprocal_pair() {
        let migrated = migrate_v1(
            FixtureBuilder::new(0x01)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 2.0, 0.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::East,
                    Some((fx_area_id(0x01), 2)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    2,
                    2,
                    ExitDirection::West,
                    Some((fx_area_id(0x01), 1)),
                    Some(ExitDirection::East),
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 2);
        assert_eq!(migrated.connections.len(), 1);
        let c = conn_of(&migrated, fx_exit_id(0x01, 1));
        assert_eq!(c.id, conn_of(&migrated, fx_exit_id(0x01, 2)).id);
        assert_eq!(c.endpoint_a.room_number, RoomNumber(1), "lower room is A");
        assert_eq!(c.endpoint_b.expect("B").room_number, RoomNumber(2));
        assert_eq!(c.endpoint_a.side, RoomSide::East);
        assert_eq!(c.endpoint_b.expect("B").side, RoomSide::West);
        assert_port(c.endpoint_a.port_offset, 0.5, "cardinal wall midpoint A");
        assert_port(
            c.endpoint_b.expect("B").port_offset,
            0.5,
            "cardinal wall midpoint B",
        );
        assert_eq!(c.kind, ConnectionKind::Internal);
        assert_eq!(c.routing, ConnectionRouting::Simple);
        assert_eq!(c.dash, ConnectionDash::Solid);
        assert_eq!(c.color, DEFAULT_CONNECTION_COLOR);
    }

    #[test]
    fn fixture_b_missing_arrival_directions_still_pair() {
        let migrated = migrate_v1(
            FixtureBuilder::new(0x02)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 2.0, 0.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::East,
                    Some((fx_area_id(0x02), 2)),
                    None,
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    2,
                    2,
                    ExitDirection::West,
                    Some((fx_area_id(0x02), 1)),
                    None,
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 2);
        assert_eq!(migrated.connections.len(), 1, "missing arrivals still pair");
        let c = &migrated.connections[0];
        assert_eq!(c.endpoint_a.room_number, RoomNumber(1));
        assert_eq!(c.endpoint_a.side, RoomSide::East);
        assert_eq!(c.endpoint_b.expect("B").side, RoomSide::West);
    }

    #[test]
    fn fixture_c_contradictory_directions_do_not_pair() {
        let migrated = migrate_v1(
            FixtureBuilder::new(0x03)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 2.0, 0.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::East,
                    Some((fx_area_id(0x03), 2)),
                    Some(ExitDirection::South),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    2,
                    2,
                    ExitDirection::West,
                    Some((fx_area_id(0x03), 1)),
                    Some(ExitDirection::North),
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 2);
        assert_eq!(migrated.connections.len(), 2);
        let c1 = conn_of(&migrated, fx_exit_id(0x03, 1));
        let c2 = conn_of(&migrated, fx_exit_id(0x03, 2));
        assert_ne!(c1.id, c2.id, "contradictory exits never share a Connection");
        assert_eq!(
            endpoint_set(c1),
            vec![(1, RoomSide::East), (2, RoomSide::South)]
        );
        assert_eq!(
            endpoint_set(c2),
            vec![(1, RoomSide::North), (2, RoomSide::West)]
        );
    }

    #[test]
    fn fixture_d_ambiguous_multi_return_never_pairs() {
        // Room 2 north of room 1 (map space: +y South).
        let migrated = migrate_v1(
            FixtureBuilder::new(0x04)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 0.0, -2.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::North,
                    Some((fx_area_id(0x04), 2)),
                    Some(ExitDirection::South),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    2,
                    2,
                    ExitDirection::South,
                    Some((fx_area_id(0x04), 1)),
                    Some(ExitDirection::North),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    3,
                    2,
                    ExitDirection::South,
                    Some((fx_area_id(0x04), 1)),
                    Some(ExitDirection::North),
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 3);
        assert_eq!(migrated.connections.len(), 3, "ambiguity never pairs");

        // Pinned ports: all three endpoints on each shared wall keep the
        // direction's wall midpoint and simply coincide — a port never moves
        // to make room for wall-mates.
        for (room, side) in [(1, RoomSide::North), (2, RoomSide::South)] {
            let endpoints = wall_ports(&migrated, room, side);
            assert_eq!(endpoints.len(), 3);
            for (_, port) in endpoints {
                assert_port(port, 0.5, "pinned cardinal midpoint");
            }
        }
    }

    #[test]
    fn fixture_e_two_links_between_same_rooms() {
        let migrated = migrate_v1(
            FixtureBuilder::new(0x05)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 2.0, -2.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::North,
                    Some((fx_area_id(0x05), 2)),
                    Some(ExitDirection::South),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    2,
                    2,
                    ExitDirection::South,
                    Some((fx_area_id(0x05), 1)),
                    Some(ExitDirection::North),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    3,
                    1,
                    ExitDirection::East,
                    Some((fx_area_id(0x05), 2)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    4,
                    2,
                    ExitDirection::West,
                    Some((fx_area_id(0x05), 1)),
                    Some(ExitDirection::East),
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 4);
        assert_eq!(migrated.connections.len(), 2);
        let north = conn_of(&migrated, fx_exit_id(0x05, 1));
        let east = conn_of(&migrated, fx_exit_id(0x05, 3));
        assert_ne!(north.id, east.id);
        assert_eq!(conn_of(&migrated, fx_exit_id(0x05, 2)).id, north.id);
        assert_eq!(conn_of(&migrated, fx_exit_id(0x05, 4)).id, east.id);
        for c in [north, east] {
            assert_eq!(c.endpoint_a.room_number, RoomNumber(1), "lower room is A");
        }
        assert_eq!(north.endpoint_a.side, RoomSide::North);
        assert_eq!(north.endpoint_b.expect("B").side, RoomSide::South);
        assert_eq!(east.endpoint_a.side, RoomSide::East);
        assert_eq!(east.endpoint_b.expect("B").side, RoomSide::West);
    }

    #[test]
    fn fixture_f_plain_one_way() {
        let migrated = migrate_v1(
            FixtureBuilder::new(0x06)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 2.0, 0.0, 0, false)
                .room(3, 0.0, 2.0, 0, false)
                .room(4, 0.0, 4.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::East,
                    Some((fx_area_id(0x06), 2)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    2,
                    3,
                    ExitDirection::South,
                    Some((fx_area_id(0x06), 4)),
                    None,
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 2);
        assert_eq!(migrated.connections.len(), 2);

        // Explicit to_direction: destination anchor is West.
        let c1 = conn_of(&migrated, fx_exit_id(0x06, 1));
        assert_eq!(
            endpoint_set(c1),
            vec![(1, RoomSide::East), (2, RoomSide::West)]
        );
        assert_eq!(c1.kind, ConnectionKind::Internal);

        // Missing to_direction: the arrival anchor faces back toward the
        // origin (room 4 sits south of room 3 -> the bearing back is North).
        let c2 = conn_of(&migrated, fx_exit_id(0x06, 2));
        assert_eq!(
            endpoint_set(c2),
            vec![(3, RoomSide::South), (4, RoomSide::North)]
        );
    }

    #[test]
    fn fixture_g_self_loops() {
        let migrated = migrate_v1(
            FixtureBuilder::new(0x07)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 3.0, 0.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::East,
                    Some((fx_area_id(0x07), 1)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    2,
                    1,
                    ExitDirection::West,
                    Some((fx_area_id(0x07), 1)),
                    Some(ExitDirection::East),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    3,
                    2,
                    ExitDirection::North,
                    Some((fx_area_id(0x07), 2)),
                    Some(ExitDirection::North),
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 3);
        assert_eq!(migrated.connections.len(), 3, "self-loops never pair");
        for c in &migrated.connections {
            assert_eq!(c.kind, ConnectionKind::SelfLoop);
            assert_eq!(
                c.endpoint_b.expect("B").room_number,
                c.endpoint_a.room_number
            );
        }
        let loop1 = conn_of(&migrated, fx_exit_id(0x07, 1));
        let loop2 = conn_of(&migrated, fx_exit_id(0x07, 2));
        assert_ne!(loop1.id, loop2.id);
        assert_eq!(
            endpoint_set(loop1),
            vec![(1, RoomSide::East), (1, RoomSide::West)]
        );

        // §1.4 inv. 9 probe: a loop departing West and arriving East puts
        // its arrival anchor at endpoint A (East precedes West in side
        // ordinal); the origin role is only the final tie-break.
        assert_eq!(loop2.endpoint_a.side, RoomSide::East);
        assert_eq!(loop2.endpoint_b.expect("B").side, RoomSide::West);

        // Pinned ports: every loop endpoint keeps its direction's wall
        // midpoint even where two loops share a wall.
        for side in [RoomSide::East, RoomSide::West] {
            let endpoints = wall_ports(&migrated, 1, side);
            assert_eq!(endpoints.len(), 2);
            for (_, port) in endpoints {
                assert_port(port, 0.5, "pinned loop endpoint");
            }
        }

        // Same-wall loop: both endpoints share (room 2, North) and both keep
        // the midpoint; the loop arc, not port spacing, separates them.
        let loop3 = conn_of(&migrated, fx_exit_id(0x07, 3));
        assert_eq!(loop3.endpoint_a.side, RoomSide::North);
        assert_eq!(loop3.endpoint_b.expect("B").side, RoomSide::North);
        assert_port(loop3.endpoint_a.port_offset, 0.5, "pinned loop role A");
        assert_port(
            loop3.endpoint_b.expect("B").port_offset,
            0.5,
            "pinned loop role B",
        );
    }

    #[test]
    fn fixture_h_dangling_exits() {
        // Exit 2 is "dangling-into-area": to_area set, room NULL — the
        // builder cannot express it, so it is patched by hand.
        let foreign = fx_area_id(0x09);
        let mut legacy = FixtureBuilder::new(0x08)
            .room(1, 0.0, 0.0, 0, false)
            .exit(1, 1, ExitDirection::East, None, None, "Normal", "", false)
            .exit(2, 1, ExitDirection::South, None, None, "Normal", "", false)
            .exit(
                3,
                1,
                ExitDirection::Northwest,
                None,
                None,
                "Normal",
                "",
                false,
            )
            .build();
        legacy.rooms[0].exits[1].to_area_id = Some(foreign);
        let migrated = migrate_v1(legacy);

        assert_backfill_invariants(&migrated, 3);
        assert_eq!(migrated.connections.len(), 3);
        for c in &migrated.connections {
            assert!(c.endpoint_b.is_none(), "one-enders have only endpoint A");
        }
        let dangling = conn_of(&migrated, fx_exit_id(0x08, 1));
        assert_eq!(dangling.kind, ConnectionKind::Dangling);
        assert_eq!(dangling.endpoint_a.side, RoomSide::East);
        let into_area = conn_of(&migrated, fx_exit_id(0x08, 2));
        assert_eq!(
            into_area.kind,
            ConnectionKind::External,
            "into-area is External"
        );
        assert_eq!(into_area.endpoint_a.side, RoomSide::South);
        let northwest = conn_of(&migrated, fx_exit_id(0x08, 3));
        assert_eq!(northwest.kind, ConnectionKind::Dangling);
        assert_eq!(
            northwest.endpoint_a.side,
            RoomSide::North,
            "NW anchors North"
        );
        assert!((northwest.endpoint_a.port_offset - CORNER_INSET).abs() < 1.0e-6);
    }

    #[test]
    fn fixture_i_cross_area_single() {
        // The reciprocal-looking reverse lives in ANOTHER area's document;
        // a local migration only ever sees one area, so the outgoing exit
        // becomes a one-member External Connection.
        let other = fx_area_id(0x0b);
        let migrated = migrate_v1(
            FixtureBuilder::new(0x0a)
                .room(1, 0.0, 0.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::East,
                    Some((other, 1)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 1);
        let c = conn_of(&migrated, fx_exit_id(0x0a, 1));
        assert_eq!(c.kind, ConnectionKind::External);
        assert!(c.endpoint_b.is_none(), "cross-area keeps only endpoint A");
        assert_eq!(c.endpoint_a.room_number, RoomNumber(1));
        assert_eq!(c.endpoint_a.side, RoomSide::East);
        assert_port(c.endpoint_a.port_offset, 0.5, "cardinal wall midpoint");
    }

    #[test]
    fn fixture_j_cross_level_pair() {
        let migrated = migrate_v1(
            FixtureBuilder::new(0x0c)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 0.0, 0.0, 1, false)
                .exit(
                    1,
                    1,
                    ExitDirection::Up,
                    Some((fx_area_id(0x0c), 2)),
                    Some(ExitDirection::Down),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    2,
                    2,
                    ExitDirection::Down,
                    Some((fx_area_id(0x0c), 1)),
                    Some(ExitDirection::Up),
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 2);
        assert_eq!(
            migrated.connections.len(),
            1,
            "cross-level reciprocals pair"
        );
        let c = &migrated.connections[0];
        assert_eq!(c.kind, ConnectionKind::CrossLevel);
        assert_eq!(c.endpoint_a.room_number, RoomNumber(1));
        // Up owns the top-right corner (East wall, north end) and Down the
        // bottom-left (West wall, south end) — fixed home slots, so the
        // vertical link never contests a real east exit's wall midpoint.
        assert_eq!(c.endpoint_a.side, RoomSide::East);
        assert_port(c.endpoint_a.port_offset, CORNER_INSET, "up = top-right");
        assert_eq!(c.endpoint_b.expect("B").side, RoomSide::West);
        assert_port(
            c.endpoint_b.expect("B").port_offset,
            1.0 - CORNER_INSET,
            "down = bottom-left",
        );
    }

    #[test]
    fn fixture_k_secrecy_never_shapes_ports() {
        // Hub room 1; destinations east of it at distinct y; room 4 is a
        // secret destination, room 6 a secret origin, exit 5 leaves the
        // area. Ports are pinned per direction, so none of that secrecy can
        // reach a public coordinate — every east endpoint keeps the wall
        // midpoint regardless of what shares the wall.
        let cross = fx_area_id(0x0e);
        let area = fx_area_id(0x0d);
        let migrated = migrate_v1(
            FixtureBuilder::new(0x0d)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 4.0, -3.0, 0, false)
                .room(3, 4.0, -1.0, 0, false)
                .room(4, 4.0, 1.0, 0, true)
                .room(5, 4.0, 3.0, 0, false)
                .room(6, 4.0, 5.0, 0, true)
                .exit(
                    1,
                    1,
                    ExitDirection::East,
                    Some((area, 2)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    2,
                    1,
                    ExitDirection::East,
                    Some((area, 3)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    true,
                )
                .exit(
                    3,
                    1,
                    ExitDirection::East,
                    Some((area, 4)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    4,
                    1,
                    ExitDirection::East,
                    Some((area, 5)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    5,
                    1,
                    ExitDirection::East,
                    Some((cross, 1)),
                    None,
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    6,
                    6,
                    ExitDirection::West,
                    Some((area, 1)),
                    Some(ExitDirection::East),
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 6);
        assert_eq!(migrated.connections.len(), 6);

        let ports: HashMap<ConnectionId, f32> = wall_ports(&migrated, 1, RoomSide::East)
            .into_iter()
            .collect();
        assert_eq!(ports.len(), 6, "six endpoints share room 1's east wall");

        let cross_ext = conn_of(&migrated, fx_exit_id(0x0d, 5)); // external
        let secret_origin = conn_of(&migrated, fx_exit_id(0x0d, 6)); // from secret room 6

        // Every endpoint — public, secret-adjacent, and external alike —
        // keeps the East midpoint; secrecy has nothing to influence.
        for (id, port) in &ports {
            assert_port(*port, 0.5, &format!("pinned east midpoint for {id}"));
        }

        assert!(
            cross_ext.endpoint_b.is_none(),
            "External keeps endpoint A only"
        );
        assert_eq!(
            endpoint_set(secret_origin),
            vec![(1, RoomSide::East), (6, RoomSide::West)]
        );
    }

    #[test]
    fn fixture_l_pair_appearance_conflicts() {
        let area = fx_area_id(0x0f);
        let migrated = migrate_v1(
            FixtureBuilder::new(0x0f)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 2.0, 0.0, 0, false)
                .room(3, 0.0, 2.0, 0, false)
                .room(4, 2.0, 2.0, 0, false)
                .room(5, 0.0, 4.0, 0, false)
                .room(6, 2.0, 4.0, 0, false)
                .room(7, 0.0, 6.0, 0, false)
                .room(8, 2.0, 6.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::East,
                    Some((area, 2)),
                    Some(ExitDirection::West),
                    "Dashed",
                    "#ff0000",
                    false,
                )
                .exit(
                    2,
                    2,
                    ExitDirection::West,
                    Some((area, 1)),
                    Some(ExitDirection::East),
                    "Dotted",
                    "#0000ff",
                    false,
                )
                .exit(
                    3,
                    3,
                    ExitDirection::East,
                    Some((area, 4)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    4,
                    4,
                    ExitDirection::West,
                    Some((area, 3)),
                    Some(ExitDirection::East),
                    "Stub",
                    "",
                    false,
                )
                .exit(
                    5,
                    5,
                    ExitDirection::East,
                    Some((area, 6)),
                    Some(ExitDirection::West),
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    6,
                    6,
                    ExitDirection::West,
                    Some((area, 5)),
                    Some(ExitDirection::East),
                    "Normal",
                    "#00ff00",
                    false,
                )
                .exit(
                    7,
                    7,
                    ExitDirection::East,
                    Some((area, 8)),
                    Some(ExitDirection::West),
                    "Stub",
                    "",
                    false,
                )
                .exit(
                    8,
                    8,
                    ExitDirection::West,
                    Some((area, 7)),
                    Some(ExitDirection::East),
                    "Dashed",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 8);
        assert_eq!(migrated.connections.len(), 4);

        // Dashed+red vs Dotted+blue: both non-default -> the lower-origin-
        // room exit wins both fields.
        let pair1 = conn_of(&migrated, fx_exit_id(0x0f, 1));
        assert_eq!(conn_of(&migrated, fx_exit_id(0x0f, 2)).id, pair1.id);
        assert_eq!(pair1.endpoint_a.room_number, RoomNumber(1));
        assert_eq!(pair1.routing, ConnectionRouting::Simple);
        assert_eq!(pair1.dash, ConnectionDash::Dashed, "lower origin room wins");
        assert_eq!(pair1.color, "#ff0000", "lower origin room wins");

        // Normal vs Stub: routing prefers the non-default Stub even from
        // the higher-room member.
        let pair2 = conn_of(&migrated, fx_exit_id(0x0f, 3));
        assert_eq!(pair2.routing, ConnectionRouting::Stub);
        assert_eq!(pair2.dash, ConnectionDash::Solid);
        assert_eq!(pair2.color, DEFAULT_CONNECTION_COLOR);

        // Empty color on the primary, valid on the secondary: the valid one
        // survives — prefer-non-default is per FIELD.
        let pair3 = conn_of(&migrated, fx_exit_id(0x0f, 5));
        assert_eq!(pair3.color, "#00ff00");
        assert_eq!(pair3.routing, ConnectionRouting::Simple);
        assert_eq!(pair3.dash, ConnectionDash::Solid);

        // Stub on one side, Dashed on the other: fields chosen independently.
        let pair4 = conn_of(&migrated, fx_exit_id(0x0f, 7));
        assert_eq!(pair4.routing, ConnectionRouting::Stub);
        assert_eq!(pair4.dash, ConnectionDash::Dashed);
    }

    #[test]
    fn fixture_m_color_normalization() {
        let long_color = "a".repeat(70);
        let migrated = migrate_v1(
            FixtureBuilder::new(0x10)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, 0.0, 2.0, 0, false)
                .room(3, 0.0, 4.0, 0, false)
                .room(4, 0.0, 6.0, 0, false)
                .room(5, 0.0, 8.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::East,
                    None,
                    None,
                    "Normal",
                    "not a color!!",
                    false,
                )
                .exit(
                    2,
                    2,
                    ExitDirection::East,
                    None,
                    None,
                    "Normal",
                    &long_color,
                    false,
                )
                .exit(
                    3,
                    3,
                    ExitDirection::East,
                    None,
                    None,
                    "Normal",
                    "red",
                    false,
                )
                .exit(4, 4, ExitDirection::East, None, None, "Normal", "", false)
                .exit(
                    5,
                    5,
                    ExitDirection::East,
                    None,
                    None,
                    "Normal",
                    "#AbC",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 5);
        let cases: [(u32, &str); 5] = [
            (1, DEFAULT_CONNECTION_COLOR), // malformed
            (2, DEFAULT_CONNECTION_COLOR), // over the 64-byte bound
            (3, "red"),                    // valid named color preserved
            (4, DEFAULT_CONNECTION_COLOR), // empty normalizes
            (5, "#AbC"),                   // valid short hex preserved
        ];
        for (n, expected) in cases {
            let c = conn_of(&migrated, fx_exit_id(0x10, n));
            assert_eq!(c.color, expected, "exit {n} color mapping");
            assert_eq!(c.routing, ConnectionRouting::Simple);
            assert_eq!(c.dash, ConnectionDash::Solid);
        }
    }

    #[test]
    fn fixture_n_crowded_wall_ports_stay_pinned() {
        // Four one-way north exits fan out to three rooms above room 1. The
        // origin ports all keep the North midpoint (coinciding by design);
        // the arrival ports — whose exits carry no to_direction — still
        // derive from the bearing back toward the origin, exercising the
        // diagonal corner insets.
        let area = fx_area_id(0x11);
        let migrated = migrate_v1(
            FixtureBuilder::new(0x11)
                .room(1, 0.0, 0.0, 0, false)
                .room(2, -3.0, -4.0, 0, false)
                .room(3, 0.0, -4.0, 0, false)
                .room(4, 3.0, -4.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::North,
                    Some((area, 2)),
                    None,
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    2,
                    1,
                    ExitDirection::North,
                    Some((area, 3)),
                    None,
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    3,
                    1,
                    ExitDirection::North,
                    Some((area, 3)),
                    None,
                    "Normal",
                    "",
                    false,
                )
                .exit(
                    4,
                    1,
                    ExitDirection::North,
                    Some((area, 4)),
                    None,
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 4);
        assert_eq!(migrated.connections.len(), 4);

        let ports: Vec<(ConnectionId, f32)> = wall_ports(&migrated, 1, RoomSide::North);
        assert_eq!(ports.len(), 4);
        for (_, port) in &ports {
            assert_port(*port, 0.5, "origin north exits stay at the midpoint");
        }

        // Arrival defaults from the bearing back toward room 1: room 2 sits
        // up-left (return bearing SE, ratio 3:4 = exactly diagonal) → South
        // wall at the SE corner inset; room 3 straight above → South
        // midpoint for both tied one-ways; room 4 up-right → SW inset.
        let arrivals = [
            (2, 1.0 - CORNER_INSET, "southeast corner inset"),
            (4, CORNER_INSET, "southwest corner inset"),
        ];
        for (room, expected, ctx) in arrivals {
            let wall = wall_ports(&migrated, room, RoomSide::South);
            assert_eq!(wall.len(), 1);
            assert_port(wall[0].1, expected, ctx);
        }
        let south = wall_ports(&migrated, 3, RoomSide::South);
        assert_eq!(south.len(), 2);
        for (_, port) in south {
            assert_port(port, 0.5, "tied arrivals both keep the midpoint");
        }
    }

    #[test]
    fn probe_one_way_canonical_orientation_lower_room_is_a() {
        // A one-way from room 6 to room 5 backfills with endpoint A = room
        // 5 (§1.4 inv. 9 — the member may traverse opposite canonical A->B).
        let area = fx_area_id(0x12);
        let migrated = migrate_v1(
            FixtureBuilder::new(0x12)
                .room(5, 0.0, 0.0, 0, false)
                .room(6, 2.0, 0.0, 0, false)
                .exit(
                    1,
                    6,
                    ExitDirection::West,
                    Some((area, 5)),
                    Some(ExitDirection::East),
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 1);
        let c = conn_of(&migrated, fx_exit_id(0x12, 1));
        assert_eq!(c.endpoint_a.room_number, RoomNumber(5), "lower room is A");
        assert_eq!(c.endpoint_a.side, RoomSide::East);
        assert_eq!(c.endpoint_b.expect("B").room_number, RoomNumber(6));
        assert_eq!(c.endpoint_b.expect("B").side, RoomSide::West);
    }

    #[test]
    fn same_area_destination_without_a_room_gains_a_placeholder() {
        // A v1 file can reference a same-area destination room that is not
        // in the document (the cloud FK forbids this; local files cannot).
        // The migration materializes a blank placeholder so every endpoint
        // resolves.
        let area = fx_area_id(0x20);
        let migrated = migrate_v1(
            FixtureBuilder::new(0x20)
                .room(1, 0.0, 0.0, 0, false)
                .exit(
                    1,
                    1,
                    ExitDirection::East,
                    Some((area, 9)),
                    None,
                    "Normal",
                    "",
                    false,
                )
                .build(),
        );
        assert_backfill_invariants(&migrated, 1);
        assert!(
            migrated
                .rooms
                .iter()
                .any(|room| room.room_number == RoomNumber(9) && room.title.is_empty()),
            "placeholder destination room materialized"
        );
        let c = conn_of(&migrated, fx_exit_id(0x20, 1));
        assert_eq!(c.endpoint_b.expect("B").room_number, RoomNumber(9));
    }

    #[test]
    fn v1_json_deserializes_and_v2_types_reject_v1() {
        let area = fx_area_id(0x21);
        let raw = serde_json::json!({
            "id": area.0,
            "user_id": null,
            "atlas_id": null,
            "name": "Old Cellars",
            "created_at": "2024-01-01T00:00:00Z",
            "rev": 3,
            "properties": [],
            "rooms": [{
                "room_number": 1,
                "title": "Hall",
                "description": "",
                "level": 0,
                "x": 0.0,
                "y": 0.0,
                "color": "",
                "properties": [],
                "exits": [{
                    "id": fx_exit_id(0x21, 1).0,
                    "from_direction": "North",
                    "to_area_id": null,
                    "to_room_number": null,
                    "to_direction": null,
                    "path": "",
                    "is_hidden": false,
                    "is_closed": false,
                    "is_locked": false,
                    "weight": 1.0,
                    "command": "",
                    "style": "Stub",
                    "color": "#123456"
                }]
            }],
            "labels": [],
            "shapes": []
        });

        // The explicit legacy DTO accepts it...
        let legacy: LegacyAreaV1 =
            serde_json::from_value(raw.clone()).expect("v1 JSON parses as LegacyAreaV1");
        let migrated = migrate_v1(legacy);
        assert_backfill_invariants(&migrated, 1);
        let c = conn_of(&migrated, fx_exit_id(0x21, 1));
        assert_eq!(c.routing, ConnectionRouting::Stub);
        assert_eq!(c.color, "#123456");

        // ...and the v2 types do NOT (a v1 exit has no connection_id).
        assert!(
            serde_json::from_value::<AreaWithDetails>(raw).is_err(),
            "the v2 document type must not tolerate v1 exits"
        );
    }
}
