// Attestation signing primitives (#298): Ed25519 via node:crypto, key
// material on disk (never in config), keyId = 16 hex of sha256 over the
// public key DER.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateAttestKeys,
  keyIdOf,
  loadAttestKey,
  signBytes,
  verifyBytes,
} from "../../src/attest/sign.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daftari-attest-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("attest keys", () => {
  it("keygen writes a 0600 private key + public pem, and refuses overwrite", () => {
    const made = generateAttestKeys(dir);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(readFileSync(made.value.keyPath, "utf-8")).toContain("PRIVATE KEY");
    expect(readFileSync(made.value.pubPath, "utf-8")).toContain("PUBLIC KEY");
    expect(statSync(made.value.keyPath).mode & 0o777).toBe(0o600);

    const again = generateAttestKeys(dir);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.message).toContain("refusing to overwrite");
  });

  it("sign/verify round-trips, and one flipped byte fails", () => {
    const made = generateAttestKeys(dir);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const key = loadAttestKey(made.value.keyPath);
    expect(key.ok).toBe(true);
    if (!key.ok) return;

    const bytes = Buffer.from('{"manifest":true}', "utf-8");
    const sig = signBytes(key.value, bytes);
    expect(verifyBytes(key.value.publicKeyPem, bytes, sig)).toBe(true);

    const tampered = Buffer.from(bytes);
    if (tampered[0] !== undefined) tampered[0] ^= 0xff;
    expect(verifyBytes(key.value.publicKeyPem, tampered, sig)).toBe(false);
  });

  it("keyId is a stable 16-hex fingerprint across loads", () => {
    const made = generateAttestKeys(dir);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const a = loadAttestKey(made.value.keyPath);
    const b = loadAttestKey(made.value.keyPath);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.value.keyId).toBe(b.value.keyId);
    expect(a.value.keyId).toBe(keyIdOf(a.value.publicKeyPem));
  });

  it("a set-but-missing or malformed key file fails loud", () => {
    expect(loadAttestKey(join(dir, "nope.key")).ok).toBe(false);
    const made = generateAttestKeys(dir);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    // The PUBLIC key is not a usable signing key.
    const wrong = loadAttestKey(made.value.pubPath);
    expect(wrong.ok).toBe(false);
  });
});
