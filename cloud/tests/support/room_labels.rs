//! Labels attached to rooms (format-3 §2.2). Fidelity reference: the
//! smudgy-cloudflare service (`src/library/graph/drawings.ts`, `rows.ts`,
//! the `label_rooms` table and its `label_rooms_freed` trigger).
//!
//! A label names its room by the room's identity, as the server's
//! `label_rooms` row names the room's instance, so a move between sources or
//! a renumbering changes nothing the label holds. An attached label's `x`
//! and `y` are its top-left corner's offset from the room's center, and it is
//! drawn on the room's current level. A label whose room the reader cannot
//! read is left out, and answers writes as one that does not exist.

use std::collections::{BTreeSet, HashMap};

use serde_json::{Map, Value, json};
use uuid::Uuid;

use super::source_refs::{self as refs, Source};
use super::state::{AreaRecord, LabelRecord, MockState, RoomRecord};

/// The room a label is attached to, as the wire names it: its owning
/// source's wire id (`None` for a map room) and the room.
pub type Attached<'a> = (Option<String>, &'a RoomRecord);

/// The wire label. An attached one carries `room_number` and, for a room
/// that is not the map's, `room_source`, and stands on its room's level; a
/// free one carries neither key. A mutation echo (`echo` names the map)
/// carries `area_id` after `id` and `created_at` at the end.
pub fn wire(label: &LabelRecord, echo: Option<Uuid>, room: Option<Attached<'_>>) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(label.id));
    if let Some(area_id) = echo {
        out.insert("area_id".into(), json!(area_id));
    }
    if let Some((source, room)) = &room {
        out.insert("room_number".into(), json!(room.room_number));
        if let Some(source) = source {
            out.insert("room_source".into(), json!(source));
        }
    }
    let level = room.as_ref().map_or(label.level, |(_, room)| room.level);
    out.insert("level".into(), json!(level));
    out.insert("x".into(), json!(label.x));
    out.insert("y".into(), json!(label.y));
    out.insert("width".into(), json!(label.width));
    out.insert("height".into(), json!(label.height));
    out.insert(
        "horizontal_alignment".into(),
        json!(label.horizontal_alignment),
    );
    out.insert("vertical_alignment".into(), json!(label.vertical_alignment));
    out.insert("text".into(), json!(label.text));
    out.insert("color".into(), json!(label.color));
    out.insert("background_color".into(), json!(label.background_color));
    out.insert("font_size".into(), json!(label.font_size));
    out.insert("font_weight".into(), json!(label.font_weight));
    if echo.is_some() {
        out.insert("created_at".into(), json!(label.created_at));
    }
    Value::Object(out)
}

/// The wire id `area` gives `source` in a label's `room_source`: none for
/// the map.
pub fn source_wire(area: &AreaRecord, source: Source) -> Option<String> {
    (source != Source::Map).then(|| refs::wire(area, source))
}

/// `label` of `area` as `viewer` reads it: `None` while it is attached to a
/// room they cannot read, or to none the map holds.
pub fn shown(
    st: &MockState,
    viewer: Uuid,
    area: &AreaRecord,
    label: &LabelRecord,
) -> Option<Value> {
    let Some(identity) = label.room else {
        return Some(wire(label, None, None));
    };
    let (owner, room) = refs::find(area, identity)?;
    refs::readable(st, viewer, area, owner)
        .then(|| wire(label, None, Some((source_wire(area, owner), room))))
}

/// Whether `viewer` reads the room `label` of `area` is attached to; a free
/// label is always read.
pub fn readable(st: &MockState, viewer: Uuid, area: &AreaRecord, label: &LabelRecord) -> bool {
    label.room.is_none_or(|identity| {
        refs::find(area, identity).is_some_and(|(owner, _)| refs::readable(st, viewer, area, owner))
    })
}

/// The labels `source` of `area` draws.
pub fn labels_mut(area: &mut AreaRecord, source: Source) -> &mut Vec<LabelRecord> {
    match source {
        Source::Map => &mut area.labels,
        Source::Secret(i) => &mut area.secrets[i].labels,
        Source::Private(user) => {
            &mut area
                .private_sources
                .get_mut(&user)
                .expect("a held Private source")
                .labels
        }
    }
}

/// Frees every label of `labels` attached to `gone` where it is drawn: at
/// the room's position plus its offset, on the room's level. Whether any
/// was.
pub fn free(labels: &mut [LabelRecord], gone: &RoomRecord) -> bool {
    let mut freed = false;
    for label in labels
        .iter_mut()
        .filter(|label| label.room == Some(gone.identity))
    {
        label.room = None;
        label.x += gone.x;
        label.y += gone.y;
        label.level = gone.level;
        freed = true;
    }
    freed
}

/// [`free`] over every source of `area`: the sources whose labels it freed.
pub fn free_everywhere(area: &mut AreaRecord, gone: &RoomRecord) -> Vec<Source> {
    let sources: Vec<Source> = refs::sources(area).collect();
    sources
        .into_iter()
        .filter(|source| free(labels_mut(area, *source), gone))
        .collect()
}

/// Moves `source`'s revision of `area` by one.
pub fn bump(area: &mut AreaRecord, source: Source) {
    match refs::record_mut(area, source) {
        Some(record) => record.rev += 1,
        None => area.rev += 1,
    }
}

/// `source` of `area` is going with its rooms: every label another source
/// attaches to one of them is freed where it is drawn, and each such
/// source's revision moves once (the server's `dropSecret`).
pub fn release_rooms_of(area: &mut AreaRecord, source: Source) {
    let gone: Vec<RoomRecord> = refs::rooms(area, source)
        .iter()
        .filter(|(key, room)| refs::own(source, **key, room))
        .map(|(_, room)| room.clone())
        .collect();
    let mut changed = BTreeSet::new();
    for room in &gone {
        changed.extend(
            free_everywhere(area, room)
                .into_iter()
                .filter(|other| *other != source),
        );
    }
    for other in changed {
        bump(area, other);
    }
}

/// A copy's labels follow the copy's rooms: each attached label names the
/// copied room `rooms` maps its room to. A label attached to a room the copy
/// leaves out stays behind with the original.
pub fn rebind(copy: &mut AreaRecord, rooms: &HashMap<Uuid, Uuid>) {
    let sources: Vec<Source> = refs::sources(copy).collect();
    for source in sources {
        for label in labels_mut(copy, source) {
            if let Some(identity) = label.room {
                label.room = Some(rooms.get(&identity).copied().unwrap_or_else(Uuid::new_v4));
            }
        }
    }
    drop_unheld(copy);
}

/// Drops every label of `area` attached to a room `area` does not hold.
pub fn drop_unheld(area: &mut AreaRecord) {
    let held: BTreeSet<Uuid> = refs::sources(area)
        .flat_map(|source| {
            refs::rooms(area, source)
                .iter()
                .filter(move |(key, room)| refs::own(source, **key, room))
                .map(|(_, room)| room.identity)
        })
        .collect();
    let sources: Vec<Source> = refs::sources(area).collect();
    for source in sources {
        labels_mut(area, source).retain(|label| label.room.is_none_or(|room| held.contains(&room)));
    }
}
