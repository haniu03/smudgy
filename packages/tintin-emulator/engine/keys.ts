// TinTin #macro key sequences -> smudgy KeySpec key names. TinTin binds raw
// terminal escape sequences; only the recognizable named-key sequences have a
// smudgy equivalent.

const KEY_SEQUENCES = new Map<string, string>([
  ["\x1bOP", "F1"], ["\x1bOQ", "F2"], ["\x1bOR", "F3"], ["\x1bOS", "F4"],
  ["\x1b[11~", "F1"], ["\x1b[12~", "F2"], ["\x1b[13~", "F3"], ["\x1b[14~", "F4"],
  ["\x1b[15~", "F5"], ["\x1b[17~", "F6"], ["\x1b[18~", "F7"], ["\x1b[19~", "F8"],
  ["\x1b[20~", "F9"], ["\x1b[21~", "F10"], ["\x1b[23~", "F11"], ["\x1b[24~", "F12"],
  ["\x1b[A", "ArrowUp"], ["\x1b[B", "ArrowDown"], ["\x1b[C", "ArrowRight"], ["\x1b[D", "ArrowLeft"],
  ["\x1b[H", "Home"], ["\x1b[F", "End"], ["\x1b[2~", "Insert"], ["\x1b[3~", "Delete"],
  ["\x1b[5~", "PageUp"], ["\x1b[6~", "PageDown"],
]);

/** Named keys accepted directly (`{F5}`, `{ArrowUp}`), case-insensitively. */
const KEY_NAMES = new Map<string, string>(
  [...new Set(KEY_SEQUENCES.values())].map((name) => [name.toLowerCase(), name]),
);

/**
 * Resolve a TinTin #macro key argument to a smudgy key name: a recognized
 * terminal escape sequence (`\e[15~`), or a named key for convenience.
 * Returns `null` for sequences with no smudgy equivalent.
 */
export function tinTinKeySpec(value: unknown): { key: string } | null {
  const text = String(value ?? "");
  const sequence = text.replace(/^\^/, "").replaceAll("\\e", "\x1b");
  const fromSequence = KEY_SEQUENCES.get(sequence);
  if (fromSequence) return { key: fromSequence };
  const fromName = KEY_NAMES.get(text.trim().toLowerCase());
  return fromName ? { key: fromName } : null;
}

/** The key names usable in error messages. */
export function supportedKeyNames(): string[] {
  return [...new Set(KEY_SEQUENCES.values())];
}
