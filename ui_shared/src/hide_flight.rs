//! The hide and show animation: a pane's ghost flying between its place in
//! the grid and the Layout menu.
//!
//! Animating the pane itself would re-lay out the grid — and re-wrap every
//! terminal in it — on every frame. Instead the pane leaves (or rejoins) the
//! grid in one rebuild, and a ghost of it flies on an inert layer above the
//! window: each frame of the flight only redraws that layer, with no view
//! rebuild and no layout pass.
//!
//! Only the user's own hides and shows fly. A script hiding or showing a
//! pane (or creating one hidden) changes the grid and the menu with no
//! ghost: a pane that reveals itself on every event must not keep throwing
//! animations across the window.

use std::time::Duration;

use iced::advanced::layout::{self, Layout};
use iced::advanced::renderer::{self, Quad};
use iced::advanced::text;
use iced::advanced::widget::{Tree, Widget, tree};
use iced::advanced::{Clipboard, Shell};
use iced::alignment::Vertical;
use iced::time::Instant;
use iced::{Border, Element, Event, Length, Pixels, Point, Rectangle, Size, mouse, window};
use smudgy_theme::Theme;

use crate::assets::GEIST;

/// How long one flight takes.
pub const DURATION: Duration = Duration::from_millis(220);

/// A ghost too small to read its label carries none.
const LABEL_MIN: Size = Size::new(72.0, 26.0);

/// One ghost in flight, in window-local logical coordinates.
#[derive(Debug, Clone)]
struct Flight {
    from: Rectangle,
    to: Rectangle,
    label: String,
    started: Instant,
}

impl Flight {
    /// The flight's eased progress at `now`; `None` once it has landed.
    fn progress(&self, now: Instant) -> Option<f32> {
        let elapsed = now.saturating_duration_since(self.started);
        (elapsed < DURATION).then(|| {
            let t = elapsed.as_secs_f32() / DURATION.as_secs_f32();
            // Ease in and out (cubic): leaves gently, lands gently.
            if t < 0.5 {
                4.0 * t * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
            }
        })
    }
}

/// The window's ghosts in flight.
#[derive(Debug, Default)]
pub struct Flights(Vec<Flight>);

impl Flights {
    /// Launch a ghost labelled `label` from `from` to `to`, starting now.
    /// Landed flights retire here; until then they cost nothing (they are
    /// not drawn and request no frames).
    pub fn launch(&mut self, from: Rectangle, to: Rectangle, label: String) {
        let now = Instant::now();
        self.0.retain(|flight| flight.progress(now).is_some());
        // A zero-area end (geometry not yet measured) would fly from or to
        // nowhere: skip the ghost rather than draw a streak.
        if from.width > 0.0 && from.height > 0.0 && to.width > 0.0 && to.height > 0.0 {
            self.0.push(Flight {
                from,
                to,
                label,
                started: now,
            });
        }
    }

    /// How many ghosts were launched and have not yet retired (a landed
    /// ghost retires at the next launch).
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The inert layer drawing the ghosts: stack it, always mounted, above
    /// everything the ghosts cross.
    pub fn layer<'a, Message: 'a>(&'a self) -> Element<'a, Message, Theme> {
        Element::new(Layer { flights: &self.0 })
    }
}

/// The layer's clock: the time of the frame being drawn.
#[derive(Default)]
struct Clock(Option<Instant>);

struct Layer<'a> {
    flights: &'a [Flight],
}

impl<Message, Renderer> Widget<Message, Theme, Renderer> for Layer<'_>
where
    Renderer: text::Renderer<Font = iced::Font>,
{
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<Clock>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(Clock::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fill)
    }

    fn layout(
        &mut self,
        _tree: &mut Tree,
        _renderer: &Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        layout::Node::new(limits.max())
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        _layout: Layout<'_>,
        _cursor: mouse::Cursor,
        _renderer: &Renderer,
        _clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        _viewport: &Rectangle,
    ) {
        // Inert to input: nothing is captured, so every event reaches the
        // window beneath. Only frames matter, and a frame is requested only
        // while a ghost is in the air.
        if let Event::Window(window::Event::RedrawRequested(now)) = event {
            tree.state.downcast_mut::<Clock>().0 = Some(*now);
            if self
                .flights
                .iter()
                .any(|flight| flight.progress(*now).is_some())
            {
                shell.request_redraw();
            }
        }
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        _style: &renderer::Style,
        _layout: Layout<'_>,
        _cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        let now = tree.state.downcast_ref::<Clock>().0;
        for flight in self.flights {
            // Before the layer's first frame, a fresh ghost sits at its start.
            let Some(t) = flight.progress(now.unwrap_or(flight.started)) else {
                continue;
            };
            let bounds = lerp(flight.from, flight.to, t);
            let fade = 1.0 - 0.6 * t;
            renderer.fill_quad(
                Quad {
                    bounds,
                    border: Border {
                        color: theme.styles.general.accent.scale_alpha(fade),
                        width: 1.5,
                        radius: 6.0.into(),
                    },
                    ..Quad::default()
                },
                theme.styles.general.background.scale_alpha(0.85 * fade),
            );
            if bounds.width >= LABEL_MIN.width && bounds.height >= LABEL_MIN.height {
                renderer.fill_text(
                    text::Text {
                        content: flight.label.clone(),
                        bounds: Size::new(bounds.width - 16.0, bounds.height),
                        size: Pixels(13.0),
                        line_height: text::LineHeight::default(),
                        font: GEIST,
                        align_x: text::Alignment::Left,
                        align_y: Vertical::Top,
                        shaping: text::Shaping::Advanced,
                        wrapping: text::Wrapping::None,
                    },
                    Point::new(bounds.x + 8.0, bounds.y + 6.0),
                    theme.styles.text.normal.scale_alpha(fade),
                    bounds.intersection(viewport).unwrap_or(bounds),
                );
            }
        }
    }
}

fn lerp(from: Rectangle, to: Rectangle, t: f32) -> Rectangle {
    let mix = |a: f32, b: f32| a + (b - a) * t;
    Rectangle {
        x: mix(from.x, to.x),
        y: mix(from.y, to.y),
        width: mix(from.width, to.width),
        height: mix(from.height, to.height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flight(started: Instant) -> Flight {
        Flight {
            from: Rectangle::new(Point::ORIGIN, Size::new(400.0, 300.0)),
            to: Rectangle::new(Point::new(100.0, 5.0), Size::new(60.0, 24.0)),
            label: "chat".into(),
            started,
        }
    }

    #[test]
    fn a_flight_eases_from_its_start_to_its_end_and_then_lands() {
        let start = Instant::now();
        let flight = flight(start);
        assert_eq!(flight.progress(start), Some(0.0));
        let half = flight.progress(start + DURATION / 2).unwrap();
        assert!((half - 0.5).abs() < 1e-3, "symmetric easing: {half}");
        assert!(flight.progress(start + DURATION).is_none(), "landed");
        let mid = lerp(flight.from, flight.to, 0.5);
        assert_eq!(
            mid,
            Rectangle::new(Point::new(50.0, 2.5), Size::new(230.0, 162.0))
        );
    }

    #[test]
    fn landed_flights_retire_and_unmeasured_ends_never_launch() {
        let mut flights = Flights::default();
        flights.0.push(flight(Instant::now() - DURATION * 2));
        flights.launch(
            Rectangle::new(Point::ORIGIN, Size::new(400.0, 300.0)),
            Rectangle::new(Point::ORIGIN, Size::ZERO),
            "map".into(),
        );
        assert!(
            flights.0.is_empty(),
            "the landed ghost retired; the unmeasured one never flew"
        );
    }
}
