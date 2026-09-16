// The canonicalization bet, isolated so its failure names the hypothesis:
// signature bytes are JSON.stringify(manifest) exactly as produced, and
// verification re-stringifies the PARSED manifest. This round-trips
// byte-identically in JS because key insertion order is preserved for
// non-integer-like string keys and `docs` is an array — the manifest schema
// bans integer-like object keys anywhere. Kill condition: a non-JS verifier
// appears, or this test flakes across Node versions → adopt RFC 8785 JCS
// and bump the format tag.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, manifestBytes, signManifest } from "../../src/attest/bundle.js";
import { generateAttestKeys, loadAttestKey, verifyBytes } from "../../src/attest/sign.js";

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-attcanon-"));
  execFileSync("git", ["-C", vault, "init", "-q"]);
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("manifest canonicalization round-trip", () => {
  it("parse→stringify of the envelope's manifest reproduces the signed bytes", async () => {
    mkdirSync(join(vault, "docs"), { recursive: true });
    writeFileSync(
      join(vault, "docs", "a.md"),
      '---\ntitle: "a"\ndomain: "accumulation"\ncollection: "docs"\nstatus: "canonical"\nconfidence: "high"\ncreated: "2026-08-01"\nupdated: "2026-08-01"\nupdated_by: "t"\nprovenance: "direct"\nsuperseded_by: null\nttl_days: null\nsources: []\ntags: []\n---\n\nA.\n',
    );
    execFileSync("git", ["-C", vault, "add", "-A"]);
    execFileSync("git", [
      "-C",
      vault,
      "-c",
      "user.name=op",
      "-c",
      "user.email=op@t",
      "commit",
      "-q",
      "-m",
      "seed",
    ]);

    const m = await buildManifest(vault, { daftariVersion: "0.0.0-test" });
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const keys = generateAttestKeys(`${vault}-keys`);
    expect(keys.ok).toBe(true);
    if (!keys.ok) return;
    const key = loadAttestKey(keys.value.keyPath);
    expect(key.ok).toBe(true);
    if (!key.ok) return;

    const envelope = signManifest(m.value, key.value);
    const wire = JSON.stringify(envelope, null, 2); // pretty-printed on disk
    const reparsed = JSON.parse(wire) as { manifest: unknown; signature: { value: string } };
    const rebytes = manifestBytes(reparsed.manifest);
    // The signed manifest (signer filled) round-trips to the exact bytes…
    expect(rebytes).toBe(manifestBytes(envelope.manifest));
    // …and the signature verifies over the RE-PARSED bytes.
    expect(verifyBytes(key.value.publicKeyPem, rebytes, reparsed.signature.value)).toBe(true);
    rmSync(`${vault}-keys`, { recursive: true, force: true });
  });
});
