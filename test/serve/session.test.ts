// session.test.ts — U1: signed browser-session token (pure crypto).
//
// The board login shim mints an HMAC-signed session token carried in an
// HttpOnly cookie. This suite locks the crypto contract in isolation — no
// HTTP, no cookies, no I/O — so the security properties are verifiable on
// their own:
//   1. round-trip: sign → verify returns the payload.
//   2. wrong key → rejected (forged cookie).
//   3. tampered payload (role escalation) → signature mismatch.
//   4. expired token → rejected.
//   5. malformed / bad-encoding tokens → rejected, never throw.
//   6. payload is parsed ONLY after the MAC verifies (shape guard on a
//      validly-signed but malformed payload).
//   7. audience binding (3p4.8): a cookie minted for another deployment —
//      or with no audience — is rejected even under a shared key.
//
// Run with: npx vitest run test/serve/session.test.ts
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionAudience, signSession, verifySession } from "../../src/serve/session.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf-8");
const OTHER = Buffer.from("fedcba9876543210fedcba9876543210", "utf-8");
const NOW = 1_700_000_000;
const AUD = "vault-a";

describe("session token", () => {
  it("round-trips a payload", () => {
    const token = signSession({ user: "mihir", role: "admin", exp: NOW + 3600, aud: AUD }, KEY);
    const r = verifySession(token, KEY, NOW, AUD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.user).toBe("mihir");
      expect(r.value.role).toBe("admin");
      expect(r.value.exp).toBe(NOW + 3600);
    }
  });

  it("rejects a token signed with a different key (forgery)", () => {
    const token = signSession({ user: "mihir", role: "admin", exp: NOW + 3600, aud: AUD }, OTHER);
    expect(verifySession(token, KEY, NOW, AUD).ok).toBe(false);
  });

  it("rejects a tampered payload (role escalation)", () => {
    const token = signSession({ user: "guest", role: "analyst", exp: NOW + 3600, aud: AUD }, KEY);
    const [, mac] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ user: "guest", role: "admin", exp: NOW + 3600 }),
      "utf-8",
    ).toString("base64url");
    const forged = `${forgedPayload}.${mac}`;
    expect(verifySession(forged, KEY, NOW, AUD).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    const token = signSession({ user: "mihir", role: "admin", exp: NOW - 1, aud: AUD }, KEY);
    expect(verifySession(token, KEY, NOW, AUD).ok).toBe(false);
  });

  it("accepts a token expiring in the future", () => {
    const token = signSession({ user: "mihir", role: "admin", exp: NOW + 1, aud: AUD }, KEY);
    expect(verifySession(token, KEY, NOW, AUD).ok).toBe(true);
  });

  it("rejects malformed tokens without throwing", () => {
    for (const bad of ["", ".", "nodot", "a.", ".b", "a.b.c"]) {
      expect(verifySession(bad, KEY, NOW, AUD).ok).toBe(false);
    }
  });

  it("rejects a validly-signed payload of the wrong shape", () => {
    // Sign a payload that verifies cryptographically but lacks required fields.
    const payloadB64 = Buffer.from(JSON.stringify({ user: "mihir" }), "utf-8").toString(
      "base64url",
    );
    const mac = createHmac("sha256", KEY).update(payloadB64).digest().toString("base64url");
    expect(verifySession(`${payloadB64}.${mac}`, KEY, NOW, AUD).ok).toBe(false);
  });

  it("3p4.8: rejects a token minted for another audience under the same key", () => {
    const token = signSession(
      { user: "mihir", role: "admin", exp: NOW + 3600, aud: "vault-b" },
      KEY,
    );
    const r = verifySession(token, KEY, NOW, AUD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/audience/);
  });

  it("3p4.8: rejects a validly-signed token with no audience (pre-binding cookie)", () => {
    const payloadB64 = Buffer.from(
      JSON.stringify({ user: "mihir", role: "admin", exp: NOW + 3600 }),
      "utf-8",
    ).toString("base64url");
    const mac = createHmac("sha256", KEY).update(payloadB64).digest().toString("base64url");
    expect(verifySession(`${payloadB64}.${mac}`, KEY, NOW, AUD).ok).toBe(false);
  });

  it("3p4.8: audience is a persisted per-vault random id, not a path hash", () => {
    const a = mkdtempSync(join(tmpdir(), "daftari-aud-a-"));
    const b = mkdtempSync(join(tmpdir(), "daftari-aud-b-"));
    try {
      const first = sessionAudience(a);
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(sessionAudience(a)).toBe(first); // stable across restarts
      expect(sessionAudience(b)).not.toBe(first);
      // Same path, fresh volume (two containers both mounting /vault): new id.
      rmSync(join(a, ".daftari"), { recursive: true, force: true });
      expect(sessionAudience(a)).not.toBe(first);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
