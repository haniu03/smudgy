// #read / #write file access, confined to the package's data directory.
// The manifest grants are already scoped there; normalizing the name
// ourselves means a bad path fails with a readable TinTin error instead of
// a permission throw, and gives #read a cycle guard.

import { getDataDir } from "smudgy:core";

interface DenoFsSubset {
  readTextFileSync(path: string): string;
  writeTextFileSync(path: string, text: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

function denoFs(): DenoFsSubset {
  const deno = (globalThis as { Deno?: DenoFsSubset }).Deno;
  if (!deno) throw new Error("file access is unavailable in this runtime");
  return deno;
}

/**
 * A path inside $DATA for a user-supplied file name, or `null` when the name
 * tries to leave it (absolute paths, drive letters, `..`).
 */
export function resolveDataPath(name: string): string | null {
  const cleaned = String(name ?? "").trim().replaceAll("\\", "/");
  if (!cleaned || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) return null;
  const parts: string[] = [];
  for (const part of cleaned.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  if (!parts.length) return null;
  return `${getDataDir().replaceAll("\\", "/")}/${parts.join("/")}`;
}

const readingStack: string[] = [];
const MAX_READ_DEPTH = 10;

export interface ReadResult {
  text?: string;
  error?: string;
}

/**
 * Read a `.tin` file for #read. The caller must pair a successful read with
 * `endRead()` once execution of the file finishes, so nested #read cycles
 * are caught.
 */
export function beginRead(name: string): ReadResult {
  const path = resolveDataPath(name);
  if (!path) return { error: `{${name}} is not a file name inside this package's data directory` };
  if (readingStack.includes(path)) return { error: `{${name}} is already being read (#read cycle)` };
  if (readingStack.length >= MAX_READ_DEPTH) return { error: `#read nesting exceeded ${MAX_READ_DEPTH} files` };
  let text: string;
  try {
    text = denoFs().readTextFileSync(path);
  } catch (error) {
    return { error: `could not read {${name}}: ${error instanceof Error ? error.message : String(error)}` };
  }
  readingStack.push(path);
  return { text };
}

export function endRead(): void {
  readingStack.pop();
}

/** Write a text file into $DATA, creating directories as needed. */
export function writeDataFile(name: string, content: string): string | null {
  const path = resolveDataPath(name);
  if (!path) return `{${name}} is not a file name inside this package's data directory`;
  try {
    const fs = denoFs();
    const directory = path.slice(0, path.lastIndexOf("/"));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeTextFileSync(path, content);
    return null;
  } catch (error) {
    return `could not write {${name}}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
