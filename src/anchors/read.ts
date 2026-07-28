// src/anchors/read.ts
// vault_read integration: repo resolution, batching, the pin cap, and the
// drift banner. Spec: docs/superpowers/specs/2026-07-26-citation-anchors-
// jit-verification-design.md, Decision 2, batched per the 2026-07-27 plan
// resolution (C1).
//
// Cost posture: candidates are grouped by repo; step 1 (existence +
// confinement) is fs-syscall-only per candidate; step 2 (current blob hash)
// is ONE `git hash-object` batch invocation per repo, answering every
// candidate in that repo at once — the all-intact path (the common case)
// therefore costs one subprocess per referenced repo per read, not one per
// pin. Only candidates whose blob differs AND carry a range go on to step 3
// (git cat-file + a bounded text read), run with a small bounded
// concurrency so a doc with many drifted range pins can't serialize the
// read behind N sequential git spawns.

import { existsSync, statSync } from "node:fs";
import { parseDescribesEntry } from "../audit/describes.js";
import { hashObjects } from "../utils/git.js";
import { type AnchorState, classifyAgainstHash, resolveConfinedFile } from "./classify.js";
import { type PinSpec, splitPin } from "./pin.js";

export const MAX_PINS_PER_READ = 24;
const STEP3_CONCURRENCY = 4;

export interface AnchorEntry {
  raw: string;
  repo: string;
  path: string;
  symbol: string | null;
  pin: { start: number | null; end: number | null; sha: string };
  state: AnchorState;
  relocated?: { start: number; end: number };
}

export interface AnchorsAnnotation {
  entries: AnchorEntry[];
  checked: number;
  skipped: number;
  // Classifier failures (a repo's whole hashObjects batch call erroring) —
  // dropped from `entries`, counted here so the "all intact" softening never
  // quantifies over a silently-censored sample (C8).
  errored: number;
  banner: string | null;
}

interface Candidate {
  idx: number; // original position in `describes`, for stable output order
  raw: string;
  repo: string;
  path: string;
  symbol: string | null;
  pin: PinSpec;
}

// A bare (prefix-less) binding resolves to "the doc's own repo" in the
// audit; on the read path that is the vault itself, never a code repo, so it
// is never JIT-checked. Passing this sentinel as parseDescribesEntry's
// `sourceRepo` lets us detect the bare case (parsed.repo === sentinel) without
// duplicating the grammar's `::`/`:` split logic here.
const NO_PREFIX_SENTINEL = "";

function selectCandidates(describes: string[], codeRepos: Record<string, string>): Candidate[] {
  const repoDirExists = new Map<string, boolean>();
  const out: Candidate[] = [];
  describes.forEach((raw, idx) => {
    const { binding, pin } = splitPin(raw);
    if (!pin) return;
    const parsed = parseDescribesEntry(binding, NO_PREFIX_SENTINEL);
    if (parsed.repo === NO_PREFIX_SENTINEL) return; // bare binding, not JIT-checked
    if (!(parsed.repo in codeRepos)) return;
    if (!repoDirExists.has(parsed.repo)) {
      const repoPath = codeRepos[parsed.repo] as string;
      let exists = false;
      try {
        exists = existsSync(repoPath) && statSync(repoPath).isDirectory();
      } catch {
        exists = false;
      }
      repoDirExists.set(parsed.repo, exists);
    }
    if (!repoDirExists.get(parsed.repo)) return;
    out.push({ idx, raw, repo: parsed.repo, path: parsed.path, symbol: parsed.symbol, pin });
  });
  return out;
}

function makeEntry(
  c: Candidate,
  verdict: { state: AnchorState; relocated?: { start: number; end: number } },
): AnchorEntry {
  return {
    raw: c.raw,
    repo: c.repo,
    path: c.path,
    symbol: c.symbol,
    pin: { start: c.pin.start, end: c.pin.end, sha: c.pin.sha },
    state: verdict.state,
    ...(verdict.relocated ? { relocated: verdict.relocated } : {}),
  };
}

// Runs `tasks` with at most `limit` in flight at once. Every task here is
// infallible (classifyAgainstHash never throws/rejects — every failure mode
// degrades to a specific AnchorState), so this has no error-collection
// machinery; it exists purely to bound concurrency.
async function runBounded(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const task = tasks[next++];
      if (task) await task();
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, () =>
    worker(),
  );
  await Promise.allSettled(workers);
}

// Candidate selection: valid pin AND explicit repo prefix AND prefix in
// `codeRepos` AND repo dir exists. Zero candidates -> null (byte-identical
// to "nothing to say", the read path's silent-baseline contract).
export async function computeAnchors(
  describes: string[],
  codeRepos: Record<string, string>,
): Promise<AnchorsAnnotation | null> {
  const candidates = selectCandidates(describes, codeRepos);
  if (candidates.length === 0) return null;

  const capped = candidates.slice(0, MAX_PINS_PER_READ);
  const skipped = candidates.length - capped.length;

  const byRepo = new Map<string, Candidate[]>();
  for (const c of capped) {
    const list = byRepo.get(c.repo) ?? [];
    list.push(c);
    byRepo.set(c.repo, list);
  }

  const out: Array<{ idx: number; entry: AnchorEntry }> = [];
  let errored = 0;

  for (const [repoName, repoCandidates] of byRepo) {
    const repoAbsPath = codeRepos[repoName] as string;

    // Step 1: cheap, per-candidate, no subprocess.
    const resolved = repoCandidates.map((c) => ({
      c,
      confined: resolveConfinedFile(repoAbsPath, c.path),
    }));
    for (const r of resolved) {
      if (r.confined === null) {
        out.push({ idx: r.c.idx, entry: makeEntry(r.c, { state: "missing" }) });
      }
    }
    const survivors = resolved.filter(
      (r): r is { c: Candidate; confined: NonNullable<(typeof r)["confined"]> } =>
        r.confined !== null,
    );
    if (survivors.length === 0) continue;

    // Step 2: ONE hash-object batch call per repo.
    const hashRes = await hashObjects(
      repoAbsPath,
      survivors.map((s) => s.confined.relPath),
    );
    if (!hashRes.ok) {
      errored += survivors.length;
      continue;
    }
    const hashes = hashRes.value;

    const step3: Array<() => Promise<void>> = [];
    survivors.forEach((s, i) => {
      const currentHash = hashes[i] as string;
      if (currentHash.startsWith(s.c.pin.sha)) {
        out.push({ idx: s.c.idx, entry: makeEntry(s.c, { state: "intact" }) });
        return;
      }
      if (s.c.pin.start === null || s.c.pin.end === null) {
        out.push({ idx: s.c.idx, entry: makeEntry(s.c, { state: "moved" }) });
        return;
      }
      step3.push(async () => {
        const verdict = await classifyAgainstHash(
          repoAbsPath,
          s.confined.absPath,
          s.c.pin,
          currentHash,
        );
        out.push({ idx: s.c.idx, entry: makeEntry(s.c, verdict) });
      });
    });
    await runBounded(step3, STEP3_CONCURRENCY);
  }

  out.sort((a, b) => a.idx - b.idx);
  const entries = out.map((o) => o.entry);

  const movedOrMissing = entries.filter((e) => e.state === "moved" || e.state === "missing").length;
  const banner =
    movedOrMissing > 0
      ? `⚠ CODE DRIFT — ${movedOrMissing} of ${capped.length} code pin(s) on this document report ` +
        "moved or missing. The code this document describes has changed since the pins were " +
        "written; re-read the code before relying on this document's account of it."
      : null;

  return { entries, checked: capped.length, skipped, errored, banner };
}
