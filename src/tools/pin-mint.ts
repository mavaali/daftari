// src/tools/pin-mint.ts
// JIT anchor-pin minting (U1, citation-anchors spec, R1/R2/R7).
//
// `mintDescribesPins` enriches shaless `describes` entries of the form
//   [<repo>:]<path>[::symbol]#L<start>[-<end>]
// to
//   [<repo>:]<path>[::symbol]#L<start>-<end>@<sha12>
// using the configured code repo's current working-tree blob id. This is
// purely a read operation — no file in the vault or any code repo is ever
// written to (R7). Any failure for a single entry leaves it byte-identical
// and pushes a reason to `unresolved`; the function never throws (R2).

import { parseDescribesEntry } from "../audit/describes.js";
import { loadConfig } from "../utils/config.js";
import { blobExists, hashObjectFile } from "../utils/git.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MintedEntry {
  /** The original (input) entry string. */
  entry: string;
  /** The rewritten entry with the @sha12 pin appended. */
  pinned: string;
  /** True when the blob is reachable in the odb (was committed); false when
   *  minted from uncommitted working-tree bytes. */
  committed: boolean;
}

export interface UnresolvedEntry {
  /** The original (input) entry string. */
  entry: string;
  /** Human-readable reason the entry could not be minted. */
  reason: string;
}

export interface MintOutcome {
  /** The (possibly enriched) entry array, parallel to the input. */
  entries: string[];
  /** One record per entry that was successfully minted. */
  minted: MintedEntry[];
  /** One record per entry that could not be minted. */
  unresolved: UnresolvedEntry[];
}

// ---------------------------------------------------------------------------
// Shared helper — also exported for U3
// ---------------------------------------------------------------------------

/**
 * Build the minted entry string: `<head>#L<start>-<end>@<sha12>`.
 * `head` is the portion of the entry before any `#L` tail (may include a
 * `::symbol` suffix). `sha` should be exactly 12 hex characters.
 */
export function formatPin(head: string, start: number, end: number, sha: string): string {
  return `${head}#L${start}-${end}@${sha}`;
}

// ---------------------------------------------------------------------------
// Tail regex: end-anchored shaless line-range suffix
// ---------------------------------------------------------------------------

// Matches `#L<start>[-<end>]` at the end of a string — no `@sha` component.
// Applied ONLY when parseDescribesEntry confirmed no existing pin/malformedPin.
const SHALESS_TAIL = /^(.*?)#L(\d+)(?:-(\d+))?$/;

// ---------------------------------------------------------------------------
// mintDescribesPins
// ---------------------------------------------------------------------------

/**
 * Enrich shaless `describes` entries with a working-tree blob sha prefix.
 *
 * For each entry:
 * - If it already has a pin (`@sha` tail) or no `#L` tail → pass through
 *   (not counted in minted or unresolved).
 * - If it has a `#L<start>[-<end>]` tail with no `@sha`:
 *   - Look up `repo` in `cfg.codeRepos`; absent → unresolved ("no configured repo").
 *   - Validate line numbers; end < start → unresolved ("inverted range").
 *   - Call `hashObjectFile`; failure (path absent, repo absent, etc.) → unresolved.
 *   - Rewrite to `<head>#L<start>-<end>@<sha12>`; check blob presence (committed flag).
 *
 * When `jitAnchors === false` the function returns the input array unchanged
 * with empty minted/unresolved lists (kill-switch, R2 advisory posture).
 *
 * This function is pure with respect to the vault and any code repos —
 * no file is written anywhere (R7).
 */
export async function mintDescribesPins(
  vaultRoot: string,
  entries: string[],
): Promise<MintOutcome> {
  const out: string[] = [...entries];
  const minted: MintedEntry[] = [];
  const unresolved: UnresolvedEntry[] = [];

  // Load config; on failure, treat as kill-switch (advisory: never throw).
  let cfg: { codeRepos: Record<string, string>; jitAnchors: boolean };
  try {
    const cfgResult = loadConfig(vaultRoot);
    if (!cfgResult.ok) {
      // Config malformed — no-op, return untouched.
      return { entries: out, minted, unresolved };
    }
    cfg = { codeRepos: cfgResult.value.codeRepos, jitAnchors: cfgResult.value.jitAnchors };
  } catch {
    return { entries: out, minted, unresolved };
  }

  // Kill-switch: jit_anchors: false → return all entries unchanged.
  if (!cfg.jitAnchors) {
    return { entries: out, minted, unresolved };
  }

  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i] as string;

    // Step 1: use parseDescribesEntry (with "" sentinel) to detect existing pins.
    // The "" sentinel means a bare entry would resolve to repo:"" — but we only
    // care about whether pin/malformedPin are set, so the repo resolution is
    // irrelevant here.
    const parsed = parseDescribesEntry(raw, "");

    // Already pinned (pin present) or malformed pin → pass through.
    if (parsed.pin !== undefined || parsed.malformedPin) {
      continue;
    }

    // Check for a shaless #L tail on the raw entry.
    const tailMatch = raw.match(SHALESS_TAIL);
    if (!tailMatch) {
      // No #L tail → bare binding, pass through.
      continue;
    }

    // Extract head (everything before #L) and line numbers.
    const head = tailMatch[1] as string;
    const startRaw = Number.parseInt(tailMatch[2] as string, 10);
    const endRaw =
      tailMatch[3] !== undefined ? Number.parseInt(tailMatch[3] as string, 10) : startRaw;

    // Validate line numbers (invalid line numbers before inverted-range check).
    if (startRaw <= 0 || endRaw <= 0) {
      unresolved.push({
        entry: raw,
        reason: `invalid line numbers: start=${startRaw}, end=${endRaw} (must be >= 1)`,
      });
      continue;
    }
    if (endRaw < startRaw) {
      unresolved.push({
        entry: raw,
        reason: `inverted range: end (${endRaw}) < start (${startRaw})`,
      });
      continue;
    }

    // Resolve repo. Re-parse via parseDescribesEntry to get the repo name and
    // clean path from `head` (the portion before the `#L` tail). `parsed` from
    // step 1 was called on the full `raw` string which has no @sha suffix but
    // still has the `#L<n>` tail, so `parsed.path` includes that tail — it
    // cannot be reused directly for hashing. We pass "" as sourceRepo so bare
    // (unprefixed) entries resolve to "", which is never in codeRepos —
    // matching the candidate filter in read.ts ~line 493-497.
    const parsedHead = parseDescribesEntry(head, "");
    const repoName = parsedHead.repo; // "" for bare entries, or the declared repo prefix

    const repoRoot = cfg.codeRepos[repoName];
    if (repoRoot === undefined) {
      unresolved.push({
        entry: raw,
        reason: `no configured repo for prefix "${repoName}"`,
      });
      continue;
    }

    // Hash the working-tree file (read-only, never -w).
    let sha40: string;
    try {
      const hashResult = await hashObjectFile(repoRoot, parsedHead.path);
      if (!hashResult.ok) {
        unresolved.push({ entry: raw, reason: hashResult.error.message });
        continue;
      }
      sha40 = hashResult.value;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      unresolved.push({ entry: raw, reason });
      continue;
    }

    const sha12 = sha40.slice(0, 12);
    const pinned = formatPin(head, startRaw, endRaw, sha12);

    // Check whether the blob is committed.
    let committed: boolean;
    try {
      committed = await blobExists(repoRoot, sha40);
    } catch {
      committed = false;
    }

    out[i] = pinned;
    minted.push({ entry: raw, pinned, committed });
  }

  return { entries: out, minted, unresolved };
}
