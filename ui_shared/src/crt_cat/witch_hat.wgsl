// Witch hat: the CRT cat's Halloween costume (see `crt_cat.wgsl`).
//
// Coordinates are the cat's source pixels, (0, 0) at its top-left, so the
// crown rises into negative rows and the brim (rows 0-3) covers the ears.

const WITCH_HAT_TOP: i32 = -7;
const WITCH_HAT_ROWS: i32 = 11;

// Rows -7..3, one i32 of column bits per row (bit 0 = leftmost), as in the cat.
var<private> HAT_OUTLINE: array<i32, 11> = array<i32, 11>(
    0x0300, 0x0C80, 0x0840, 0x1420,
    0x1B18, 0x0208, 0x0C0C, 0x114B,
    0x2631, 0x31C2, 0x1C0E
);

var<private> HAT_FELT: array<i32, 11> = array<i32, 11>(
    0x0000, 0x0200, 0x0600, 0x0B00,
    0x00C0, 0x01E0, 0x03E0, 0x0880,
    0x0808, 0x0630, 0x01C0
);

var<private> HAT_FELT_SHADE: array<i32, 11> = array<i32, 11>(
    0x0000, 0x0100, 0x0180, 0x00C0,
    0x0020, 0x0010, 0x0010, 0x0004,
    0x1006, 0x080C, 0x0230
);

var<private> HAT_BAND: array<i32, 11> = array<i32, 11>(
    0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0630,
    0x01C0, 0x0000, 0x0000
);

const HAT_NONE: i32 = 0;
const HAT_OUTLINE_INK: i32 = 1;
const HAT_FELT_INK: i32 = 2;
const HAT_FELT_SHADE_INK: i32 = 3;
const HAT_BAND_INK: i32 = 4;

fn hat_ink(p: vec2<i32>) -> i32 {
    let row = p.y - WITCH_HAT_TOP;
    if (p.x < 0 || p.x >= 15 || row < 0 || row >= WITCH_HAT_ROWS) {
        return HAT_NONE;
    }
    let mask: i32 = 1 << u32(p.x);
    if ((HAT_OUTLINE[row] & mask) != 0) { return HAT_OUTLINE_INK; }
    if ((HAT_FELT[row] & mask) != 0) { return HAT_FELT_INK; }
    if ((HAT_FELT_SHADE[row] & mask) != 0) { return HAT_FELT_SHADE_INK; }
    if ((HAT_BAND[row] & mask) != 0) { return HAT_BAND_INK; }
    return HAT_NONE;
}

// A glint runs along the gold band every 13 seconds. Gold is the only hat
// colour bright enough to cross the beam-bloom threshold, so the sweep flares.
fn band_glint(x: i32, t: f32) -> f32 {
    if (t < 5.0) { return 0.0; }
    // The highlight's centre, in source pixels, sweeping left to right.
    let head = 3.0 + gmod(t - 5.0, 13.0) * 10.0;
    let d = (f32(x) + 0.5 - head) / 0.9;
    return exp(-d * d);
}

// Witch-light: every 9 seconds a wisp rises from one brim tip, then the
// other, stepping one source pixel per frame of its climb. A pixel it leaves
// decays like the tongue's, on a longer afterglow, so the wisp trails a tail.
const WISP_STEP: f32 = 0.22;
const WISP_STEPS: i32 = 7;
const WISP_TAU: f32 = 0.3;

fn wisp(p: vec2<i32>, t: f32) -> f32 {
    if (t < 10.0) { return 0.0; }
    let n = floor((t - 10.0) / 9.0);
    let wt = t - 10.0 - n * 9.0;

    // Starts beside a brim tip; `dir` points away from the crown.
    var start = vec2<i32>(13, 0);
    var dir = 1;
    if (gmod(n, 2.0) < 1.0) {
        start = vec2<i32>(1, -1);
        dir = -1;
    }
    let k = start.y - p.y;
    if (k < 0 || k >= WISP_STEPS) { return 0.0; }

    // A candle-smoke sway that differs per wisp, between the starting column
    // and the one outside it: clear of the hat, and far enough inside the
    // widget that its bleed is never clipped.
    let seed = fract(sin(n * 12.9898) * 43758.5453) * 6.2832;
    let sway = i32(round(0.8 * sin(f32(k) * 1.3 + seed)));
    let offset = clamp(k / 4 + sway, 0, 1);
    if (p.x != start.x + dir * offset) { return 0.0; }

    let on = f32(k) * WISP_STEP;
    let off = on + WISP_STEP;
    if (wt < on) { return 0.0; }
    // Thins as it climbs.
    let fade = 1.0 - f32(k) / f32(WISP_STEPS);
    if (wt < off) { return fade; }
    return fade * exp(-(wt - off) / WISP_TAU);
}

fn witch_hat(p: vec2<i32>, t: f32) -> vec4<f32> {
    let ink = hat_ink(p);
    if (ink == HAT_OUTLINE_INK) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    if (ink == HAT_FELT_INK) {
        return vec4<f32>(vec3<f32>(65.0, 19.0, 108.0) / 255.0, 1.0);
    }
    if (ink == HAT_FELT_SHADE_INK) {
        return vec4<f32>(vec3<f32>(63.0, 12.0, 111.0) / 255.0, 1.0);
    }
    if (ink == HAT_BAND_INK) {
        let gold = vec3<f32>(170.0, 159.0, 42.0) / 255.0;
        let glint = vec3<f32>(255.0, 246.0, 200.0) / 255.0;
        return vec4<f32>(mix(gold, glint, band_glint(p.x, t)), 1.0);
    }
    return vec4<f32>(vec3<f32>(96.0, 255.0, 128.0) / 255.0, wisp(p, t));
}

// An integer hash of a lattice point (PCG output mix). The smoke scrolls
// through the noise for as long as the empty state shows, and a float hash
// would turn blocky once the coordinates outgrow its precision.
fn smoke_hash(i: vec2<f32>) -> f32 {
    let c = bitcast<vec2<u32>>(vec2<i32>(i));
    var h = (c.x * 1597334677u) ^ (c.y * 3812015801u);
    h = h * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    h = (h >> 22u) ^ h;
    return f32(h) / 4294967295.0;
}

fn smoke_gradient(i: vec2<f32>) -> vec2<f32> {
    let a = smoke_hash(i) * 6.2832;
    return vec2<f32>(cos(a), sin(a));
}

// Gradient noise, remapped to about [0, 1]. (Thresholded value noise shows
// its lattice as ridges; gradient noise does not.)
fn smoke_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = dot(smoke_gradient(i), f);
    let b = dot(smoke_gradient(i + vec2<f32>(1.0, 0.0)), f - vec2<f32>(1.0, 0.0));
    let c = dot(smoke_gradient(i + vec2<f32>(0.0, 1.0)), f - vec2<f32>(0.0, 1.0));
    let d = dot(smoke_gradient(i + vec2<f32>(1.0, 1.0)), f - vec2<f32>(1.0, 1.0));
    return 0.5 + 0.7 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn smoke_fbm(p: vec2<f32>) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var q = p;
    for (var i = 0; i < 3; i++) {
        sum += amp * smoke_noise(q);
        q = q * 2.03 + vec2<f32>(17.1, 9.2);
        amp *= 0.5;
    }
    return sum;
}

// Distance from `gp` to the hat, in source pixels, stretched so smoke reaches
// well above the hat but barely below the brim. Exact up to SMOKE_REACH: the
// search window holds every hat pixel nearer than that.
const SMOKE_REACH: f32 = 3.0;

fn smoke_reach(gp: vec2<f32>) -> f32 {
    let cell = vec2<i32>(floor(gp));
    var d = 9.0;
    for (var dy = -2; dy <= 6; dy++) {
        for (var dx = -3; dx <= 3; dx++) {
            let q = cell + vec2<i32>(dx, dy);
            if (hat_ink(q) != HAT_NONE) {
                let rel = gp - vec2<f32>(q) - vec2<f32>(0.5);
                var e = max(abs(rel) - vec2<f32>(0.5), vec2<f32>(0.0));
                e.y *= select(2.5, 0.5, rel.y < 0.0);
                d = min(d, length(e));
            }
        }
    }
    return d;
}

// One layer of billows rising off the hat: density in [0, 1]. Each layer
// scrolls upward through its own region of the noise, curled by a slower,
// single-octave warp — gentle enough that it never folds the field into
// hard creases.
fn smoke_layer(gp: vec2<f32>, t: f32, speed: f32, seed: vec2<f32>) -> f32 {
    let rise = vec2<f32>(0.0, t * speed);
    let warp = vec2<f32>(
        smoke_noise(gp * 0.3 + seed + rise * 0.5),
        smoke_noise(gp * 0.3 + seed + vec2<f32>(5.2, 1.3) + rise * 0.5),
    ) - vec2<f32>(0.5);
    return smoothstep(0.3, 0.75, smoke_fbm(gp * 0.45 + seed + warp * 0.8 + rise));
}

// The smoke's overall opacity, and the black's density relative to the violet.
const SMOKE_OPACITY: f32 = 0.15;
const SMOKE_BLACK_DENSITY: f32 = 1.8;

// Smoke pouring off the hat: violet billows glowing behind pure black ones.
// The black only covers, so against the dark UI it reads where it crosses
// the violet; rising a touch faster, it slides past for a sense of depth.
fn witch_hat_smoke(gp: vec2<f32>, t: f32) -> vec4<f32> {
    let reach = smoke_reach(gp);
    // Eased in so the opening pose stays restful, and gone before the reach
    // stops being exact.
    let envelope = exp(-0.5 * reach * reach)
        * (1.0 - smoothstep(SMOKE_REACH - 0.5, SMOKE_REACH, reach))
        * smoothstep(0.0, 3.0, t);
    if (envelope < 0.002) { return vec4<f32>(0.0); }

    // About a source pixel a second (the noise is sampled at 0.45x).
    let violet = envelope * smoke_layer(gp, t, 0.45, vec2<f32>(0.0)) * SMOKE_OPACITY;
    let black = envelope * smoke_layer(gp, t, 0.6, vec2<f32>(31.0, 17.0))
        * SMOKE_BLACK_DENSITY * SMOKE_OPACITY;

    let glow = vec3<f32>(150.0, 70.0, 255.0) / 255.0 * violet * 0.8;
    let coverage = 1.0 - (1.0 - violet * 0.45) * (1.0 - black);
    return vec4<f32>(glow * (1.0 - black), coverage);
}
