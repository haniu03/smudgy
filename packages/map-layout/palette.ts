// Port of smudgy_palette (palette/src/lib.rs), the sequence the map editor
// colors Secrets with. Keep its golden colors in sync.
const POSITIONS = [
  [0, .76, .15], [180, .76, .15], [90, .81, .13], [270, .69, .16], [45, .66, .15],
  [225, .82, .12], [135, .70, .15], [315, .80, .13], [202.5, .62, .16], [337.5, .62, .16],
  [157.5, .86, .16], [22.5, .86, .12], [97.5, .62, .16], [157.5, .62, .16], [52.5, .74, .08],
  [277.5, .86, .16], [292.5, .62, .12], [247.5, .62, .16], [240, .74, .16], [7.5, .68, .16],
  [105, .74, .16], [180, .68, .12], [315, .68, .16], [225, .68, .08], [135, .80, .12],
  [292.5, .74, .08], [82.5, .68, .08], [330, .74, .16], [262.5, .80, .16], [210, .74, .16],
] as const;

/** How many colors the sequence holds before it repeats. */
export const PALETTE_LENGTH = POSITIONS.length;

function linear(lightness: number, chroma: number, hue: number): number[] {
  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians), b = chroma * Math.sin(radians);
  const l = (lightness + .3963377774 * a + .2158037573 * b) ** 3;
  const m = (lightness - .1055613458 * a - .0638541728 * b) ** 3;
  const s = (lightness - .0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
    -.0041960863 * l - .7034186147 * m + 1.707614701 * s,
  ];
}

/** The `index`th color of the sequence seeded by `parts`, as `#rrggbb`. */
export function paletteColor(parts: readonly string[], index: number): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(parts.join("\0"))) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return colorAtHue((hash % 3600) / 10, index);
}

function colorAtHue(seed: number, index: number): string {
  const [offset, lightness, chroma] = POSITIONS[index % POSITIONS.length];
  const hue = (seed + offset) % 360;
  const fits = (channels: number[]) => channels.every((c) => c >= 0 && c <= 1);
  let channels = linear(lightness, chroma, hue);
  if (!fits(channels)) {
    let low = 0, high: number = chroma;
    for (let step = 0; step < 24; step++) {
      const middle = (low + high) / 2;
      if (fits(linear(lightness, middle, hue))) low = middle;
      else high = middle;
    }
    channels = linear(lightness, low, hue);
  }
  return "#" + channels.map((c) => {
    c = Math.max(0, Math.min(1, c));
    const encoded = c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055;
    return Math.round(encoded * 255).toString(16).padStart(2, "0");
  }).join("");
}
