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
//
// Run with: npx vitest run test/serve/session.test.ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "../../src/serve/session.js";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf-8");
const OTHER = Buffer.from("fedcba9876543210fedcba9876543210", "utf-8");
const NOW = 1_700_000_000;

describe("session token", () => {
  it("round-trips a payload", () => {
    const token = signSession({ user: "mihir", role: "admin", exp: NOW + 3600 }, KEY);
    const r = verifySession(token, KEY, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.user).toBe("mihir");
      expect(r.value.role).toBe("admin");
      expect(r.value.exp).toBe(NOW + 3600);
    }
  });

  it("rejects a token signed with a different key (forgery)", () => {
    const token = signSession({ user: "mihir", role: "admin", exp: NOW + 3600 }, OTHER);
    expect(verifySession(token, KEY, NOW).ok).toBe(false);
  });

  it("rejects a tampered payload (role escalation)", () => {
    const token = signSession({ user: "guest", role: "analyst", exp: NOW + 3600 }, KEY);
    const [, mac] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ user: "guest", role: "admin", exp: NOW + 3600 }),
      "utf-8",
    ).toString("base64url");
    const forged = `${forgedPayload}.${mac}`;
    expect(verifySession(forged, KEY, NOW).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    const token = signSession({ user: "mihir", role: "admin", exp: NOW - 1 }, KEY);
    expect(verifySession(token, KEY, NOW).ok).toBe(false);
  });

  it("accepts a token expiring in the future", () => {
    const token = signSession({ user: "mihir", role: "admin", exp: NOW + 1 }, KEY);
    expect(verifySession(token, KEY, NOW).ok).toBe(true);
  });

  it("rejects malformed tokens without throwing", () => {
    for (const bad of ["", ".", "nodot", "a.", ".b", "a.b.c"]) {
      expect(verifySession(bad, KEY, NOW).ok).toBe(false);
    }
  });

  it("rejects a validly-signed payload of the wrong shape", () => {
    // Sign a payload that verifies cryptographically but lacks required fields.
    const payloadB64 = Buffer.from(JSON.stringify({ user: "mihir" }), "utf-8").toString(
      "base64url",
    );
    const mac = createHmac("sha256", KEY).update(payloadB64).digest().toString("base64url");
    expect(verifySession(`${payloadB64}.${mac}`, KEY, NOW).ok).toBe(false);
  });
});
