// Staleness — the time-decay half of the advisory curation engine.
//
// A document carries an optional `ttl_days` in its frontmatter: a soft
// expectation of how long the note stays accurate. Staleness measures how far
// past that expectation a document has drifted, as a decay score from 0.0
// (just updated) to 1.0 (fully stale — at or past its TTL).
//
// This is advisory only. Nothing here edits a file or changes a status; it
// reports a number the curator (vault_lint, vault_status) can act on.

import { parseDocument } from "../frontmatter/parser.js";
import { ok, type Result } from "../frontmatter/types.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";

const MS_PER_DAY = 86_400_000;

// Whole days between an ISO date (YYYY-MM-DD) and `now`. Negative if the date
// is in the future; NaN-safe — an unparseable date yields 0.
export function ageInDays(dateISO: string, now: Date = new Date()): number {
  const then = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(then)) return 0;
  return Math.floor((now.getTime() - then) / MS_PER_DAY);
}

export interface StalenessResult {
  score: number; // 0.0 fresh .. 1.0 fully stale
  ageDays: number; // days since `updated`
  ttlDays: number | null;
  expired: boolean; // age has reached or passed the TTL
}

// Computes the decay score for a document from its `updated` date and
// `ttl_days`. A document with no TTL never goes stale (score 0): it has made
// no freshness promise to break.
export function computeStaleness(
  input: { updated: string; ttl_days: number | null },
  now: Date = new Date(),
): StalenessResult {
  const ageDays = ageInDays(input.updated, now);
  const ttlDays = input.ttl_days;

  if (ttlDays === null) {
    return { score: 0, ageDays, ttlDays: null, expired: false };
  }
  if (ttlDays <= 0) {
    // A non-positive TTL means "stale the moment it ages at all".
    const expired = ageDays > 0;
    return { score: expired ? 1 : 0, ageDays, ttlDays, expired };
  }
  const ratio = ageDays / ttlDays;
  const score = Math.min(1, Math.max(0, ratio));
  return { score, ageDays, ttlDays, expired: ageDays >= ttlDays };
}

export interface StaleFile {
  path: string;
  title: string;
  staleness: StalenessResult;
}

// Scans the whole vault and returns documents whose decay score is at or above
// `threshold`, most stale first. The default threshold of 1.0 reports only
// documents at or past their TTL.
export async function listStaleFiles(
  vaultRoot: string,
  threshold = 1,
  now: Date = new Date(),
): Promise<Result<StaleFile[], Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  const stale: StaleFile[] = [];
  for (const relPath of list.value) {
    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) continue;
    const file = await readFile(resolved.value);
    if (!file.ok) continue;
    const parsed = parseDocument(file.value);
    if (!parsed.ok) continue;

    const fm = parsed.value.frontmatter;
    const staleness = computeStaleness({ updated: fm.updated, ttl_days: fm.ttl_days }, now);
    if (staleness.score >= threshold) {
      stale.push({ path: relPath, title: fm.title, staleness });
    }
  }

  stale.sort((a, b) => b.staleness.score - a.staleness.score);
  return ok(stale);
}
