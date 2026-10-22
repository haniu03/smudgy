//! Labels attached to rooms, on the editor canvas: which room a dragged or
//! drawn label attaches to, and the tether, ring and name that show it.
//!
//! A label attaches to the room nearest the pointer on the current level,
//! within [`REACH`], among the map's rooms and its own source's. A map label
//! never attaches to a Secret's room: readers without the Secret would lose
//! it. Ctrl (⌘ on macOS) leaves a label free; Alt only turns off the grid.

use iced::widget::canvas;
use iced::{Color, Point, Rectangle, Vector};
use smudgy_cloud::{
    Label, LabelId, RoomAddress, SourceId,
    mapper::area_cache::{AreaCache, SourceLayer},
};

use super::{EntityId, MapEditor};
use crate::render;

/// How far from the pointer, in map units, a label still finds a room.
/// Rooms sit one unit apart.
pub const REACH: f32 = 5.0;

/// How much nearer, in map units, another room must be before a dragged
/// label leaves the room it is attaching to, so the tether doesn't flicker
/// between neighbors.
const HYSTERESIS: f32 = 0.25;

/// The longest room title a target's name tag shows, in characters.
const TAG_CHARACTERS: usize = 32;

/// The color a map label's tether and target draw in; a source's label uses
/// its source's color.
pub const MAP_TETHER: Color = Color::from_rgba(1.0, 0.98, 0.937, 0.9);

/// A label in a drag of labels alone, and the room it attaches to on
/// release.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DraggedLabel {
    pub id: LabelId,
    /// The source holding the label, which decides the rooms it may use.
    pub source: SourceId,
    /// Where the label looks for a room from, relative to the pointer: zero
    /// for the label pressed, its offset from that label for the others.
    pub grab: Vector,
    pub target: Option<RoomAddress>,
}

impl DraggedLabel {
    /// Whether this is the label the drag started on.
    #[must_use]
    pub fn leads(&self) -> bool {
        self.grab == Vector::new(0.0, 0.0)
    }
}

/// Whether a label in `source` may attach to the room at `room`.
#[must_use]
pub fn may_attach(room: RoomAddress, source: SourceId) -> bool {
    room.source.is_map() || room.source == source
}

/// A label's box where it is drawn, and the level it is drawn on.
#[must_use]
pub fn placed_rect(area: &AreaCache, label: &Label) -> Option<(Rectangle, i32)> {
    let place = area.label_place(label)?;
    Some((
        Rectangle::new(
            Point::new(place.x, place.y),
            iced::Size::new(label.width, label.height),
        ),
        place.level,
    ))
}

/// Every label of the map and its sources, with the source holding it.
pub fn all_labels(area: &AreaCache) -> impl Iterator<Item = (SourceId, &Label)> {
    area.get_labels()
        .iter()
        .map(|label| (SourceId::Map, label))
        .chain(area.source_layers().iter().flat_map(|layer| {
            layer
                .content()
                .get_labels()
                .iter()
                .map(move |label| (layer.source(), label))
        }))
}

impl MapEditor {
    /// The labels a drag of the selection attaches, each starting from the
    /// room it is attached to. Empty when the selection holds a room:
    /// labels dragged with rooms keep their rooms.
    pub(super) fn dragged_labels(
        &self,
        area: &AreaCache,
        pressed: EntityId,
        start: Point,
    ) -> Vec<DraggedLabel> {
        if self.selection.rooms().next().is_some() || self.selection.source_rooms().next().is_some()
        {
            return Vec::new();
        }
        let center = |id: LabelId| {
            let (layer, label) = area.find_label(&id)?;
            let (rect, _) = placed_rect(area, label)?;
            Some((SourceLayer::source_of(layer), label.room(), rect.center()))
        };
        let origin = match pressed {
            EntityId::Label(id) => center(id).map(|(_, _, point)| point),
            _ => None,
        }
        .unwrap_or(start);
        self.selection
            .labels()
            .filter_map(|id| {
                let (source, room, point) = center(id)?;
                Some(DraggedLabel {
                    id,
                    source,
                    grab: point - origin,
                    target: room,
                })
            })
            .collect()
    }

    /// The room the label `id` would attach to where it is drawn: the one
    /// nearest its center, as a drag that ends there would choose.
    #[must_use]
    pub fn nearest_room_for_label(&self, id: LabelId) -> Option<RoomAddress> {
        let atlas = self.mapper.get_current_atlas();
        let area = atlas.get_area(self.area_id.as_ref()?)?;
        let (layer, label) = area.find_label(&id)?;
        let (rect, _) = placed_rect(&area, label)?;
        self.label_room_near(&area, rect.center(), SourceLayer::source_of(layer), None)
    }

    /// Points each dragged label at the room it would attach to with the
    /// pointer at `pointer`, or at none when `free`.
    pub(super) fn retarget(
        &self,
        area: &AreaCache,
        labels: &mut [DraggedLabel],
        pointer: Point,
        free: bool,
    ) {
        for label in labels {
            label.target = if free {
                None
            } else {
                self.label_room_near(area, pointer + label.grab, label.source, label.target)
            };
        }
    }

    /// The room on the current level nearest `point`, within [`REACH`], that
    /// a label in `source` may attach to. `current` keeps the target until
    /// another room is clearly nearer.
    pub(super) fn label_room_near(
        &self,
        area: &AreaCache,
        point: Point,
        source: SourceId,
        current: Option<RoomAddress>,
    ) -> Option<RoomAddress> {
        let distance = |x: f32, y: f32| (x - point.x).hypot(y - point.y);
        let mut best: Option<(RoomAddress, f32)> = None;
        let mut consider = |address: RoomAddress, x: f32, y: f32| {
            let found = distance(x, y);
            if found <= REACH && best.is_none_or(|(_, nearest)| found < nearest) {
                best = Some((address, found));
            }
        };
        area.with_rooms_in(
            point.x - REACH,
            point.y - REACH,
            point.x + REACH,
            point.y + REACH,
            |room| {
                if room.get_level() == self.level {
                    consider(
                        RoomAddress::map(room.get_room_number()),
                        room.get_x(),
                        room.get_y(),
                    );
                }
            },
        );
        if let Some(layer) = area
            .source_layers()
            .iter()
            .find(|layer| !source.is_map() && layer.source() == source)
        {
            for room in layer.content().get_rooms() {
                if room.get_level() == self.level {
                    consider(
                        RoomAddress::new(source, room.get_room_number()),
                        room.get_x(),
                        room.get_y(),
                    );
                }
            }
        }
        let (nearest, nearest_distance) = best?;
        if let Some(current) =
            current.filter(|current| *current != nearest && may_attach(*current, source))
            && let Some(room) = area.map_room_at(current)
            && room.get_level() == self.level
        {
            let kept = distance(room.get_x(), room.get_y());
            if kept <= REACH && kept - nearest_distance < HYSTERESIS {
                return Some(current);
            }
        }
        Some(nearest)
    }
}

/// The dashed line from a room, centered at `room`, to a label attached to
/// it, from just outside the room's square to the nearest point of the
/// label's box, with a dot at the room's end. Only the dot when the label
/// touches the room. `strong` draws it as the selection's; otherwise it is
/// a hover's faint one.
pub fn draw_tether(
    frame: &mut canvas::Frame,
    room: Point,
    label: Rectangle,
    color: Color,
    scaling: f32,
    strong: bool,
) {
    let half = render::MAP_ROOM_SIZE / 2.0;
    let nearest = Point::new(
        room.x.clamp(label.x, label.x + label.width),
        room.y.clamp(label.y, label.y + label.height),
    );
    let mut toward = nearest - room;
    let reach = toward.x.abs().max(toward.y.abs());
    if reach <= half + 0.05 {
        toward = label.center() - room;
    }
    let along = toward.x.abs().max(toward.y.abs());
    if along <= f32::EPSILON {
        return;
    }
    let start = room + toward * ((half + 0.08) / along);
    let color = render::apply_opacity(color, if strong { 0.95 } else { 0.45 });
    if reach > half + 0.05 {
        let stroke = canvas::Stroke {
            line_dash: canvas::LineDash {
                segments: &[0.12, 0.08],
                offset: 0,
            },
            ..render::solid_stroke(color, if strong { 1.6 } else { 1.2 })
        };
        frame.stroke(&canvas::Path::line(start, nearest), stroke);
    }
    let radius = if strong { 3.0 } else { 2.2 } / scaling;
    frame.fill(&canvas::Path::circle(start, radius), color);
}

/// The ring around the room, centered at `room`, a dragged label attaches
/// to, with the room's title on the side away from the label.
pub fn draw_target(
    frame: &mut canvas::Frame,
    room: Point,
    title: &str,
    label: Rectangle,
    color: Color,
    scaling: f32,
) {
    let half = render::MAP_ROOM_SIZE / 2.0 + 0.12;
    let path = canvas::Path::rounded_rectangle(
        Point::new(room.x - half, room.y - half),
        iced::Size::new(half * 2.0, half * 2.0),
        (render::MAP_ROOM_BORDER_RADIUS + 0.12).into(),
    );
    frame.stroke(&path, render::solid_stroke(color, 2.0));

    let title = title.trim();
    if title.is_empty() {
        return;
    }
    let shown: String = if title.chars().count() > TAG_CHARACTERS {
        title
            .chars()
            .take(TAG_CHARACTERS - 1)
            .chain(std::iter::once('…'))
            .collect()
    } else {
        title.to_string()
    };
    let size = 12.0 / scaling;
    let gap = half + 6.0 / scaling;
    let below = label.center().y <= room.y;
    let (y, align_y) = if below {
        (room.y + gap, iced::alignment::Vertical::Top)
    } else {
        (room.y - gap, iced::alignment::Vertical::Bottom)
    };
    // A dark halo keeps the name legible over rooms and links.
    let shadow = Color::from_rgba(0.0, 0.0, 0.0, 0.85);
    let pixel = 1.0 / scaling;
    for (dx, dy) in [(-pixel, 0.0), (pixel, 0.0), (0.0, -pixel), (0.0, pixel)] {
        frame.fill_text(canvas::Text {
            content: shown.clone(),
            position: Point::new(room.x + dx, y + dy),
            align_x: iced::widget::text::Alignment::Center,
            align_y,
            color: shadow,
            size: size.into(),
            ..canvas::Text::default()
        });
    }
    frame.fill_text(canvas::Text {
        content: shown,
        position: Point::new(room.x, y),
        align_x: iced::widget::text::Alignment::Center,
        align_y,
        color: render::apply_opacity(color, 1.0),
        size: size.into(),
        ..canvas::Text::default()
    });
}
