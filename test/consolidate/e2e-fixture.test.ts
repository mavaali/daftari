import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConsolidate } from "../../src/consolidate/index.js";
import { docContentHash, writeConsolidateState } from "../../src/consolidate/state.js";
import { observeEdge } from "../../src/curation/edges.js";
import { commit, log as gitLog } from "../../src/utils/git.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daftari-e2e-"));
  mkdirSync(join(dir, ".daftari"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("consolidate e2e (Stage 1 gate)", () => {
  it("event clock marks the dependent of a changed premise due", async () => {
    const derivedBody = "# derived\n";
    writeFileSync(join(dir, "premise.md"), "# premise\n");
    writeFileSync(join(dir, "derived.md"), derivedBody);
    const first = await commit(dir, ["."], "init", "agent:test");
    expect(first.ok).toBe(true);
    const firstLog = await gitLog(dir, { limit: 1 });
    const firstSha = firstLog.ok ? (firstLog.value[0]?.hash ?? "") : "";
    expect(firstSha).not.toBe("");

    // Seed a trigger-bearing edge: derived derives_from premise. `at` ~1 min ago
    // (fresh on any run date → strength≈1, not decay/backstop-due), distinct
    // (observer, axis) pairs so the second observe counts as a vote (k→1).
    const at = new Date(Date.now() - 60_000).toISOString();
    const seed = await observeEdge(dir, {
      fromPath: "derived.md",
      toPath: "premise.md",
      observedBy: "model-a",
      blind: true,
      axis: "model",
      at,
    });
    expect(seed.ok).toBe(true);
    const vote = await observeEdge(dir, {
      fromPath: "derived.md",
      toPath: "premise.md",
      observedBy: "model-b",
      blind: true,
      axis: "prompt",
      at,
    });
    expect(vote.ok).toBe(true);

    // Baseline = the FIRST commit; pre-mark derived.md birth-processed so its
    // appearance in the queue can ONLY come from the event clock, not birth.
    writeConsolidateState(dir, {
      lastConsolidationCommit: firstSha,
      birthProcessed: { "derived.md": docContentHash(derivedBody) },
    });

    // Change the premise and commit → changedSince(firstSha) = [premise.md].
    writeFileSync(join(dir, "premise.md"), "# premise v2\n");
    await commit(dir, ["."], "edit premise", "agent:test");

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    const code = await runConsolidate(["--vault", dir]);

    expect([0, 4]).toContain(code);
    const text = out.join("");
    // derived.md is due via the EVENT clock (it derives from the changed premise),
    // tagged [.../event], and NOT in the birth queue (pre-marked processed).
    expect(text).toMatch(/\[(main|periphery|backstop)\/event\] derived\.md/);
  });

  it("joins a NON-canonical edge premise path against the canonical changed path (alias guard)", async () => {
    const derivedBody = "# derived\n";
    writeFileSync(join(dir, "premise.md"), "# premise\n");
    writeFileSync(join(dir, "derived.md"), derivedBody);
    await commit(dir, ["."], "init", "agent:test");
    const firstLog = await gitLog(dir, { limit: 1 });
    const firstSha = firstLog.ok ? (firstLog.value[0]?.hash ?? "") : "";

    // Observe the edge with a NON-canonical premise path ("./premise.md"). The
    // store keeps it verbatim (trim-only); git-diff reports the canonical
    // "premise.md". Without boundary canonicalization the join silently misses.
    const at = new Date(Date.now() - 60_000).toISOString();
    await observeEdge(dir, {
      fromPath: "derived.md",
      toPath: "./premise.md",
      observedBy: "model-a",
      blind: true,
      axis: "model",
      at,
    });
    await observeEdge(dir, {
      fromPath: "derived.md",
      toPath: "./premise.md",
      observedBy: "model-b",
      blind: true,
      axis: "prompt",
      at,
    });

    writeConsolidateState(dir, {
      lastConsolidationCommit: firstSha,
      birthProcessed: { "derived.md": docContentHash(derivedBody) },
    });
    writeFileSync(join(dir, "premise.md"), "# premise v2\n");
    await commit(dir, ["."], "edit premise", "agent:test");

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    const code = await runConsolidate(["--vault", dir]);
    expect([0, 4]).toContain(code);
    expect(out.join("")).toMatch(/\[(main|periphery|backstop)\/event\] derived\.md/);
  });
});
