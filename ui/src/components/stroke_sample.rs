//! A tiny inline canvas rendering one connection-stroke sample — a short
//! horizontal line in a given color, thickness, and dash — so stroke widths
//! and dash styles can be chosen by eye instead of by number.

use iced::widget::canvas::{self, Canvas, LineDash, stroke};
use iced::{Color, Length, Point, Rectangle, mouse};
use smudgy_cloud::ConnectionDash;

pub type Renderer = iced::Renderer;
pub type Theme = smudgy_theme::Theme;

/// Pixel dash patterns matching the map's look at the default zoom: the
/// map's patterns are map-space (`render.rs`), and one map unit is 40 px at
/// the default zoom of 40.
const DASHED_SEGMENTS: &[f32] = &[6.4, 4.0];
const DOTTED_SEGMENTS: &[f32] = &[0.8, 4.0];

/// Horizontal inset so line caps don't clip at the canvas edge.
const INSET: f32 = 4.0;

#[derive(Debug, Clone, Copy)]
pub struct StrokeSample {
    pub color: Color,
    pub thickness: f32,
    pub dash: ConnectionDash,
}

impl StrokeSample {
    /// The sample as a fixed-height element.
    pub fn view<'a, Message: 'a>(
        self,
        width: Length,
        height: f32,
    ) -> iced::Element<'a, Message, Theme, Renderer> {
        Canvas::new(self)
            .width(width)
            .height(Length::Fixed(height))
            .into()
    }
}

impl<Message> canvas::Program<Message, Theme> for StrokeSample {
    type State = ();

    fn draw(
        &self,
        _state: &(),
        renderer: &Renderer,
        _theme: &Theme,
        bounds: Rectangle,
        _cursor: mouse::Cursor,
    ) -> Vec<canvas::Geometry> {
        let mut frame = canvas::Frame::new(renderer, bounds.size());
        let y = bounds.height / 2.0;
        let (segments, cap): (&[f32], stroke::LineCap) = match self.dash {
            ConnectionDash::Dashed => (DASHED_SEGMENTS, stroke::LineCap::Butt),
            ConnectionDash::Dotted => (DOTTED_SEGMENTS, stroke::LineCap::Round),
            ConnectionDash::Solid => (&[], stroke::LineCap::Butt),
        };
        frame.stroke(
            &canvas::Path::line(
                Point::new(INSET, y),
                Point::new(bounds.width.max(INSET * 2.0) - INSET, y),
            ),
            canvas::Stroke {
                style: stroke::Style::Solid(self.color),
                width: self.thickness,
                line_cap: cap,
                line_join: stroke::LineJoin::Round,
                line_dash: LineDash {
                    segments,
                    offset: 0,
                },
            },
        );
        vec![frame.into_geometry()]
    }
}
