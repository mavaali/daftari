// src/anchors/classify.ts
// The 4-step git-plumbing pin classifier, shared by the read path
// (src/anchors/read.ts), the batch audit (src/audit/checks/pins.ts), and
// vault_lint's Decision-4 softening (src/curation/lint.ts).
//
// Spec: docs/superpowers/specs/2026-07-26-citation-anchors-jit-verification-
// design.md, Decision 2, hardened per the 2026-07-27 plan resolution
// (C5 symlink confinement, C7 CRLF/trivial-content).

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative as nodeRelative, resolve as nodeResolve, sep } from "node:path";
import { DEFAULT_MAX_BYTES, readTextFile } from "../audit/readtext.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { blobSize, catBlob, hashObject } from "../utils/git.js";
import { symlinkSafeExistsWithin } from "../utils/paths.js";
import type { PinSpec } from "./pin.js";

export type AnchorState = "intact" | "moved" | "missing";

export interface AnchorVerdict {
  state: AnchorState;
  relocated?: { start: number; end: number };
}

// A pinned target confined to its repo, realpath-resolved. `relPath` is
// relative to the repo's OWN real root — every subsequent git/fs read
// operates on this confirmed real location, never the literal (possibly
// symlinked) `codeRelPath` the doc wrote.
export interface ConfinedFile {
  absPath: string;
  relPath: string;
}

// Step 1: realpath-based confinement (C5) — a symlink inside the repo
// pointing outside it resolves to null (the classifier's "missing"), and its
// bytes are never read. Cheap: only fs syscalls (realpath, stat), no
// subprocess, so batch callers may run this per-candidate even at the read
// path's pin cap.
export function resolveConfinedFile(repoAbsPath: string, codeRelPath: string): ConfinedFile | null {
  let repoReal: string;
  try {
    repoReal = realpathSync(repoAbsPath);
  } catch {
    return null;
  }
  const targetAbs = nodeResolve(repoAbsPath, codeRelPath);
  if (!symlinkSafeExistsWithin(repoReal, targetAbs)) return null;

  let real: string;
  try {
    real = realpathSync(targetAbs);
  } catch {
    return null;
  }
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }

  const rel = nodeRelative(repoReal, real);
  if (rel.startsWith("..") || isAbsolute(rel)) return null; // defense in depth
  return { absPath: real, relPath: rel.split(sep).join("/") };
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// Steps 2-4, given the file's CURRENT blob hash (from a batch `hashObjects`
// call, or a single `hashObject` call via classifyPin below). Every failure
// mode this function can hit is an EXPECTED degrade the spec names
// explicitly (blob absent from the odb, size over cap, range past the
// pinned blob's last line, substring not found, current file unreadable) —
// each classifies `moved`, never throws, never returns a Result. The only
// genuinely unexpected failure (the hash-object subprocess itself failing)
// happens one layer up, in the batch/single caller.
export async function classifyAgainstHash(
  repoAbsPath: string,
  realFilePath: string,
  pin: PinSpec,
  currentHash: string,
): Promise<AnchorVerdict> {
  // Step 2: pin sha is a prefix of the current blob id -> intact (blob
  // unchanged; every line unchanged).
  if (currentHash.startsWith(pin.sha)) {
    return { state: "intact" };
  }

  // Whole-file pin with a differing blob -> moved (step 4).
  if (pin.start === null || pin.end === null) {
    return { state: "moved" };
  }

  // Step 3: range pin, blob differs. Retrieve the pinned content — gated on
  // size BEFORE the read, mirroring readtext.ts's stat-before-read guard.
  const sizeRes = await blobSize(repoAbsPath, pin.sha);
  if (!sizeRes.ok || sizeRes.value > DEFAULT_MAX_BYTES) {
    return { state: "moved" };
  }
  const blobRes = await catBlob(repoAbsPath, pin.sha);
  if (!blobRes.ok) {
    return { state: "moved" }; // pinned blob absent from the odb
  }

  const pinnedLines = normalizeNewlines(blobRes.value).split("\n");
  if (pin.end > pinnedLines.length) {
    return { state: "moved" }; // range past the pinned blob's last line
  }
  const slice = pinnedLines.slice(pin.start - 1, pin.end).join("\n");

  // C7: below the threshold the claim is unverifiable — classify `moved`
  // (conservative: prompts a re-read rather than asserting freshness).
  const nonWhitespace = slice.replace(/\s/g, "");
  if (nonWhitespace.length < 16) {
    return { state: "moved" };
  }

  const currentRead = await readTextFile(realFilePath);
  if (!currentRead.ok) {
    return { state: "moved" }; // current file unreadable (size/binary/encoding)
  }
  const currentText = normalizeNewlines(currentRead.value.text);

  // C7: CRLF normalization on both sides above; exact-substring search,
  // first occurrence wins (no uniqueness requirement — see C7/C11).
  const idx = currentText.indexOf(slice);
  if (idx === -1) {
    return { state: "moved" };
  }
  const before = currentText.slice(0, idx);
  const startLine = before.split("\n").length;
  const endLine = startLine + slice.split("\n").length - 1;
  return { state: "intact", relocated: { start: startLine, end: endLine } };
}

// The full single-pin classifier: steps 1-4, doing its own confinement and
// hash-object subprocess call. Convenience API for standalone/test use and
// for low-volume callers; batch callers (read.ts, audit/checks/pins.ts,
// lint.ts) call resolveConfinedFile + a shared hashObjects batch +
// classifyAgainstHash directly to pay one subprocess per REPO rather than
// per pin (C1).
export async function classifyPin(
  repoAbsPath: string,
  codeRelPath: string,
  pin: PinSpec,
): Promise<Result<AnchorVerdict, Error>> {
  const confined = resolveConfinedFile(repoAbsPath, codeRelPath);
  if (confined === null) {
    return ok({ state: "missing" });
  }
  const hashRes = await hashObject(repoAbsPath, confined.relPath);
  if (!hashRes.ok) return err(hashRes.error);
  const verdict = await classifyAgainstHash(repoAbsPath, confined.absPath, pin, hashRes.value);
  return ok(verdict);
}
