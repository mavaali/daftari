// src/tools/anchors.ts
// Pin classifier for JIT anchors (citation-anchors spec, Decision 2). Given one
// pinned `describes` binding and the code repo it resolves to, classify the pin
// against the current working tree using local git plumbing only — no network,
// no LLM. The read path attaches the result as an advisory annotation; nothing
// here mutates any file or state.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { DescribesPin } from "../audit/describes.js";
import { readTextFile } from "../audit/readtext.js";
import { catFileBlob, hashObjectFile } from "../utils/git.js";

export type AnchorState = "intact" | "moved" | "missing";

export interface AnchorClassification {
  state: AnchorState;
  // Present only for an `intact` classification reached via content relocation
  // (step 3): the 1-based line range where the pinned content now lives.
  relocated?: { start: number; end: number };
}

// Classify one pin against `repoRoot`'s working tree. Returns null — meaning
// "cannot classify, skip this binding" — when the file exists but a git or read
// helper fails; the caller degrades a null to absent (no annotation entry),
// never surfacing a false state. `missing` and `moved` ARE classifications and
// are returned as such.
export async function classifyPin(
  repoRoot: string,
  relPath: string,
  pin: DescribesPin,
): Promise<AnchorClassification | null> {
  const absPath = join(repoRoot, relPath);

  // Step 1 — target path absent from the working tree → missing.
  try {
    const st = await stat(absPath);
    if (!st.isFile()) return { state: "missing" };
  } catch {
    return { state: "missing" };
  }

  // Step 2 — current working-tree blob id; a pin-sha prefix match → intact
  // (blob unchanged since the pin was written). A git failure on a file that
  // exists is not a classification — skip.
  const current = await hashObjectFile(repoRoot, relPath);
  if (!current.ok) return null;
  if (current.value.startsWith(pin.sha)) return { state: "intact" };

  // Blob differs from here on.

  // Step 4 short-circuit — a whole-file pin (no range) over a differing blob is
  // moved; there is no pinned line span to search for.
  if (pin.start === null || pin.end === null) return { state: "moved" };

  // Step 3 — retrieve the pinned content and search the current file for it.
  const pinnedBlob = await catFileBlob(repoRoot, pin.sha);
  if (!pinnedBlob.ok) return { state: "moved" }; // blob not in odb → moved

  // 1-based inclusive line slice of the pinned content.
  const pinnedLines = pinnedBlob.value.split("\n");
  const block = pinnedLines.slice(pin.start - 1, pin.end).join("\n");
  if (block.length === 0) return { state: "moved" }; // range past the pinned content

  const currentText = await readTextFile(absPath);
  if (!currentText.ok) return null; // guarded read rejected (too large / binary) → skip

  const idx = currentText.value.text.indexOf(block);
  if (idx === -1) return { state: "moved" };

  // Relocated line numbers: complete lines before the match = count of newlines
  // in the preceding slice; the new 1-based start is that count + 1.
  const newStart = (currentText.value.text.slice(0, idx).match(/\n/g)?.length ?? 0) + 1;
  const span = pin.end - pin.start;
  return { state: "intact", relocated: { start: newStart, end: newStart + span } };
}
