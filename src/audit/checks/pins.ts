// src/audit/checks/pins.ts
// Batch pin classification for `daftari audit` (2026-07-26 citation-anchors-
// jit spec, Decision 3). Reuses the read path's classifier
// (src/anchors/classify.ts) and its batching primitive (C1): candidates are
// grouped by target repo so the all-intact case costs one `git hash-object`
// invocation per repo, not one per pinned binding.

import { classifyAgainstHash, resolveConfinedFile } from "../../anchors/classify.js";
import type { PinSpec } from "../../anchors/pin.js";
import { hashObjects } from "../../utils/git.js";
import type { DescribesEdge, PinFinding, PinState, RepoSnapshot } from "../types.js";

function mk(
  e: DescribesEdge,
  verdict: { state: PinState; relocated?: { start: number; end: number } },
): PinFinding {
  return {
    source: { repo: e.sourceRepo, path: e.sourcePath },
    target: { repo: e.targetRepo, path: e.targetPath },
    raw: e.raw,
    state: verdict.state,
    ...(verdict.relocated ? { relocated: verdict.relocated } : {}),
  };
}

// Classifies every pinned edge against the audit's own repo snapshots (the
// registry DescribesEdge targets resolve against — unchanged by the
// registry cross-check in index.ts, which only WARNS about a divergence). An
// edge whose target repo isn't in the snapshot set at all (already a
// `broken_describes` finding from checkDescribesRefs) classifies `missing`
// here too, for a consistent pin-totals story.
export async function checkPins(
  snapshots: RepoSnapshot[],
  edges: DescribesEdge[],
): Promise<PinFinding[]> {
  const byRepo = new Map<string, RepoSnapshot>();
  for (const s of snapshots) byRepo.set(s.config.name, s);

  const pinned = edges.filter((e): e is DescribesEdge & { pin: PinSpec } => e.pin !== null);
  if (pinned.length === 0) return [];

  const byTargetRepo = new Map<string, Array<DescribesEdge & { pin: PinSpec }>>();
  for (const e of pinned) {
    const list = byTargetRepo.get(e.targetRepo) ?? [];
    list.push(e);
    byTargetRepo.set(e.targetRepo, list);
  }

  const findings: PinFinding[] = [];
  for (const [repoName, repoEdges] of byTargetRepo) {
    const snap = byRepo.get(repoName);
    if (!snap) {
      for (const e of repoEdges) findings.push(mk(e, { state: "missing" }));
      continue;
    }
    const repoAbsPath = snap.config.path;

    const resolved = repoEdges.map((e) => ({
      e,
      confined: resolveConfinedFile(repoAbsPath, e.targetPath),
    }));
    for (const r of resolved) {
      if (r.confined === null) findings.push(mk(r.e, { state: "missing" }));
    }
    const survivors = resolved.filter(
      (r): r is { e: (typeof repoEdges)[number]; confined: NonNullable<(typeof r)["confined"]> } =>
        r.confined !== null,
    );
    if (survivors.length === 0) continue;

    const hashRes = await hashObjects(
      repoAbsPath,
      survivors.map((s) => s.confined.relPath),
    );
    if (!hashRes.ok) {
      // A whole-batch subprocess failure is rare (missing git binary, a
      // corrupted odb) — the audit has no separate "errored" bucket per
      // pin, so this degrades conservatively to `moved` (a prompt, not a
      // silently-dropped finding) rather than being omitted from the report.
      for (const s of survivors) findings.push(mk(s.e, { state: "moved" }));
      continue;
    }
    const hashes = hashRes.value;

    for (let i = 0; i < survivors.length; i++) {
      const s = survivors[i] as (typeof survivors)[number];
      const currentHash = hashes[i] as string;
      const pin = s.e.pin;
      if (currentHash.startsWith(pin.sha)) {
        findings.push(mk(s.e, { state: "intact" }));
        continue;
      }
      if (pin.start === null || pin.end === null) {
        findings.push(mk(s.e, { state: "moved" }));
        continue;
      }
      const verdict = await classifyAgainstHash(repoAbsPath, s.confined.absPath, pin, currentHash);
      findings.push(mk(s.e, verdict));
    }
  }
  return findings;
}
