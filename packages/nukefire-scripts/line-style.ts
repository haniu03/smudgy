/** A structural subset of Smudgy's StyleSpan, kept runtime-independent for tests. */
export interface CapturedStyleSpan {
  begin: number;
  end: number;
  fg?: unknown;
  bg?: unknown;
  attributes?: unknown;
  foregroundPaletteBright?: boolean;
}

export interface CapturedStyle {
  fg?: unknown;
  bg?: unknown;
  attributes?: unknown;
  foregroundPaletteBright?: boolean;
}

export interface CapturedLineFragment {
  text: string;
  style: CapturedStyle | null;
}

/**
 * Split terminal text using Smudgy's byte-offset style spans. JavaScript
 * slices use UTF-16 indices, so build the conversion once and preserve
 * multibyte player names and symbols without shifting later styles.
 */
export function fragmentsFromStyleSpans(
  text: string,
  spans: readonly CapturedStyleSpan[],
): CapturedLineFragment[] {
  const boundaries = new Map<number, number>([[0, 0]]);
  const encoder = new TextEncoder();
  let byteOffset = 0;
  let stringIndex = 0;

  for (const character of text) {
    byteOffset += encoder.encode(character).length;
    stringIndex += character.length;
    boundaries.set(byteOffset, stringIndex);
  }

  const at = (offset: number): number => boundaries.get(offset) ?? text.length;
  const ordered = [...spans]
    .filter((span) => span.end > span.begin)
    .sort((left, right) => left.begin - right.begin);
  const fragments: CapturedLineFragment[] = [];
  let cursor = 0;

  for (const span of ordered) {
    const begin = Math.max(cursor, span.begin);
    const end = Math.max(begin, span.end);
    if (begin > cursor) {
      fragments.push({ text: text.slice(at(cursor), at(begin)), style: null });
    }
    if (end > begin) {
      fragments.push({
        text: text.slice(at(begin), at(end)),
        style: {
          ...(span.fg === undefined ? {} : { fg: span.fg }),
          ...(span.bg === undefined ? {} : { bg: span.bg }),
          ...(span.attributes === undefined ? {} : { attributes: span.attributes }),
          ...(span.foregroundPaletteBright === undefined
            ? {}
            : { foregroundPaletteBright: span.foregroundPaletteBright }),
        },
      });
    }
    cursor = Math.max(cursor, end);
  }

  if (cursor < byteOffset) {
    fragments.push({ text: text.slice(at(cursor)), style: null });
  }
  if (fragments.length === 0 && text !== "") {
    fragments.push({ text, style: null });
  }
  return fragments;
}
