// TinTin++ #format specifiers and the strftime subset %t consumes. Verified
// against the tt2smudgy mapping: %s (with -/width/.precision), %d, %p (trim),
// %t (strftime of now), %% literal. Unknown specifiers stay literal with a
// warning and consume no argument.
//
// Pure module; node runs it directly for tests.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The strftime subset TinTin scripts commonly use; unknown codes stay literal. */
export function tinTinStrftime(format: string, now: Date, warn?: (message: string) => void): string {
  return format.replace(/%(.)/g, (whole, code: string) => {
    switch (code) {
      case "a": return WEEKDAYS[now.getDay()].slice(0, 3);
      case "A": return WEEKDAYS[now.getDay()];
      case "b": return MONTHS[now.getMonth()].slice(0, 3);
      case "B": return MONTHS[now.getMonth()];
      case "d": return pad2(now.getDate());
      case "e": return String(now.getDate()).padStart(2, " ");
      case "H": return pad2(now.getHours());
      case "I": return pad2(((now.getHours() + 11) % 12) + 1);
      case "j": {
        // Count calendar days in UTC so a DST-shortened day doesn't lose one.
        const day = (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
          Date.UTC(now.getFullYear(), 0, 0)) / 86400000;
        return String(day).padStart(3, "0");
      }
      case "m": return pad2(now.getMonth() + 1);
      case "M": return pad2(now.getMinutes());
      case "p": return now.getHours() < 12 ? "AM" : "PM";
      case "S": return pad2(now.getSeconds());
      case "T": return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
      case "w": return String(now.getDay());
      case "y": return pad2(now.getFullYear() % 100);
      case "Y": return String(now.getFullYear());
      case "%": return "%";
      default:
        warn?.(`strftime code %${code} is not supported; kept literal`);
        return whole;
    }
  });
}

const SPECIFIER = /^%(-)?(\d+)?(?:\.(\d+))?([A-Za-z%])/;

/**
 * Format `args` with a TinTin #format string. Arguments arrive already
 * interpolated; each recognized specifier consumes the next one.
 */
export function formatTinTin(
  format: string,
  args: string[],
  warn: (message: string) => void,
  now: Date = new Date(),
): string {
  let output = "";
  let argIndex = 0;
  const next = () => args[argIndex++] ?? "";
  for (let index = 0; index < format.length;) {
    if (format[index] !== "%") {
      output += format[index++];
      continue;
    }
    const match = SPECIFIER.exec(format.slice(index));
    if (!match) {
      output += format[index++];
      continue;
    }
    const [whole, leftAlign, widthText, precisionText, code] = match;
    const width = widthText === undefined ? null : Number(widthText);
    const precision = precisionText === undefined ? null : Number(precisionText);
    let piece: string | null = null;
    switch (code) {
      case "%":
        output += "%";
        index += whole.length;
        continue;
      case "s":
        piece = next();
        if (precision !== null) piece = piece.slice(0, precision);
        break;
      case "d": {
        const number = Number.parseInt(next(), 10);
        piece = String(Number.isNaN(number) ? 0 : number);
        break;
      }
      case "p":
        piece = next().trim();
        break;
      case "t":
        piece = tinTinStrftime(next(), now, warn);
        break;
      default:
        warn(`#format specifier %${code} is not supported; kept literal`);
        output += whole;
        index += whole.length;
        continue;
    }
    if (width !== null) {
      piece = leftAlign ? piece.padEnd(width) : piece.padStart(width);
    }
    output += piece;
    index += whole.length;
  }
  return output;
}

/** TinTin's #list option table, resolved by first-prefix with its aliases. */
const LIST_OPTIONS: Array<[string, string]> = [
  ["add", "add"], ["clear", "clear"], ["clr", "clear"], ["collapse", "collapse"],
  ["copy", "copy"], ["create", "create"], ["delete", "delete"], ["explode", "explode"],
  ["filter", "filter"], ["find", "find"], ["fnd", "find"], ["get", "get"],
  ["indexate", "indexate"], ["insert", "insert"], ["numerate", "numerate"],
  ["order", "order"], ["length", "size"], ["refine", "refine"], ["reverse", "reverse"],
  ["set", "set"], ["shuffle", "shuffle"], ["simplify", "simplify"], ["size", "size"],
  ["sort", "sort"], ["srt", "sort"], ["swap", "swap"], ["tokenize", "tokenize"],
];

export function tinTinListOption(value: unknown): string {
  const input = String(value ?? "").trim().toLowerCase();
  if (!input) return "";
  return LIST_OPTIONS.find(([name]) => name.startsWith(input))?.[1] ?? input;
}
