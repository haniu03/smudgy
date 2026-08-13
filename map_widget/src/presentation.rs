//! View-local map appearance and transient overlays.
//!
//! These values belong to a `<MapView />` instance, not to an area. Scripts
//! can therefore highlight a speedwalk, restyle a shared map, or override a
//! live door state without writing collaborative map data.

use smudgy_cloud::{ConnectionId, ExitDirection, Uuid};

fn default_room_spacing() -> f32 {
    1.0
}

fn default_route_color() -> String {
    "#4da3ff".to_string()
}

fn default_route_width() -> f32 {
    4.0
}

fn default_door_color() -> String {
    "#3f3f46".to_string()
}

/// Author-controlled defaults for one map view.
#[derive(Debug, Clone, PartialEq)]
pub struct MapViewStyle {
    /// Multiplies room coordinates while keeping room glyphs the same size.
    pub room_spacing: f32,
    /// Rounded-room corner radius in map units (`0..=0.25`).
    pub room_border_radius: Option<f32>,
    pub room_stroke: Option<String>,
    pub room_stroke_width: Option<f32>,
    pub connection_color: Option<String>,
    pub connection_width: Option<f32>,
    pub player_color: Option<String>,
    pub route_color: String,
    pub route_width: f32,
    pub door_color: String,
    pub show_doors: bool,
}

impl Default for MapViewStyle {
    fn default() -> Self {
        Self {
            room_spacing: default_room_spacing(),
            room_border_radius: None,
            room_stroke: None,
            room_stroke_width: None,
            connection_color: None,
            connection_width: None,
            player_color: None,
            route_color: default_route_color(),
            route_width: default_route_width(),
            door_color: default_door_color(),
            show_doors: true,
        }
    }
}

impl MapViewStyle {
    /// Clamp untrusted script/store values to finite renderer-safe ranges.
    #[must_use]
    pub fn normalized(mut self) -> Self {
        self.room_spacing = finite_clamp(self.room_spacing, 0.25, 4.0, 1.0);
        self.room_border_radius = self
            .room_border_radius
            .map(|value| finite_clamp(value, 0.0, 0.25, 0.1));
        self.room_stroke_width = self
            .room_stroke_width
            .map(|value| finite_clamp(value, 0.0, 20.0, 2.0));
        self.connection_width = self
            .connection_width
            .map(|value| finite_clamp(value, 0.0, 20.0, 1.0));
        self.route_width = finite_clamp(self.route_width, 0.0, 20.0, default_route_width());
        self
    }
}

fn finite_clamp(value: f32, min: f32, max: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

/// A transient per-room appearance override.
#[derive(Debug, Clone, PartialEq)]
pub struct RoomOverlay {
    pub room: i32,
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub stroke_width: Option<f32>,
}

/// One route traversal endpoint, identified without a persistent Connection ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteExitOverlay {
    pub room: i32,
    pub direction: ExitDirection,
}

/// A `[hi, lo]` script-facing connection id with a transient door override.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionDoorOverlay {
    pub connection: (u64, u64),
    pub closed: Option<bool>,
    pub locked: Option<bool>,
}

impl ConnectionDoorOverlay {
    #[must_use]
    pub fn connection_id(&self) -> ConnectionId {
        ConnectionId(Uuid::from_u64_pair(self.connection.0, self.connection.1))
    }
}

/// Ephemeral data supplied to one view. Nothing here is persisted or synced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MapViewOverlay {
    /// Ordered rooms in the active area. Consecutive connected rooms receive
    /// the route accent; every listed room is highlighted.
    pub route: Vec<i32>,
    /// Exact traversed exits. This disambiguates parallel Connections and can
    /// identify outbound cross-area links without putting opaque IDs in state.
    pub route_exits: Vec<RouteExitOverlay>,
    pub rooms: Vec<RoomOverlay>,
    pub doors: Vec<ConnectionDoorOverlay>,
}

impl MapViewOverlay {
    /// Clamp per-item renderer inputs just like the view-wide style. Overlay
    /// values commonly come from mutable script stores, so they need the same
    /// finite-value boundary as static props.
    #[must_use]
    pub fn normalized(mut self) -> Self {
        for room in &mut self.rooms {
            room.stroke_width = room
                .stroke_width
                .map(|value| finite_clamp(value, 0.0, 20.0, 2.0));
        }
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MapViewPresentation {
    pub style: MapViewStyle,
    pub overlay: MapViewOverlay,
}

impl MapViewPresentation {
    #[must_use]
    pub fn normalized(mut self) -> Self {
        self.style = self.style.normalized();
        self.overlay = self.overlay.normalized();
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn style_normalization_rejects_non_finite_and_extreme_values() {
        let style = MapViewStyle {
            room_spacing: f32::NAN,
            room_border_radius: Some(8.0),
            connection_width: Some(-2.0),
            route_width: f32::INFINITY,
            ..MapViewStyle::default()
        }
        .normalized();
        assert_eq!(style.room_spacing, 1.0);
        assert_eq!(style.room_border_radius, Some(0.25));
        assert_eq!(style.connection_width, Some(0.0));
        assert_eq!(style.route_width, 4.0);
    }

    #[test]
    fn overlay_normalization_clamps_room_strokes() {
        let overlay = MapViewOverlay {
            rooms: vec![RoomOverlay {
                room: 7,
                fill: None,
                stroke: None,
                stroke_width: Some(f32::NAN),
            }],
            ..MapViewOverlay::default()
        }
        .normalized();
        assert_eq!(overlay.rooms[0].stroke_width, Some(2.0));
    }

    #[test]
    fn overlay_keeps_exact_route_exits() {
        let overlay = MapViewOverlay {
            route_exits: vec![RouteExitOverlay {
                room: 12,
                direction: ExitDirection::Up,
            }],
            ..MapViewOverlay::default()
        };

        assert_eq!(overlay.route_exits[0].room, 12);
        assert_eq!(overlay.route_exits[0].direction, ExitDirection::Up);
    }
}
