// `daftari attest` CLI smoke: the exit-code contract end to end.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAttest } from "../../src/attest/index.js";

let vault: string;
let work: string;

function g(...args: string[]): void {
  execFileSync("git", ["-C", vault, "-c", "user.name=op", "-c", "user.email=op@t", ...args]);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-attcli-vault-"));
  work = mkdtempSync(join(tmpdir(), "daftari-attcli-work-"));
  g("init", "-q");
  mkdirSync(join(vault, "docs"), { recursive: true });
  writeFileSync(
    join(vault, "docs", "a.md"),
    '---\ntitle: "a"\ndomain: "accumulation"\ncollection: "docs"\nstatus: "canonical"\nconfidence: "high"\ncreated: "2026-08-01"\nupdated: "2026-08-01"\nupdated_by: "t"\nprovenance: "direct"\nsuperseded_by: null\nttl_days: null\nsources: []\ntags: []\n---\n\nA.\n',
  );
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("daftari attest CLI", () => {
  it("keygen → produce → verify → drift walks the exit-code table", async () => {
    const keys = join(work, "keys");
    expect(await runAttest(["keygen", "--out", keys])).toBe(0);
    const keyPath = join(keys, "attest.key");
    const out = join(work, "bundle.json");

    // No key → 2.
    const prev = process.env.DAFTARI_ATTEST_KEY;
    delete process.env.DAFTARI_ATTEST_KEY;
    try {
      expect(await runAttest(["--vault", vault, "--out", out])).toBe(2);
    } finally {
      if (prev !== undefined) process.env.DAFTARI_ATTEST_KEY = prev;
    }

    // Produce → 0.
    expect(await runAttest(["--vault", vault, "--out", out, "--key", keyPath])).toBe(0);
    expect(existsSync(out)).toBe(true);

    // Inside-vault output → 2.
    expect(
      await runAttest(["--vault", vault, "--out", join(vault, "bundle.json"), "--key", keyPath]),
    ).toBe(2);

    // Verify against the vault, key-pinned via --key → 0.
    expect(await runAttest(["verify", out, "--vault", vault, "--key", keyPath])).toBe(0);

    // Dirty tree → produce refuses with 2.
    writeFileSync(join(vault, "docs", "b.md"), "not committed");
    expect(
      await runAttest(["--vault", vault, "--out", join(work, "b2.json"), "--key", keyPath]),
    ).toBe(2);
    rmSync(join(vault, "docs", "b.md"));

    // Drift: edit the doc after attestation → verify exits 4.
    writeFileSync(join(vault, "docs", "a.md"), "tampered");
    expect(await runAttest(["verify", out, "--vault", vault, "--key", keyPath])).toBe(4);

    // Signature-only mode still verifies → 0.
    expect(await runAttest(["verify", out])).toBe(0);
  }, 30_000);
});
