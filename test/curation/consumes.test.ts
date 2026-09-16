import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConsumesEdge,
  compiledEdgeCoverageSummary,
  currentConsumesEdges,
  forwardConsumes,
  listConsumesEdges,
  mintConsumesEdges,
  reverseConsumes,
} from "../../src/curation/consumes.js";
import { recordRead } from "../../src/curation/read-log.js";

describe("consumes graph (#233)", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-consumes-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("mints one typed edge per unique read, excluding the artifact itself", async () => {
    await recordRead(vault, { tool: "vault_read", file: "pricing/a.md", run_id: "run-1" });
    await recordRead(vault, { tool: "vault_read", file: "pricing/b.md", run_id: "run-1" });
    await recordRead(vault, { tool: "vault_read", file: "pricing/a.md", run_id: "run-1" });
    // A read-modify-write is not a self-dependency.
    await recordRead(vault, { tool: "vault_read", file: "pricing/out.md", run_id: "run-1" });

    const minted = await mintConsumesEdges(vault, { artifact: "pricing/out.md", runId: "run-1" });
    expect(minted.ok && minted.value.minted).toBe(2);

    const all = await listConsumesEdges(vault);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.map((e) => e.unit).sort()).toEqual(["pricing/a.md", "pricing/b.md"]);
    for (const e of all.value) {
      expect(e.artifact).toBe("pricing/out.md");
      expect(e.edge_type).toBe("whole-doc-read");
      expect(e.fields).toEqual(["*"]);
      expect(e.run_id).toBe("run-1");
      expect(e.compile_ts).toBeTruthy();
    }
  });

  it("a run that read nothing mints nothing", async () => {
    const minted = await mintConsumesEdges(vault, { artifact: "pricing/out.md", runId: "run-9" });
    expect(minted.ok && minted.value.minted).toBe(0);
    const all = await listConsumesEdges(vault);
    expect(all.ok && all.value).toEqual([]);
  });

  it("current-compile collapse: the newest compile group supersedes, history survives", async () => {
    await recordRead(vault, { tool: "vault_read", file: "pricing/a.md", run_id: "run-1" });
    await mintConsumesEdges(vault, {
      artifact: "pricing/out.md",
      runId: "run-1",
      timestamp: "2026-07-01T00:00:00.000Z",
    });
    await recordRead(vault, { tool: "vault_read", file: "pricing/b.md", run_id: "run-2" });
    await mintConsumesEdges(vault, {
      artifact: "pricing/out.md",
      runId: "run-2",
      timestamp: "2026-07-02T00:00:00.000Z",
    });

    const all = await listConsumesEdges(vault);
    if (!all.ok) throw all.error;
    // Append-only: both compile groups are in the log.
    expect(all.value).toHaveLength(2);

    // Derived supersession: current = the newest group only.
    const current = currentConsumesEdges(all.value);
    expect(current).toHaveLength(1);
    expect(current[0]?.unit).toBe("pricing/b.md");
    expect(current[0]?.run_id).toBe("run-2");
  });

  it("forward and reverse queries walk the current compile", async () => {
    await recordRead(vault, { tool: "vault_read", file: "pricing/shared.md", run_id: "run-1" });
    await mintConsumesEdges(vault, { artifact: "pricing/x.md", runId: "run-1" });
    await recordRead(vault, { tool: "vault_read", file: "pricing/shared.md", run_id: "run-2" });
    await mintConsumesEdges(vault, { artifact: "pricing/y.md", runId: "run-2" });

    const all = await listConsumesEdges(vault);
    if (!all.ok) throw all.error;

    expect(forwardConsumes(all.value, "pricing/x.md").map((e: ConsumesEdge) => e.unit)).toEqual([
      "pricing/shared.md",
    ]);
    expect(
      reverseConsumes(all.value, "pricing/shared.md")
        .map((e: ConsumesEdge) => e.artifact)
        .sort(),
    ).toEqual(["pricing/x.md", "pricing/y.md"]);
    expect(reverseConsumes(all.value, "pricing/unrelated.md")).toEqual([]);
  });

  it("distinguishes no compiled-edge data from partial and complete observation", () => {
    const docs = ["pricing/a.md", "pricing/b.md"];
    expect(compiledEdgeCoverageSummary(docs, [])).toEqual({
      status: "no-data",
      total_documents: 2,
      instrumented_documents: 0,
      uninstrumented_documents: 2,
      message: "no compiled-edge data (2 docs uninstrumented)",
    });

    const edge = (artifact: string, unit: string, compile_ts: string): ConsumesEdge => ({
      artifact,
      unit,
      edge_type: "whole-doc-read",
      fields: ["*"],
      run_id: compile_ts,
      compile_ts,
    });
    expect(
      compiledEdgeCoverageSummary(docs, [
        edge("pricing/a.md", "pricing/source.md", "2026-01-01T00:00:00Z"),
      ]),
    ).toMatchObject({
      status: "partial",
      instrumented_documents: 1,
      uninstrumented_documents: 1,
    });
    expect(
      compiledEdgeCoverageSummary(docs, [
        edge("pricing/a.md", "pricing/source.md", "2026-01-01T00:00:00Z"),
        edge("pricing/b.md", "pricing/source.md", "2026-01-02T00:00:00Z"),
      ]),
    ).toMatchObject({
      status: "complete",
      instrumented_documents: 2,
      uninstrumented_documents: 0,
    });
  });
});
