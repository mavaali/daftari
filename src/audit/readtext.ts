// src/audit/readtext.ts
// Guarded text-file reader for non-markdown reference targets. The audit reads
// arbitrary code files (semantic.ts; the eval subgraph loader in #121) and hands
// their contents to an LLM. Those files carry none of the guarantees the
// markdown path enjoys, so every read is bounded:
//
//   - size-capped (default 256 KiB) — checked via stat BEFORE reading, so a
//     huge generated/vendored file is never pulled into memory;
//   - binary-sniffed (a NUL byte → not text) — never send raw bytes to a model;
//   - strict UTF-8 — undecodable input is rejected rather than mojibake'd.
//
// Content is never stored, indexed, or embedded — it is read ephemerally.

import { readFile, stat } from "node:fs/promises";
import { err, ok, type Result } from "../frontmatter/types.js";

export const DEFAULT_MAX_BYTES = 256 * 1024;

export interface ReadTextOk {
  text: string;
  bytes: number;
}

export type ReadTextReason = "too_large" | "binary" | "encoding" | "unreadable";

export interface ReadTextError {
  reason: ReadTextReason;
  message: string;
}

export interface ReadTextOptions {
  maxBytes?: number;
}

export async function readTextFile(
  absPath: string,
  opts: ReadTextOptions = {},
): Promise<Result<ReadTextOk, ReadTextError>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let size: number;
  try {
    const st = await stat(absPath);
    if (!st.isFile()) {
      return err({ reason: "unreadable", message: `not a regular file: ${absPath}` });
    }
    size = st.size;
  } catch (e) {
    return err({ reason: "unreadable", message: e instanceof Error ? e.message : String(e) });
  }

  if (size > maxBytes) {
    return err({ reason: "too_large", message: `${size} bytes exceeds cap of ${maxBytes}` });
  }

  let buf: Buffer;
  try {
    buf = await readFile(absPath);
  } catch (e) {
    return err({ reason: "unreadable", message: e instanceof Error ? e.message : String(e) });
  }

  if (buf.includes(0)) {
    return err({ reason: "binary", message: "contains NUL byte" });
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return ok({ text, bytes: buf.length });
  } catch {
    return err({ reason: "encoding", message: "not valid UTF-8" });
  }
}
