// test/audit/readtext.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTextFile } from "../../src/audit/readtext.js";

describe("readTextFile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "daftari-readtext-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads a small UTF-8 text file", async () => {
    const p = join(tmp, "a.ts");
    writeFileSync(p, "export const x = 1;\n");
    const r = await readTextFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("export const x = 1;\n");
  });

  it("rejects a file over the byte cap without reading it as text", async () => {
    const p = join(tmp, "big.ts");
    writeFileSync(p, "x".repeat(2000));
    const r = await readTextFile(p, { maxBytes: 1000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("too_large");
  });

  it("rejects a binary file (contains NUL bytes)", async () => {
    const p = join(tmp, "bin");
    writeFileSync(p, Buffer.from([0x41, 0x00, 0x42]));
    const r = await readTextFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("binary");
  });

  it("rejects invalid UTF-8 with an encoding error", async () => {
    const p = join(tmp, "bad");
    // 0xC3 0x28 is an invalid 2-byte UTF-8 sequence (no NUL, so not 'binary').
    writeFileSync(p, Buffer.from([0xc3, 0x28]));
    const r = await readTextFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("encoding");
  });

  it("reports unreadable for a missing file", async () => {
    const r = await readTextFile(join(tmp, "nope.ts"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("unreadable");
  });
});
