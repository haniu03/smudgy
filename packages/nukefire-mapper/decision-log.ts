import { getDataDir } from "smudgy:core";

export const DEFAULT_DECISION_LOG_FILE = "mapping-decisions.jsonl";
export const DECISION_LOG_SCHEMA = "nukefire-mapper/decision-log/v1";

interface DenoFileSubset {
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeTextFile(
    path: string,
    text: string,
    options?: { append?: boolean; create?: boolean },
  ): Promise<void>;
}

export interface DecisionLogRecord {
  kind: string;
  [key: string]: unknown;
}

/** JSON has no bigint type; Smudgy ids use bigint and are logged as decimal strings. */
export function stringifyDecisionLogRecord(record: DecisionLogRecord): string {
  return JSON.stringify({
    ...record,
    schema: DECISION_LOG_SCHEMA,
    timestamp: new Date().toISOString(),
  }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}

function denoFiles(): DenoFileSubset {
  const deno = (globalThis as { Deno?: DenoFileSubset }).Deno;
  if (!deno) throw new Error("file access is unavailable in this runtime");
  return deno;
}

/** Resolve a configured relative file beneath this package's private $DATA. */
export function resolveDecisionLogPath(file: string): string | undefined {
  const cleaned = file.trim().replaceAll("\\", "/");
  if (!cleaned || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) return undefined;
  const parts: string[] = [];
  for (const part of cleaned.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(part);
  }
  if (parts.length === 0) return undefined;
  return `${getDataDir().replaceAll("\\", "/")}/${parts.join("/")}`;
}

/** Append-only JSON Lines logger which never makes mapping depend on logging. */
export class MappingDecisionLogger {
  readonly path: string | undefined;
  readonly #configurationError: string | undefined;
  readonly #onError: ((error: string) => void) | undefined;
  readonly #pending: string[] = [];
  #flushing = false;
  #directoryReady = false;

  constructor(file: string | false, onError?: (error: string) => void) {
    this.#onError = onError;
    if (file === false) {
      this.path = undefined;
      this.#configurationError = undefined;
      return;
    }
    this.path = resolveDecisionLogPath(file);
    this.#configurationError = this.path
      ? undefined
      : `decisionLogFile must name a file inside the package data directory: ${JSON.stringify(file)}`;
  }

  append(record: DecisionLogRecord): string | undefined {
    if (this.#configurationError) return this.#configurationError;
    if (!this.path) return undefined;
    try {
      this.#pending.push(`${stringifyDecisionLogRecord(record)}\n`);
      if (!this.#flushing) void this.#flush();
      return undefined;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return `could not append mapping decision log ${this.path}: ${message}`;
    }
  }

  async #flush(): Promise<void> {
    if (this.#flushing || !this.path) return;
    this.#flushing = true;
    try {
      const directory = this.path.slice(0, this.path.lastIndexOf("/"));
      const files = denoFiles();
      if (!this.#directoryReady) {
        files.mkdirSync(directory, { recursive: true });
        this.#directoryReady = true;
      }
      while (this.#pending.length > 0) {
        const batch = this.#pending.splice(0).join("");
        await files.writeTextFile(this.path, batch, { append: true, create: true });
      }
    } catch (caught) {
      this.#directoryReady = false;
      this.#pending.length = 0;
      const message = caught instanceof Error ? caught.message : String(caught);
      this.#onError?.(`could not append mapping decision log ${this.path}: ${message}`);
    } finally {
      this.#flushing = false;
      if (this.#pending.length > 0) void this.#flush();
    }
  }
}
