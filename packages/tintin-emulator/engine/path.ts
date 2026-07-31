// TinTin++ path semantics: the pathdir table (a movement command and its
// reverse, used for backtracking) and speedwalk zip/unzip. TinTin's defaults
// pair the compass and vertical directions; #pathdir extends the table.

export interface PathDir {
  dir: string;
  reverse: string;
}

export interface PathStep {
  dir: string;
  reverse: string;
  /** Per-step delay saved by TinTin's `#path save both` form. */
  delay?: number;
}

/** TinTin's default pathdir pairs, both directions of each. */
export function defaultPathDirs(): Record<string, PathDir> {
  const table: Record<string, PathDir> = {};
  const pair = (a: string, b: string) => {
    table[a] = { dir: a, reverse: b };
    table[b] = { dir: b, reverse: a };
  };
  pair("n", "s");
  pair("e", "w");
  pair("u", "d");
  pair("ne", "sw");
  pair("nw", "se");
  return table;
}

/** Table lookup that never walks the prototype chain (`toString` is a
 *  perfectly bad direction name). */
export function lookupDir(pathdirs: Record<string, PathDir>, name: string): PathDir | null {
  return Object.hasOwn(pathdirs, name) ? pathdirs[name] : null;
}

/**
 * Expand a manually entered TinTin v1 speedwalk. Input-line speedwalks only
 * recognize the six one-letter cardinal/vertical directions, even though the
 * v2 format used by #path unzip also understands multi-letter #pathdirs.
 *
 * TinTin accepts at most three digits before each direction. Returning `null`
 * means the line is ordinary MUD input rather than a speedwalk.
 */
export function expandLegacySpeedwalk(input: string): string[] | null {
  const text = String(input ?? "");
  if (!/^(?:\d{0,3}[neswud])+$/.test(text)) return null;

  const steps: string[] = [];
  for (const match of text.matchAll(/(\d*)([neswud])/g)) {
    const count = match[1] ? Number(match[1]) : 1;
    for (let index = 0; index < count; index++) steps.push(match[2]);
  }
  return steps;
}

/**
 * Compress steps into a speedwalk: consecutive repeats of a single-letter
 * direction gain a count prefix, everything joins with `;` (`3n;e;sw;sw`).
 * Multi-letter and digit-bearing directions are never count-prefixed, same
 * as TinTin's zip, so the output stays unambiguous to re-read.
 */
export function zipPath(steps: PathStep[]): string {
  const groups: string[] = [];
  let index = 0;
  while (index < steps.length) {
    const dir = steps[index].dir;
    let count = 1;
    while (index + count < steps.length && steps[index + count].dir === dir) count += 1;
    if (count > 1 && dir.length === 1 && !/\d/.test(dir)) {
      groups.push(`${count}${dir}`);
    } else {
      for (let n = 0; n < count; n++) groups.push(dir);
    }
    index += count;
  }
  return groups.join(";");
}

/**
 * Expand a speedwalk into steps against a pathdir table. Both `;` and
 * whitespace separate groups (TinTin treats them alike); a group is a known
 * direction, a counted direction (`3n`, `2sw`), or a compact single-letter
 * run (`3n2e`). Anything else becomes a literal step, since TinTin inserts
 * unknown names verbatim (that is how `open;2n` routes work); such names are
 * returned in `literals` so the caller can mention them.
 */
export function unzipPath(
  speedwalk: string,
  pathdirs: Record<string, PathDir>,
): { steps: PathStep[]; literals: string[] } {
  const steps: PathStep[] = [];
  const literals: string[] = [];
  const push = (name: string, count: number) => {
    const known = lookupDir(pathdirs, name);
    if (!known) literals.push(name);
    for (let n = 0; n < count; n++) {
      steps.push(known ? { dir: known.dir, reverse: known.reverse } : { dir: name, reverse: name });
    }
  };

  for (const group of String(speedwalk ?? "").split(/[;\s]+/).map((part) => part.trim()).filter(Boolean)) {
    // A whole known name wins first, so digit-leading directions (`3rd`)
    // stay themselves.
    if (lookupDir(pathdirs, group)) {
      push(group, 1);
      continue;
    }
    const counted = /^(\d+)(.+)$/.exec(group);
    if (counted && lookupDir(pathdirs, counted[2])) {
      push(counted[2], Number(counted[1]));
      continue;
    }
    // Compact run: digits followed by the longest known direction name,
    // repeated (`3n2e`, `2sw2ne`).
    const pending: Array<[string, number]> = [];
    let index = 0;
    let compactOk = group.length > 0;
    while (index < group.length) {
      let digits = "";
      while (/\d/.test(group[index] ?? "")) digits += group[index++];
      let matched = "";
      for (let length = group.length - index; length >= 1; length--) {
        const candidate = group.slice(index, index + length);
        if (lookupDir(pathdirs, candidate)) {
          matched = candidate;
          break;
        }
      }
      if (!matched) {
        compactOk = false;
        break;
      }
      pending.push([matched, digits ? Number(digits) : 1]);
      index += matched.length;
    }
    if (compactOk && pending.length) {
      for (const [name, count] of pending) push(name, count);
    } else {
      push(group, 1);
    }
  }
  return { steps, literals };
}
