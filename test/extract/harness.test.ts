// test/extract/harness.test.ts
// U6: the worker harness, entry, normalizer, and failure taxonomy. No
// docx/pptx/pdf parsing is exercised here — that's U7/U8/U9.

import { describe, expect, test } from "vitest";
import { extractText } from "../../src/extract/index.js";
import { assertUtf8NoNul, NulByteError, normalize } from "../../src/extract/normalize.js";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/extract/types.js";

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url);

describe("extractText harness", () => {
  test("times out a slow extractor, terminates the worker, and leaves the main thread usable", async () => {
    const tinyLimits = { ...DEFAULT_EXTRACT_LIMITS, wallClockMs: 100 };

    const result = await extractText(new Uint8Array([1, 2, 3]), "docx", tinyLimits, {
      workerUrl: new URL("slow-worker.ts", FIXTURES_DIR),
      execArgv: ["--import", "tsx"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("timeout");
    }

    // A subsequent, unrelated call must still complete normally — the
    // timed-out worker's termination must not have wedged anything.
    const followUp = await extractText(new Uint8Array([1, 2, 3]), "docx", DEFAULT_EXTRACT_LIMITS, {
      workerUrl: new URL("fixed-worker.ts", FIXTURES_DIR),
      execArgv: ["--import", "tsx"],
    });

    expect(followUp.ok).toBe(true);
    if (followUp.ok) {
      expect(followUp.value.text).toBe("fixed result");
    }
  });

  test("dispatches to the real worker and reports unsupported_type before U9 lands", async () => {
    // docx (U7) and pptx (U8) are now implemented — use pdf (still a U9
    // stub) to exercise the "not yet implemented" dispatch path.
    const result = await extractText(new Uint8Array([1, 2, 3]), "pdf", DEFAULT_EXTRACT_LIMITS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("unsupported_type");
    }
  });

  test("maps a worker resourceLimits (heap-cap) kill to too_large, not malformed", async () => {
    // A generous wallClockMs so the race is against the heap cap, not the
    // timeout path — the fixture worker allocates until V8 kills it for
    // exceeding this tiny heap, which should happen in well under a second.
    const smallHeapLimits = { ...DEFAULT_EXTRACT_LIMITS, workerHeapMb: 8, wallClockMs: 20_000 };

    const result = await extractText(new Uint8Array([1, 2, 3]), "docx", smallHeapLimits, {
      workerUrl: new URL("oom-worker.ts", FIXTURES_DIR),
      execArgv: ["--import", "tsx"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("too_large");
    }
  }, 25_000);
});

describe("normalize", () => {
  test("converts CRLF to LF, strips trailing whitespace, and collapses runs of blank lines", () => {
    const input = "line one  \r\nline two\t\r\n\n\n\n\n\nline three   \r\n";
    const output = normalize(input);

    expect(output).not.toMatch(/\r/);
    expect(output).not.toMatch(/[ \t]+\n/);
    expect(output).not.toMatch(/[ \t]+$/);
    expect(output).not.toMatch(/\n{4,}/);
    expect(output).toBe("line one\nline two\n\n\nline three\n");
  });

  test("rejects text containing a NUL byte", () => {
    const withNul = `bad${String.fromCharCode(0)}text`;
    expect(() => normalize(withNul)).toThrow(NulByteError);
  });
});

describe("assertUtf8NoNul", () => {
  test("rejects raw bytes containing a NUL byte", () => {
    const bytes = new Uint8Array([104, 105, 0, 116, 104, 101, 114, 101]); // "hi\0there"
    expect(() => assertUtf8NoNul(bytes)).toThrow(NulByteError);
  });

  test("decodes clean UTF-8 bytes", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(assertUtf8NoNul(bytes)).toBe("hello");
  });
});
