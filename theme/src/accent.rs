//! The app accent: one color and the shades the chrome derives from it.
//!
//! [`Accent::STOCK`] is Smudgy's hand-tuned violet. [`Accent::from_color`]
//! derives the same set of shades from any color, deepening one too bright to
//! carry the chrome's light text, so primary buttons, check marks, badges and
//! selected rows stay readable whatever the user picks.

use iced::Color;

/// The light text the chrome draws over accent fills.
const INK: Color = Color::from_rgb8(255, 250, 239);

/// The least contrast an accent fill keeps against [`INK`] (WCAG AA for body
/// text: button labels and selected rows sit on the fill).
const MIN_FILL_CONTRAST: f32 = 4.5;

/// The least contrast accent-hued text keeps against a light ground.
const MIN_INK_CONTRAST: f32 = 4.5;

/// Every shade the chrome paints with the accent.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Accent {
    /// The accent itself: selections, checked controls, focus rings, and the
    /// start of the primary button and modal title bar gradients.
    pub fill: Color,
    /// Where those gradients end: a slightly lighter, quieter partner.
    pub fill_end: Color,
    pub hover: Color,
    pub hover_end: Color,
    pub pressed: Color,
    pub pressed_end: Color,
    /// The hairline around accent-filled buttons and title bars.
    pub border: Color,
    /// Accent-hued text on a dark ground.
    pub ink_on_dark: Color,
    /// Accent-hued text on a light ground.
    pub ink_on_light: Color,
}

impl Accent {
    /// Smudgy's violet.
    pub const STOCK: Self = Self {
        fill: Color::from_rgb8(55, 23, 130),
        fill_end: Color::from_rgb8(63, 40, 116),
        hover: Color::from_rgb8(60, 28, 135),
        hover_end: Color::from_rgb8(68, 45, 121),
        pressed: Color::from_rgb8(50, 18, 125),
        pressed_end: Color::from_rgb8(63, 40, 116),
        border: Color::from_rgb8(78, 55, 131),
        ink_on_dark: Color::from_rgb(0.686, 0.596, 0.980),
        ink_on_light: Color::from_rgb(0.357, 0.169, 0.788),
    };

    /// Derives every shade from `color`. A color too light to carry the
    /// chrome's text is deepened (same hue, lower value) until it does; the
    /// text tints keep its hue at fixed lightness, then deepen as needed to
    /// read on a light ground.
    #[must_use]
    pub fn from_color(color: Color) -> Self {
        let color = Color { a: 1.0, ..color };
        let fill = deepen(color, INK, MIN_FILL_CONTRAST);
        let fill_end = toward_grey(fill, 14.0 / 255.0);
        let (hue, saturation, _) = to_hsl(color);
        Self {
            fill,
            fill_end,
            hover: shift(fill, 5.0 / 255.0),
            hover_end: shift(fill_end, 5.0 / 255.0),
            pressed: shift(fill, -5.0 / 255.0),
            pressed_end: fill_end,
            border: toward_grey(fill, 68.0 / 255.0),
            ink_on_dark: from_hsl(hue, (saturation * 1.3).min(1.0), 0.79),
            ink_on_light: deepen(
                from_hsl(hue, saturation * 0.92, 0.48),
                Color::WHITE,
                MIN_INK_CONTRAST,
            ),
        }
    }

    /// Accent-hued text for a `background`: the lighter tint on a dark
    /// ground, the deeper one on a light ground.
    #[must_use]
    pub fn ink(&self, background: Color) -> Color {
        // Rec. 601 luma is enough to tell a dark ground from a light one.
        let luma = 0.299 * background.r + 0.587 * background.g + 0.114 * background.b;
        if luma > 0.5 {
            self.ink_on_light
        } else {
            self.ink_on_dark
        }
    }
}

/// WCAG relative luminance.
fn luminance(color: Color) -> f32 {
    let linear = |channel: f32| {
        if channel <= 0.040_45 {
            channel / 12.92
        } else {
            ((channel + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

/// WCAG contrast ratio between two colors, `1.0..=21.0`.
#[must_use]
pub fn contrast(a: Color, b: Color) -> f32 {
    let (a, b) = (luminance(a), luminance(b));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

/// `color` scaled toward black just far enough to reach `min_contrast`
/// against the lighter `against`; unchanged when it already does.
fn deepen(color: Color, against: Color, min_contrast: f32) -> Color {
    let scaled = |k: f32| Color::from_rgb(color.r * k, color.g * k, color.b * k);
    if contrast(color, against) >= min_contrast {
        return color;
    }
    let (mut low, mut high) = (0.0_f32, 1.0_f32);
    for _ in 0..24 {
        let mid = f32::midpoint(low, high);
        if contrast(scaled(mid), against) >= min_contrast {
            low = mid;
        } else {
            high = mid;
        }
    }
    scaled(low)
}

/// Blends 28% of the way toward a grey `lift` above the color's channel
/// mean: a lighter, less saturated shade of the same color.
fn toward_grey(color: Color, lift: f32) -> Color {
    let grey = ((color.r + color.g + color.b) / 3.0 + lift).min(1.0);
    let mix = |channel: f32| (grey - channel).mul_add(0.28, channel);
    Color::from_rgb(mix(color.r), mix(color.g), mix(color.b))
}

/// Moves every channel by `amount`, clamped.
fn shift(color: Color, amount: f32) -> Color {
    let moved = |channel: f32| (channel + amount).clamp(0.0, 1.0);
    Color::from_rgb(moved(color.r), moved(color.g), moved(color.b))
}

/// Hue in degrees, saturation, lightness.
fn to_hsl(color: Color) -> (f32, f32, f32) {
    let max = color.r.max(color.g).max(color.b);
    let min = color.r.min(color.g).min(color.b);
    let delta = max - min;
    let lightness = f32::midpoint(max, min);
    if delta <= f32::EPSILON {
        return (0.0, 0.0, lightness);
    }
    let saturation = delta / (1.0 - (2.0 * lightness - 1.0).abs());
    let hue = if (max - color.r).abs() <= f32::EPSILON {
        60.0 * ((color.g - color.b) / delta).rem_euclid(6.0)
    } else if (max - color.g).abs() <= f32::EPSILON {
        60.0 * ((color.b - color.r) / delta + 2.0)
    } else {
        60.0 * ((color.r - color.g) / delta + 4.0)
    };
    (hue, saturation.clamp(0.0, 1.0), lightness)
}

fn from_hsl(hue: f32, saturation: f32, lightness: f32) -> Color {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let sector = hue.rem_euclid(360.0) / 60.0;
    let second = chroma * (1.0 - (sector.rem_euclid(2.0) - 1.0).abs());
    let (r, g, b) = match sector {
        s if s < 1.0 => (chroma, second, 0.0),
        s if s < 2.0 => (second, chroma, 0.0),
        s if s < 3.0 => (0.0, chroma, second),
        s if s < 4.0 => (0.0, second, chroma),
        s if s < 5.0 => (second, 0.0, chroma),
        _ => (chroma, 0.0, second),
    };
    let base = lightness - chroma / 2.0;
    Color::from_rgb(r + base, g + base, b + base)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(value: &str) -> Color {
        let channel = |at: usize| u8::from_str_radix(&value[at..at + 2], 16).unwrap();
        Color::from_rgb8(channel(1), channel(3), channel(5))
    }

    fn assert_near(actual: Color, expected: Color, tolerance: u8) {
        let [ar, ag, ab, _] = actual.into_rgba8();
        let [er, eg, eb, _] = expected.into_rgba8();
        assert!(
            ar.abs_diff(er) <= tolerance
                && ag.abs_diff(eg) <= tolerance
                && ab.abs_diff(eb) <= tolerance,
            "actual {:?}, expected {:?}",
            [ar, ag, ab],
            [er, eg, eb]
        );
    }

    #[test]
    fn deriving_from_the_stock_violet_reproduces_its_hand_tuned_shades() {
        let derived = Accent::from_color(Accent::STOCK.fill);
        let stock = Accent::STOCK;
        assert_near(derived.fill, stock.fill, 0);
        assert_near(derived.fill_end, stock.fill_end, 1);
        assert_near(derived.hover, stock.hover, 1);
        assert_near(derived.hover_end, stock.hover_end, 1);
        assert_near(derived.pressed, stock.pressed, 1);
        assert_near(derived.pressed_end, stock.pressed_end, 1);
        assert_near(derived.border, stock.border, 1);
        assert_near(derived.ink_on_dark, stock.ink_on_dark, 8);
        assert_near(derived.ink_on_light, stock.ink_on_light, 12);
    }

    #[test]
    fn a_bright_pick_deepens_to_carry_light_text_and_keeps_its_hue() {
        let yellow = Color::from_rgb8(255, 220, 0);
        let fill = Accent::from_color(yellow).fill;
        assert!(contrast(fill, INK) >= MIN_FILL_CONTRAST);
        assert!(contrast(fill, INK) < MIN_FILL_CONTRAST + 0.05);
        let (hue, _, _) = to_hsl(fill);
        let (original, _, _) = to_hsl(yellow);
        assert!((hue - original).abs() < 0.5, "{hue} vs {original}");
    }

    #[test]
    fn text_tints_read_on_both_grounds() {
        for color in [
            Accent::STOCK.fill,
            hex("#086c48"),
            hex("#a0620a"),
            hex("#4a4a4f"),
            Color::from_rgb8(255, 220, 0),
            Color::from_rgb8(0, 0, 0),
        ] {
            let accent = Accent::from_color(color);
            assert!(contrast(accent.ink_on_dark, Color::from_rgb8(15, 15, 14)) >= 7.0);
            assert!(contrast(accent.ink_on_light, Color::WHITE) >= MIN_INK_CONTRAST);
            assert_eq!(accent.ink(Color::WHITE), accent.ink_on_light);
            assert_eq!(accent.ink(Color::BLACK), accent.ink_on_dark);
        }
    }

    #[test]
    fn hsl_round_trips() {
        for color in [
            Color::from_rgb8(55, 23, 130),
            Color::from_rgb8(255, 220, 0),
            Color::from_rgb8(8, 108, 72),
            Color::from_rgb8(74, 74, 79),
        ] {
            let (hue, saturation, lightness) = to_hsl(color);
            assert_near(from_hsl(hue, saturation, lightness), color, 0);
        }
    }
}
