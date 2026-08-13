import { getDataDir } from "smudgy:core";

export const RAW_COMM_LOG_FILE = "comm-channel-raw.jsonl";
export const RAW_COMM_LOG_SCHEMA = "nukefire-scripts/comm-channel-raw/v1";
export const rawCommLogPath = `${getDataDir().replaceAll("\\", "/")}/${RAW_COMM_LOG_FILE}`;

interface DenoFileSubset {
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeTextFile(
    path: string,
    text: string,
    options?: { append?: boolean; create?: boolean },
  ): Promise<void>;
}

function denoFiles(): DenoFileSubset {
  const deno = (globalThis as { Deno?: DenoFileSubset }).Deno;
  if (!deno) throw new Error("file access is unavailable in this runtime");
  return deno;
}

/** Ordered, append-only capture of the untouched Comm.Channel payload. */
export class RawCommLogger {
  readonly path = rawCommLogPath;
  readonly #captureStartedAt = new Date().toISOString();
  readonly #onError: (message: string) => void;
  readonly #pending: string[] = [];
  #sequence = 0;
  #flushing = false;
  #directoryReady = false;

  constructor(onError: (message: string) => void) {
    this.#onError = onError;
  }

  append(payload: unknown): void {
    try {
      this.#sequence += 1;
      this.#pending.push(`${JSON.stringify({
        schema: RAW_COMM_LOG_SCHEMA,
        capturedAt: new Date().toISOString(),
        captureStartedAt: this.#captureStartedAt,
        sequence: this.#sequence,
        message: "Comm.Channel",
        payload,
      }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}\n`);
      if (!this.#flushing) void this.#flush();
    } catch (caught) {
      this.#onError(`could not serialize Comm.Channel capture: ${describeError(caught)}`);
    }
  }

  async #flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      const files = denoFiles();
      if (!this.#directoryReady) {
        files.mkdirSync(this.path.slice(0, this.path.lastIndexOf("/")), { recursive: true });
        this.#directoryReady = true;
      }
      while (this.#pending.length > 0) {
        const batch = this.#pending.splice(0).join("");
        await files.writeTextFile(this.path, batch, { append: true, create: true });
      }
    } catch (caught) {
      this.#directoryReady = false;
      this.#pending.length = 0;
      this.#onError(`could not append ${this.path}: ${describeError(caught)}`);
    } finally {
      this.#flushing = false;
      if (this.#pending.length > 0) void this.#flush();
    }
  }
}

function describeError(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
