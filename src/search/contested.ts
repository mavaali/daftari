// contested — post-join of the tension log onto search hits.
//
// The tension-graph feud benchmark (2026-07-04) measured this shape: a
// contradiction surfaced INLINE in the retrieval payload is acted on ~6x more
// often than one reachable through a dedicated tool the agent must choose to
// call (tg-3b vs tg-3a, all three panel models). This module is the inline
// half: vaultSearch asks contestedFor per surviving hit, in the same
// enrichment pass as resolveCurrentSource.
//
// Advisory, additive, lossless: contested-ness never feeds ranking, and a
// missing or malformed tension log degrades to "no annotations", never a
// failed search. Unresolved tensions only — a resolved tension's outcome is
// already expressed through supersede/deprecate edges, and the live marker
// must mean live disagreement.

import { readFileSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
import { type AccessContext, canRead } from "../access/rbac.js";
import { parseTensionLog, type TensionKind, tensionsPath } from "../curation/tension.js";
import { getDocument, type IndexDb } from "../storage/index-db.js";

export interface ContestedTension {
  id?: string; // absent only for legacy entries
  kind: TensionKind;
  counterpart: string; // canonical vault-relative path of the other side
  claimSelf: string; // this hit's claim, per the log
  claimOther: string; // the counterpart's claim
  loggedAt: string; // entry date, YYYY-MM-DD
}

// Payload bound per hit. contestedCount reports the true total, so the cap
// never silently truncates.
export const CONTESTED_CAP = 3;

// One side of one entry, pre-oriented at map-build time so the per-hit join
// is a plain lookup.
interface SideRecord {
  order: number; // block position in the log (append-only ⇒ logged order)
  id?: string;
  kind: TensionKind;
  date: string;
  counterpart: string;
  claimSelf: string;
  claimOther: string;
}

// Lexical, IO-free canonicalization of a vault-relative path: aliasing
// (`pricing/../pricing/a.md`) must join its canonical hit (#127/#128 class).
// A path that escapes the root normalizes to a `..`-leading form, which can
// never equal an indexed hit path — escapes simply never join.
function canonicalRel(p: string): string {
  return posix.normalize(p.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
}

// mtime-keyed cache of the parsed, indexed log — the E2 loadConfig pattern
// (utils/config.ts): statSync per call, full re-read only when the mtime
// changes. ENOENT is itself a cache state (`mtimeMs: null`), so an absent log
// caches an empty map and a log that appears busts it. A non-ENOENT stat
// error yields NaN, which never satisfies `===` — such calls re-read rather
// than serve a stale hit.
interface CacheEntry {
  mtimeMs: number | null;
  byPath: Map<string, SideRecord[]>;
}
const cache = new Map<string, CacheEntry>();

// Test-only hook, mirroring clearConfigCache.
export function clearContestedCache(): void {
  cache.clear();
}

function buildByPath(raw: string): Map<string, SideRecord[]> {
  const byPath = new Map<string, SideRecord[]>();
  const add = (key: string, record: SideRecord) => {
    const list = byPath.get(key);
    if (list) list.push(record);
    else byPath.set(key, [record]);
  };
  parseTensionLog(raw).forEach((entry, order) => {
    if (entry.resolved) return;
    const a = canonicalRel(entry.sourceA);
    const b = canonicalRel(entry.sourceB);
    if (a.length === 0 || b.length === 0) return;
    const base = { order, id: entry.id, kind: entry.kind, date: entry.date };
    add(a, { ...base, counterpart: b, claimSelf: entry.claimA, claimOther: entry.claimB });
    add(b, { ...base, counterpart: a, claimSelf: entry.claimB, claimOther: entry.claimA });
  });
  return byPath;
}

function tensionsByPath(vaultRoot: string): Map<string, SideRecord[]> {
  const path = tensionsPath(vaultRoot);
  const key = resolve(vaultRoot);

  let mtimeMs: number | null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (e) {
    mtimeMs = (e as NodeJS.ErrnoException).code === "ENOENT" ? null : Number.NaN;
  }

  const cached = cache.get(key);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.byPath;

  let byPath: Map<string, SideRecord[]>;
  if (mtimeMs === null) {
    byPath = new Map();
  } else {
    let raw = "";
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      // Race (log deleted between stat and read) or unreadable file: degrade
      // to no annotations for this call. Never fail the search.
    }
    byPath = buildByPath(raw);
  }
  cache.set(key, { mtimeMs, byPath });
  return byPath;
}

// The counterpart's collection for the RBAC gate: the indexed row when
// present; the physical first path segment otherwise (the S1/#192 rule —
// key on where the bytes live, never on a declared string). The fallback
// errs closed: a `..`-leading or empty segment matches no role's read list.
function counterpartCollection(db: IndexDb, counterpart: string): string {
  const doc = getDocument(db, counterpart);
  return doc?.collection ?? counterpart.split("/")[0] ?? "";
}

// The per-hit join. Returns null when the hit has no visible unresolved
// tensions — callers leave the hit untouched (fields absent, never empty).
//
// RBAC: an annotation quotes the counterpart's claim, so it crosses the ACL
// boundary. A record is visible only when the caller can read the
// counterpart's collection; invisible records are omitted entirely (no
// existence leak) and excluded from contestedCount — the count never reveals
// hidden tensions. `access` undefined ⇒ RBAC unconfigured ⇒ all visible,
// matching vaultSearch's own filtering.
export function contestedFor(
  vaultRoot: string,
  db: IndexDb,
  hitPath: string,
  access?: AccessContext,
): { contested: ContestedTension[]; contestedCount: number } | null {
  const records = tensionsByPath(vaultRoot).get(canonicalRel(hitPath));
  if (records === undefined) return null;

  const visible = access
    ? records.filter((r) => canRead(access.role, counterpartCollection(db, r.counterpart)))
    : records;
  if (visible.length === 0) return null;

  // Date desc, then log position desc: dates are day-granular, so the file
  // position (logged order) is the load-bearing same-day tiebreak.
  const ordered = [...visible].sort((x, y) => y.date.localeCompare(x.date) || y.order - x.order);

  return {
    contested: ordered.slice(0, CONTESTED_CAP).map((r) => ({
      ...(r.id !== undefined ? { id: r.id } : {}),
      kind: r.kind,
      counterpart: r.counterpart,
      claimSelf: r.claimSelf,
      claimOther: r.claimOther,
      loggedAt: r.date,
    })),
    contestedCount: ordered.length,
  };
}
