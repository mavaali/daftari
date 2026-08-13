// src/tools/repin.ts
// JIT anchor re-pin (U3, citation-anchors spec, R4/R5).
//
// `computeRepin` reads a vault doc, classifies its pinned `describes` entries
// against their configured code repos (same candidate filter + 24-cap as
// `computeAnchors` in read.ts), and returns a `RepinPlan`:
//
//   - replacements — for each entry classified intact-via-relocation: the old
//     raw pin string and the new one (updated range + current sha12).
//   - skipped     — entries that cannot be re-pinned (moved, missing, plain
//     intact, classifier-null) along with a reason state string.
//
// Doc-level failures (unreadable doc, config load failure) return err.
// Per-entry problems never throw — they degrade to `skipped`.
//
// This is a read-only function; no vault or code-repo file is ever written.

import { parseDescribesEntry } from "../audit/describes.js";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import { loadConfig } from "../utils/config.js";
import { hashObjectFile } from "../utils/git.js";
import { classifyPin } from "./anchors.js";
import { formatPin } from "./pin-mint.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RepinReplacement {
  /** The raw `describes` entry string as written in the doc. */
  old: string;
  /** The rewritten entry with the updated #Lx-y@sha12 pin. */
  new: string;
}

export interface RepinSkipped {
  /** The raw `describes` entry string. */
  entry: string;
  /** Why this entry was not re-pinned: "moved", "missing", or "null" (classifier gave null). */
  state: string;
}

export interface RepinPlan {
  /** One record per entry whose pin was relocated and can be rewritten. */
  replacements: RepinReplacement[];
  /** One record per candidate entry that was examined but not re-pinned. */
  skipped: RepinSkipped[];
}

// Cap matching computeAnchors in read.ts.
const ANCHOR_PIN_CAP = 24;

// ---------------------------------------------------------------------------
// computeRepin
// ---------------------------------------------------------------------------

/**
 * Classify a doc's pinned `describes` entries and build a replacement plan for
 * any whose pinned block has relocated (intact-via-relocation).
 *
 * @param vaultRoot - Absolute path to the vault root.
 * @param docRelPath - Vault-relative path to the document.
 * @returns ok(RepinPlan) on success; err on doc-level failure only.
 */
export async function computeRepin(
  vaultRoot: string,
  docRelPath: string,
): Promise<Result<RepinPlan, Error>> {
  // --- Load config (doc-level failure) -------------------------------------
  const cfgResult = loadConfig(vaultRoot);
  if (!cfgResult.ok) {
    return err(new Error(`computeRepin: config load failed: ${cfgResult.error.message}`));
  }
  const cfg = cfgResult.value;

  // Kill-switch: jit_anchors:false → no candidates, return an empty plan.
  // Not an error — just nothing to do.
  if (!cfg.jitAnchors) {
    return ok({ replacements: [], skipped: [] });
  }

  // --- Read + parse the doc (doc-level failure) ----------------------------
  const resolved = resolveVaultPath(vaultRoot, docRelPath);
  if (!resolved.ok) {
    return err(new Error(`computeRepin: invalid path: ${resolved.error.message}`));
  }

  const fileResult = await readFile(resolved.value.absPath);
  if (!fileResult.ok) {
    return err(new Error(`computeRepin: cannot read doc: ${fileResult.error.message}`));
  }

  const parsedResult = parseDocument(fileResult.value);
  if (!parsedResult.ok) {
    return err(new Error(`computeRepin: cannot parse doc: ${parsedResult.error.message}`));
  }

  const describes = parsedResult.value.frontmatter.describes ?? [];
  const codeRepos = cfg.codeRepos;

  // --- Candidate filter (mirrors computeAnchors exactly) -------------------
  // "" sentinel: bare (prefix-less) entries resolve to "", which is never a
  // configured code-repo key, so they are silently excluded.
  const candidates = describes
    .map((raw) => ({ raw, parsed: parseDescribesEntry(raw, "") }))
    .filter((c) => c.parsed.pin !== undefined && codeRepos[c.parsed.repo] !== undefined);

  if (candidates.length === 0) {
    return ok({ replacements: [], skipped: [] });
  }

  const checkedList = candidates.slice(0, ANCHOR_PIN_CAP);

  // --- Per-entry classification --------------------------------------------
  const replacements: RepinReplacement[] = [];
  const skipped: RepinSkipped[] = [];

  for (const { raw, parsed } of checkedList) {
    // parsed.pin is guaranteed non-undefined by the candidate filter.
    const pin = parsed.pin!;
    const repoRoot = codeRepos[parsed.repo] as string;

    // Classify the pin (per-entry failure degrades to skipped).
    let cls: Awaited<ReturnType<typeof classifyPin>>;
    try {
      cls = await classifyPin(repoRoot, parsed.path, pin);
    } catch {
      skipped.push({ entry: raw, state: "null" });
      continue;
    }

    if (cls === null) {
      // Classifier could not determine state (git/read helper failed on a present file).
      skipped.push({ entry: raw, state: "null" });
      continue;
    }

    if (cls.state === "moved") {
      skipped.push({ entry: raw, state: "moved" });
      continue;
    }

    if (cls.state === "missing") {
      skipped.push({ entry: raw, state: "missing" });
      continue;
    }

    // cls.state === "intact"
    if (!cls.relocated) {
      // Plain intact: nothing to do, not a problem — skip silently.
      // `skipped` is for entries that COULD NOT be re-pinned; plain-intact
      // pins are healthy as-is and do not belong there.
      continue;
    }

    // intact-via-relocation: build the replacement.
    // The head is the portion of the raw entry before any `#L` tail (including
    // any `repo:` prefix and `::symbol`). We derive it by stripping the old
    // pin suffix from the raw string.
    //
    // The raw string has the form: <head>#L<start>-<end>@<sha>
    // parseDescribesEntry already stripped the pin suffix from `head`: we can
    // reconstruct the head by parsing the raw string and taking everything
    // before the pin's #L tail.
    //
    // We need the head WITHOUT the #L part — same as formatPin expects.
    // Strategy: slice off the `@<sha>` suffix first (the pin match is end-
    // anchored), then slice off the `#L<start>-<end>` or `#L<start>` part.
    const pinSuffixPattern = /(?:#L\d+(?:-\d+)?)?@[0-9a-f]{7,40}$/;
    const headWithHash = raw.replace(pinSuffixPattern, "");
    // headWithHash is `<head>#L<start>[-end]` (the part before @sha).
    // Strip the trailing `#L<n>[-<n>]` to get the pure head formatPin wants.
    const head = headWithHash.replace(/#L\d+(?:-\d+)?$/, "");

    // Compute the CURRENT sha12 for the file (R5: against the working tree).
    let currentSha12: string;
    try {
      const hashResult = await hashObjectFile(repoRoot, parsed.path);
      if (!hashResult.ok) {
        skipped.push({ entry: raw, state: "null" });
        continue;
      }
      currentSha12 = hashResult.value.slice(0, 12);
    } catch {
      skipped.push({ entry: raw, state: "null" });
      continue;
    }

    const newPin = formatPin(head, cls.relocated.start, cls.relocated.end, currentSha12);
    replacements.push({ old: raw, new: newPin });
  }

  return ok({ replacements, skipped });
}
