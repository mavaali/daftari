// src/extract/normalize.ts
// Deterministic post-processing for extracted text (spec section 3.2).
// Downstream hashing and dedup depend on this being stable: the same input
// always normalizes to the same string.
//
// The NUL/UTF-8 guard mirrors src/audit/readtext.ts's binary-sniff pattern:
// a NUL byte means "not text" and is rejected rather than silently stripped.

const NUL_CHAR_CODE = 0;

export class NulByteError extends Error {
  constructor(where: string) {
    super(`${where}: input contains a NUL byte`);
    this.name = "NulByteError";
  }
}

function containsNulByte(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === NUL_CHAR_CODE) return true;
  }
  return false;
}

/** Decode raw bytes as strict UTF-8, rejecting a NUL byte or invalid encoding. */
export function assertUtf8NoNul(bytes: Uint8Array): string {
  if (bytes.includes(NUL_CHAR_CODE)) {
    throw new NulByteError("assertUtf8NoNul");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// Rules (spec section 3.2): CRLF -> LF; strip trailing whitespace per line;
// collapse 3+ consecutive blank lines down to 2.
export function normalize(text: string): string {
  if (containsNulByte(text)) {
    throw new NulByteError("normalize");
  }

  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = lf.split("\n").map((line) => line.replace(/[ \t]+$/g, ""));

  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === "") {
      blankRun += 1;
      if (blankRun <= 2) collapsed.push(line);
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }
  return collapsed.join("\n");
}
