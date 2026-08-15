// The serve auth audit log: append-only JSONL under .daftari/, mirroring
// read-log.ts — best-effort, timestamp stamped at append, git-ignored.
//
// OPERATOR-ONLY, structurally (the Tension Court precedent): no MCP tool or
// resource may read or summarize this log — per-principal request counts are
// activity metadata about other principals, a disclosure surface the
// 2026-07-14 existence spec never designed. A guard test pins the boundary.
//
// Deliberately NOT logged: request bodies, tool names, tool arguments,
// query strings, `_meta` client info, User-Agent. This is an AUTH log; the
// moment it records what a principal asked, it becomes a privacy surface and
// a second provenance log (mutations already have provenance; reads have
// read-log.jsonl).

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";

export type AuthOutcome = "allow" | "deny-401" | "deny-403" | "rate-limited" | "over-capacity";

export interface AuthEvent {
  ts: string; // ISO 8601, stamped at append
  outcome: AuthOutcome;
  // The verified principal — allow / rate-limited / over-capacity outcomes.
  principal?: string;
  // deny-403 only: the authenticated-but-unmapped OAuth subject.
  subject?: string;
  // deny-401 only: 8 hex of sha256(presented bearer) — correlates repeated
  // bad tokens across lines while being useless for reconstruction. Never a
  // substring of the token; successful bearers are never hashed in.
  token_hint?: string;
  remote?: string; // req.socket.remoteAddress — never X-Forwarded-For
  method?: string;
  path?: string; // the route only — never a vault path
}

export function authLogPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "auth-log.jsonl");
}

// Salted per process: correlation holds within one server run (the incident
// window an operator actually inspects), while a leaked log allows no
// OFFLINE confirmation of token guesses via plain sha256(candidate).
const HINT_SALT = randomBytes(16);

export function tokenHint(bearer: string): string {
  return createHash("sha256").update(HINT_SALT).update(bearer).digest("hex").slice(0, 8);
}

// Appends one auth record. Best-effort: in the request path this is
// fire-and-forget — an audit write must never add latency or failure to a
// response.
export async function appendAuthEvent(
  vaultRoot: string,
  entry: Omit<AuthEvent, "ts">,
): Promise<Result<AuthEvent, Error>> {
  const full: AuthEvent = {
    ts: new Date().toISOString(),
    outcome: entry.outcome,
    ...(entry.principal ? { principal: entry.principal } : {}),
    ...(entry.subject ? { subject: entry.subject } : {}),
    ...(entry.token_hint ? { token_hint: entry.token_hint } : {}),
    ...(entry.remote ? { remote: entry.remote } : {}),
    ...(entry.method ? { method: entry.method } : {}),
    ...(entry.path ? { path: entry.path } : {}),
  };
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    await appendFile(authLogPath(vaultRoot), `${JSON.stringify(full)}\n`);
    return ok(full);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot append to auth log: ${reason}`));
  }
}
