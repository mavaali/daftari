// `daftari attest verify` semantics (#298): the 1-vs-4 exit split is the
// point — scripts must distinguish FORGED (1) from STALE (4). Read-only,
// never writes, never locks.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, signManifest } from "../../src/attest/bundle.js";
import { generateAttestKeys, loadAttestKey } from "../../src/attest/sign.js";
import { verifyBundle } from "../../src/attest/verify.js";

let vault: string;
let keyDir: string;

function g(...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", vault, "-c", "user.name=op", "-c", "user.email=op@t", ...args],
    { encoding: "utf-8" },
  );
}

function writeDoc(relPath: string, body = "Body.\n"): void {
  mkdirSync(join(vault, relPath.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(
    join(vault, relPath),
    `---
title: "Doc ${relPath}"
domain: "accumulation"
collection: "${relPath.split("/")[0]}"
status: "canonical"
confidence: "high"
created: "2026-08-01"
updated: "2026-08-01"
updated_by: "agent:test"
provenance: "direct"
superseded_by: null
ttl_days: 120
sources: []
tags: []
---

${body}`,
    "utf-8",
  );
}

async function makeSignedBundle(): Promise<string> {
  const m = await buildManifest(vault, { daftariVersion: "0.0.0-test" });
  if (!m.ok) throw m.error;
  const key = loadAttestKey(join(keyDir, "attest.key"));
  if (!key.ok) throw key.error;
  return JSON.stringify(signManifest(m.value, key.value), null, 2);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-attverify-"));
  keyDir = mkdtempSync(join(tmpdir(), "daftari-attkeys-"));
  const made = generateAttestKeys(keyDir);
  if (!made.ok) throw made.error;
  g("init", "-q");
  writeDoc("docs/a.md");
  writeDoc("docs/b.md");
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
});

describe("verifyBundle", () => {
  it("verifies a pristine bundle against its vault: exit 0", async () => {
    const bundle = await makeSignedBundle();
    const r = await verifyBundle(bundle, { vaultRoot: vault });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("verified");
    expect(r.value.exitCode).toBe(0);
    expect(r.value.docs?.match).toEqual(["docs/a.md", "docs/b.md"]);
    expect(r.value.headKnown).toBe(true);
  });

  it("malformed envelope: exit 2", async () => {
    const r = await verifyBundle("{not json", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("malformed");
    expect(r.value.exitCode).toBe(2);
    const wrongTag = await verifyBundle(JSON.stringify({ format: "nope", manifest: {} }), {});
    expect(wrongTag.ok && wrongTag.value.exitCode).toBe(2);
  });

  it("a tampered manifest fails the signature: exit 1", async () => {
    const bundle = JSON.parse(await makeSignedBundle());
    bundle.manifest.docs[0].contentHash = "0".repeat(64);
    const r = await verifyBundle(JSON.stringify(bundle), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("signature-invalid");
    expect(r.value.exitCode).toBe(1);
  });

  it("a pinned public key that differs is key-mismatch: exit 1, even with a valid signature", async () => {
    const bundle = await makeSignedBundle();
    const otherDir = mkdtempSync(join(tmpdir(), "daftari-otherkey-"));
    const other = generateAttestKeys(otherDir);
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const otherPub = loadAttestKey(other.value.keyPath);
    expect(otherPub.ok).toBe(true);
    if (!otherPub.ok) return;
    const r = await verifyBundle(bundle, { pubkeyPem: otherPub.value.publicKeyPem });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("key-mismatch");
    expect(r.value.exitCode).toBe(1);
    rmSync(otherDir, { recursive: true, force: true });
  });

  it("signature-only mode (no vault): exit 0, identity unpinned flagged", async () => {
    const bundle = await makeSignedBundle();
    const r = await verifyBundle(bundle, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("verified");
    expect(r.value.exitCode).toBe(0);
    expect(r.value.identityPinned).toBe(false);
    expect(r.value.docs).toBeUndefined();
  });

  it("edited, deleted, and extra docs report individually: exit 4, signature still valid", async () => {
    const bundle = await makeSignedBundle();
    writeDoc("docs/a.md", "Edited after attestation.\n"); // modified
    rmSync(join(vault, "docs", "b.md")); // missing
    writeDoc("docs/c.md"); // unlisted
    const r = await verifyBundle(bundle, { vaultRoot: vault });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("content-drift");
    expect(r.value.exitCode).toBe(4);
    expect(r.value.docs?.modified).toEqual(["docs/a.md"]);
    expect(r.value.docs?.missing).toEqual(["docs/b.md"]);
    expect(r.value.docs?.unlisted).toEqual(["docs/c.md"]);
  });

  it("an unknown head with matching files is informational drift: exit 4", async () => {
    const bundle = JSON.parse(await makeSignedBundle());
    // Re-sign with a bogus head so the signature stays valid.
    bundle.manifest.headCommit = "f".repeat(40);
    const key = loadAttestKey(join(keyDir, "attest.key"));
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    const { signManifest: resign } = await import("../../src/attest/bundle.js");
    const resigned = resign(bundle.manifest, key.value);
    const r = await verifyBundle(JSON.stringify(resigned), { vaultRoot: vault });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.headKnown).toBe(false);
    expect(r.value.exitCode).toBe(4);
  });
});

describe("review hardening", () => {
  it("a bundle with escaping doc paths is malformed — never a file oracle", async () => {
    const bundle = JSON.parse(await makeSignedBundle());
    bundle.manifest.docs.push({
      path: "../../../../etc/hosts",
      contentHash: "0".repeat(64),
      status: "canonical",
      confidence: "high",
      provenance: "direct",
      contested: false,
      ratified: false,
      openTensions: 0,
      git: null,
    });
    const key = loadAttestKey(join(keyDir, "attest.key"));
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    const { signManifest: resign } = await import("../../src/attest/bundle.js");
    const resigned = resign(bundle.manifest, key.value);
    const r = await verifyBundle(JSON.stringify(resigned), { vaultRoot: vault });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.state).toBe("malformed");
    expect(r.value.exitCode).toBe(2);
  });

  it("a signer.keyId that mismatches the embedded key is rejected", async () => {
    const bundle = JSON.parse(await makeSignedBundle());
    bundle.manifest.signer.keyId = "f".repeat(16);
    const key = loadAttestKey(join(keyDir, "attest.key"));
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    // Re-sign so ONLY the cosmetic keyId is inconsistent with the key.
    const resigned = {
      format: bundle.format,
      manifest: bundle.manifest,
      signature: {
        algorithm: "ed25519",
        keyId: key.value.keyId,
        value: (await import("../../src/attest/sign.js")).signBytes(
          key.value,
          JSON.stringify(bundle.manifest),
        ),
      },
    };
    const r = await verifyBundle(JSON.stringify(resigned), {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exitCode).toBe(1);
  });
});
