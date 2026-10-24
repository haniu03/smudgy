//! Animated CRT cat, rendered where the no-session empty state used to show a
//! static icon chip.
//!
//! This is an [`iced::widget::shader`] program: a custom wgpu render pipeline
//! that draws a single full-viewport triangle and evaluates the effect per
//! fragment (see `crt_cat.wgsl`). It only paints under the wgpu backend; under
//! the software (tiny-skia) renderer the custom primitive is a no-op and the
//! slot is simply blank.
//!
//! Animation is driven externally: the host advances a [`Clock`] from a
//! `window::frames()` subscription and passes it to [`view`] each frame.
//!
//! On holidays the cat wears a [`Costume`], drawn over it by the same shader.

use std::time::Duration;

use chrono::{Datelike, Local, NaiveDate};
use iced::widget::shader;
use iced::{Length, Rectangle, mouse, time::Instant, wgpu};

use smudgy_theme::Element as ThemedElement;

/// The compiled effect: the cat, then each costume's module. Embedded so it
/// ships in the binary.
const SHADER_SRC: &str = concat!(
    include_str!("crt_cat.wgsl"),
    include_str!("crt_cat/witch_hat.wgsl"),
);

/// Source artwork dimensions, in pixels.
const GRID_W: f32 = 15.0;
const GRID_H: f32 = 12.0;
/// Logical points per source pixel (the shader's 8x enlargement).
const SOURCE_PIXEL_PTS: f32 = 8.0;
/// Breathing room per side. The whisker tips' analog bleed needs about one
/// source pixel of it to avoid clipping; the rest is deliberate whitespace —
/// the near-black silhouette reads against the dark UI only when isolated
/// from the surrounding text.
const MARGIN_PTS: f32 = 2.0 * SOURCE_PIXEL_PTS;

/// Widget width, in logical points: the enlarged sprite plus margins.
const WIDTH: f32 = GRID_W * SOURCE_PIXEL_PTS + 2.0 * MARGIN_PTS;

/// Something the cat wears for a holiday. Each costume's art and effects live
/// in its own WGSL module under `crt_cat/`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Costume {
    #[default]
    None,
    /// Halloween's crooked witch hat.
    WitchHat,
}

impl Costume {
    /// The costume for the current local date.
    pub fn today() -> Self {
        Self::on(Local::now().date_naive())
    }

    /// The costume for `date`: the witch hat within two days either side of
    /// Halloween (October 29 through November 2), otherwise none.
    fn on(date: NaiveDate) -> Self {
        match (date.month(), date.day()) {
            (10, 29..=31) | (11, 1..=2) => Self::WitchHat,
            _ => Self::None,
        }
    }

    /// Shader selector; must match the `COSTUME_*` constants in the WGSL.
    fn selector(self) -> u32 {
        match self {
            Self::None => 0,
            Self::WitchHat => 1,
        }
    }

    /// Source rows the costume rises above the cat's head; must match the
    /// WGSL's `costume_rows_above`.
    fn rows_above(self) -> f32 {
        match self {
            Self::None => 0.0,
            Self::WitchHat => 7.0,
        }
    }

    /// Widget height, in logical points: the enlarged sprite, any costume
    /// above it, and margins.
    fn height(self) -> f32 {
        (GRID_H + self.rows_above()) * SOURCE_PIXEL_PTS + 2.0 * MARGIN_PTS
    }
}

/// The cat's animation clock: seconds since the empty state last became
/// visible. The driving `window::frames()` subscription only runs while the
/// empty state shows, so a gap between ticks means the state went away and
/// came back — the clock restarts so the opening pose (quiet eyes, no lick)
/// replays instead of resuming mid-cycle. The costume is chosen at the same
/// moment, so the cat never changes outfits mid-animation.
#[derive(Debug)]
pub struct Clock {
    start: Instant,
    last_tick: Option<Instant>,
    seconds: f32,
    costume: Costume,
}

impl Default for Clock {
    fn default() -> Self {
        Self {
            start: Instant::now(),
            last_tick: None,
            seconds: 0.0,
            costume: Costume::today(),
        }
    }
}

impl Clock {
    /// Two frames at even a lazy compositor rate arrive well under this; a
    /// longer silence can only mean the subscription was gated off.
    const RESTART_GAP: Duration = Duration::from_millis(500);

    pub fn tick(&mut self, now: Instant) {
        if self
            .last_tick
            .is_none_or(|last| now.duration_since(last) > Self::RESTART_GAP)
        {
            self.start = now;
            self.costume = Costume::today();
        }
        self.last_tick = Some(now);
        self.seconds = now.duration_since(self.start).as_secs_f32();
    }

    pub fn seconds(&self) -> f32 {
        self.seconds
    }

    pub fn costume(&self) -> Costume {
        self.costume
    }
}

/// GPU-side uniform block. Field order/size must match `struct Uniforms` in the
/// WGSL (32 bytes, no implicit padding).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    resolution: [f32; 2],
    time: f32,
    scale: f32,
    origin: [f32; 2],
    linearize: f32,
    costume: u32,
}

/// Shared GPU state for the cat. iced creates one instance lazily per
/// `wgpu::Device` (keyed on the [`Primitive`] type) and caches it in its
/// primitive `Storage`, so the pipeline and uniform buffer are built once.
#[derive(Debug)]
pub struct Pipeline {
    pipeline: wgpu::RenderPipeline,
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    /// 1.0 when the surface is an sRGB format (see WGSL `linearize`).
    linearize: f32,
}

impl shader::Pipeline for Pipeline {
    fn new(device: &wgpu::Device, _queue: &wgpu::Queue, format: wgpu::TextureFormat) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("crt cat shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER_SRC.into()),
        });

        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("crt cat uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("crt cat bind group layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("crt cat bind group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms.as_entire_binding(),
            }],
        });

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("crt cat pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("crt cat pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    // The cat floats over the UI: the shader emits premultiplied
                    // colour, and everything outside the sprite (and its halo)
                    // stays fully transparent.
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self {
            pipeline,
            uniforms,
            bind_group,
            linearize: f32::from(u8::from(format.is_srgb())),
        }
    }
}

/// A single frame of the cat. Carries only the animation clock and costume;
/// the geometry (resolution/origin/scale) is derived from the widget bounds in
/// [`prepare`].
///
/// [`prepare`]: shader::Primitive::prepare
#[derive(Debug)]
pub struct Primitive {
    time: f32,
    costume: Costume,
}

impl shader::Primitive for Primitive {
    type Pipeline = Pipeline;

    fn prepare(
        &self,
        pipeline: &mut Self::Pipeline,
        _device: &wgpu::Device,
        queue: &wgpu::Queue,
        bounds: &Rectangle,
        viewport: &shader::Viewport,
    ) {
        // The shader works in physical pixels throughout (its shadow mask is
        // per physical pixel), so bounds are converted here rather than in it.
        let scale = viewport.scale_factor();
        let uniforms = Uniforms {
            resolution: [bounds.width * scale, bounds.height * scale],
            time: self.time,
            scale,
            origin: [bounds.x * scale, bounds.y * scale],
            linearize: pipeline.linearize,
            costume: self.costume.selector(),
        };
        queue.write_buffer(&pipeline.uniforms, 0, bytemuck::bytes_of(&uniforms));
    }

    fn draw(&self, pipeline: &Self::Pipeline, render_pass: &mut wgpu::RenderPass<'_>) -> bool {
        // iced has already set the render pass viewport to our (physical) bounds
        // and the scissor to the clipped rect, so a full-viewport triangle fills
        // exactly this widget.
        render_pass.set_pipeline(&pipeline.pipeline);
        render_pass.set_bind_group(0, &pipeline.bind_group, &[]);
        render_pass.draw(0..3, 0..1);
        true
    }
}

/// The `shader::Program` placed into the widget tree for one frame.
#[derive(Debug)]
struct CrtCat {
    time: f32,
    costume: Costume,
}

impl<Message> shader::Program<Message> for CrtCat {
    type State = ();
    type Primitive = Primitive;

    fn draw(
        &self,
        _state: &Self::State,
        _cursor: mouse::Cursor,
        _bounds: Rectangle,
    ) -> Self::Primitive {
        Primitive {
            time: self.time,
            costume: self.costume,
        }
    }
}

/// A fixed-size cat element at the [`Clock`]'s moment, wearing its costume.
pub fn view<'a, Message: 'a>(clock: &Clock) -> ThemedElement<'a, Message> {
    let costume = clock.costume();
    shader::Shader::new(CrtCat {
        time: clock.seconds(),
        costume,
    })
    .width(Length::Fixed(WIDTH))
    .height(Length::Fixed(costume.height()))
    .into()
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDate;

    use super::{Costume, SHADER_SRC};

    fn costume_on(month: u32, day: u32) -> Costume {
        Costume::on(NaiveDate::from_ymd_opt(2026, month, day).unwrap())
    }

    #[test]
    fn witch_hat_is_worn_two_days_either_side_of_halloween() {
        assert_eq!(costume_on(10, 28), Costume::None);
        for (month, day) in [(10, 29), (10, 30), (10, 31), (11, 1), (11, 2)] {
            assert_eq!(costume_on(month, day), Costume::WitchHat, "{month}/{day}");
        }
        assert_eq!(costume_on(11, 3), Costume::None);
        assert_eq!(costume_on(7, 4), Costume::None);
    }

    #[test]
    fn shader_validates() {
        let module = naga::front::wgsl::parse_str(SHADER_SRC)
            .unwrap_or_else(|error| panic!("{}", error.emit_to_string(SHADER_SRC)));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .unwrap_or_else(|error| panic!("{}", error.emit_to_string(SHADER_SRC)));
    }
}
