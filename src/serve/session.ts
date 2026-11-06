// session.ts — U1: signed browser-session token for the board login shim.
//
// A stateless, HMAC-signed token carried in an HttpOnly cookie so a browser
// (which cannot send `Authorization: Bearer` on navigation) can authenticate
// to `/board`. The server holds no session table — like the rest of `serve`,
// identity is verified per request from the signed token alone.
//
// Wire format:  base64url(JSON payload) + "." + base64url(HMAC-SHA256(key, payloadB64))
//
// Security posture, mirroring the token path (`matchToken`, index.ts):
//   - the MAC is compared in constant time (timingSafeEqual);
//   - the payload bytes are parsed ONLY after the MAC verifies, so no
//     attacker-controlled JSON is trusted before authentication;
//   - `exp` (unix seconds) is enforced against an injected `nowSec` so the
//     check is deterministic in tests and monotonic in production;
//   - `aud` binds the token to one deployment (3p4.8): a cookie minted by
//     another vault's server is rejected even if the signing key is shared.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";

export interface SessionPayload {
  user: string;
  role: string;
  // Absolute expiry, unix seconds.
  exp: number;
  // Deployment audience — sessionAudience(vaultRoot) of the minting server.
  aud: string;
}

// The audience a server mints and accepts: a random id generated once per
// vault and kept in .daftari/session-audience (gitignored, machine-local).
// Not derived from the path — containers that all mount at /vault would
// otherwise share it. Created with 'wx' so concurrent first starts agree.
export function sessionAudience(vaultRoot: string): string {
  const path = join(vaultRoot, ".daftari", "session-audience");
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    try {
      writeFileSync(path, randomBytes(16).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    return readFileSync(path, "utf-8").trim();
  }
}

export function signSession(payload: SessionPayload, key: Buffer): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const mac = createHmac("sha256", key).update(payloadB64).digest().toString("base64url");
  return `${payloadB64}.${mac}`;
}

export function verifySession(
  token: string,
  key: Buffer,
  nowSec: number,
  audience: string,
): Result<SessionPayload, Error> {
  const dot = token.indexOf(".");
  // A single interior "." with non-empty halves. `a.b.c` fails here too, since
  // the MAC half would then contain a "." and fail base64url decoding below.
  if (dot <= 0 || dot >= token.length - 1) {
    return err(new Error("malformed session token"));
  }
  const payloadB64 = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);

  const expectedMac = createHmac("sha256", key).update(payloadB64).digest();
  const presentedMac = Buffer.from(macB64, "base64url");
  // timingSafeEqual throws on length mismatch; compare expected-vs-expected in
  // that case so every token costs one constant-time comparison, then fail on
  // the length flag — identical shape to matchToken().
  const sameLength = presentedMac.length === expectedMac.length;
  const macEqual = timingSafeEqual(sameLength ? presentedMac : expectedMac, expectedMac);
  if (!sameLength || !macEqual) {
    return err(new Error("session signature mismatch"));
  }

  // MAC verified — only now is it safe to parse the payload.
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
  } catch {
    return err(new Error("session payload is not valid JSON"));
  }
  if (typeof raw !== "object" || raw === null) {
    return err(new Error("session payload is not an object"));
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.user !== "string" ||
    typeof obj.role !== "string" ||
    typeof obj.exp !== "number" ||
    !Number.isFinite(obj.exp)
  ) {
    return err(new Error("session payload shape is invalid"));
  }
  if (obj.exp <= nowSec) {
    return err(new Error("session expired"));
  }
  if (obj.aud !== audience) {
    return err(new Error("session audience mismatch"));
  }
  return ok({ user: obj.user, role: obj.role, exp: obj.exp, aud: audience });
}
