// =============================================================================
//  Shared look & feel + tiny formatters for the NukeFire command deck
// =============================================================================

import { createState, createTimer, getSettings } from "smudgy:core";

/**
 * The nukefire.org palette (from the site's CSS custom properties):
 * navy glass panels (`--darker-bg #0a1d35`, `--dark-bg #1d3557`, glass
 * `#141d3db3`), steel-blue borders (`--border-color #457b9d`), amber accent
 * (`--accent-color #fcbf49`), primary red `#e63946`, teal `#2a9d8f`, sandy
 * tertiary `#f4a261`, terminal green `#4caf50`.
 */
export const UI = {
  gold: "#fcbf49",
  header: "#fcbf49",
  dim: "#a9a9a9",
  faint: "#6e7f96",
  timestamp: "#626b78",
  text: "#c9ada7",
  bright: "#f1faee",
  card: "rgba(20, 29, 61, 0.70)",
  cardEdge: "rgba(69, 123, 157, 0.30)",
  navyDeep: "#0a1d35",
  navy: "#1d3557",
  steel: "#457b9d",
  teal: "#2a9d8f",
  hp: "#e63946",
  mana: "#457b9d",
  move: "#2a9d8f",
  devotion: "#fcbf49",
  danger: "#e63946",
  good: "#4caf50",
  warning: "#f4a261",
} as const;

/** Live terminal-theme background for widgets which cover terminal output. */
export const themeBackground = createState<string>("themeBackground");
themeBackground.set(getSettings().palette?.background ?? "transparent");

createTimer({ intervalMs: 1000, repeat: true }, () => {
  const background = getSettings().palette?.background;
  if (background && background !== themeBackground.value) themeBackground.set(background);
});

/** Compact scrollback size shared by Comms, Codex, and secondary sessions. */
export const COMPACT_TERMINAL_FONT_SIZE = 12;

/** Tone → color for NukeFire.Context status lines. */
export function toneColor(tone: string | undefined): string {
  switch (tone) {
    case "good":
      return UI.good;
    case "warning":
      return UI.warning;
    default:
      return UI.text;
  }
}

/** Context block kind → title color (site palette). */
export function kindColor(kind: string): string {
  switch (kind) {
    case "service":
      return UI.gold;
    case "storage":
      return UI.teal;
    case "zone":
      return UI.warning;
    default:
      return UI.text;
  }
}

/** Terrain name → radar cell color (observed BIGMAP terrains + fallback). */
export function terrainColor(terrain: string): string {
  switch (terrain) {
    case "Forest":
      return "#2f7d43";
    case "Water":
      return "#2a6bc0";
    case "Smooth":
      return "#7d8894";
    case "Mountains":
      return "#8a6a55";
    case "Hills":
      return "#a08464";
    default:
      return "#5c5c66";
  }
}

/** Knowledge domain → chip color (site palette). */
export function domainColor(domain: string): string {
  switch (domain) {
    case "help":
      return UI.teal;
    case "item":
      return UI.gold;
    case "command":
      return UI.steel;
    case "skill":
      return UI.good;
    case "zone":
      return UI.warning;
    default:
      return UI.dim;
  }
}

/** Deliberate terminal accents for every NukeFire communication channel. */
const CHANNEL_COLORS: Readonly<Record<string, string>> = {
  all: "#8b98a8",
  gossip: "#55b8aa",
  newbie: "#6fbf87",
  group: "#8ea7d6",
  auction: "#d6a64f",
  auctalk: "#b9975f",
  say: "#78a6c8",
  qsay: "#a28bc1",
  grats: "#77ad70",
  ssf: "#72a889",
  skynet: "#bf78d2",
  shout: "#d28a55",
  holler: "#c96f69",
  tell: "#c784b3",
  whisper: "#9887ad",
  ask: "#6eafb5",
  system: "#929ba7",
};

/** Softer high-contrast tints for message bodies on the navy terminal. */
const CHANNEL_TEXT_COLORS: Readonly<Record<string, string>> = {
  gossip: "#b8d9d4",
  newbie: "#c0d9c6",
  group: "#c5d0e2",
  auction: "#decba8",
  auctalk: "#d4c5aa",
  say: "#bed0dd",
  qsay: "#cec4db",
  grats: "#c2d8be",
  ssf: "#bfd5c8",
  skynet: "#d7bfdf",
  shout: "#dcc5b4",
  holler: "#dcbfbd",
  tell: "#ddc3d5",
  whisper: "#cec7d7",
  ask: "#bed7d9",
  system: "#c5cad0",
};

const CHANNEL_PALETTE = [
  "#f4a261", "#2a9d8f", "#e63946", "#fcbf49", "#4caf50", "#c9ada7", "#457b9d", "#e07ab8",
];

/** Intentional channel accent, with a stable fallback for server additions. */
export function channelColor(chan: string): string {
  const normalized = chan.trim().toLowerCase();
  const configured = CHANNEL_COLORS[normalized];
  if (configured) return configured;

  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) | 0;
  }
  return CHANNEL_PALETTE[Math.abs(hash) % CHANNEL_PALETTE.length];
}

/** Readable body tint for a channel. */
export function channelTextColor(chan: string): string {
  return CHANNEL_TEXT_COLORS[chan.trim().toLowerCase()] ?? UI.text;
}

/** Muted link tint: discoverable, but quieter than the channel accent. */
export function channelLinkColor(chan: string): string {
  return chan.trim().toLowerCase() === "auction" ? "#a99879" : "#82939d";
}

/** Strip terminal/TinTin color escapes from NukeFire Comm.Channel payloads. */
export function stripColors(text: string): string {
  // deno-lint-ignore no-control-regex
  return text
    .replace(/<([FfBb][0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?|[0-9A-Fa-fgG]{3})>/g, "")
    .replace(/(?:\x1b)?\[([FfBb][0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?|[0-9A-Fa-fgG]{3})\]/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** 1234567 → "1,234,567". */
export function fmtNum(n: number | undefined): string {
  return n === undefined ? "?" : n.toLocaleString("en-US");
}

/** Seconds → "4m 14s" / "1h 3m" / "12s". */
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ---- GPS commands -----------------------------------------------------------
// NOTE: the catalog only documents the index as "the GPS target argument";
// verify the exact syntax in game (`help gps`) and adjust here if needed.

export function gpsSet(index: number): string {
  return `gps set ${index}`;
}

export const GPS_CLEAR = "gps clear";
export const GPS_WALK = "path gps walk";
