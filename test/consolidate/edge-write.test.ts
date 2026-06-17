// Shadow-aware edge_observe / edge_contest factories (brief item 5).
// Live mode → writes to .daftari/edges.jsonl. Shadow mode → writes ONLY to
// .daftari/shadow-actions.jsonl; the edge store is untouched.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeContest, makeObserve } from "../../src/consolidate/edge-write.js";
import { edgesPath, listEdges } from "../../src/curation/edges.js";
import { listShadowActions } from "../../src/curation/shadow.js";

function tmpVault(): string {
  const root = join(
    tmpdir(),
    `daftari-edgewrite-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".daftari"), { recursive: true });
  // recordShadowAction needs loadDocuments to succeed; seed two trivial docs
  // so the blast computation has something to walk.
  writeFileSync(
    join(root, "a.md"),
    "---\ntitle: A\ncollection: c\nstatus: draft\nconfidence: medium\ncreated: 2026-05-01\nprovenance: direct\nsources: []\nsuperseded_by: null\nttl_days: 90\ntags: []\n---\n# A\n",
  );
  writeFileSync(
    join(root, "b.md"),
    "---\ntitle: B\ncollection: c\nstatus: draft\nconfidence: medium\ncreated: 2026-05-01\nprovenance: direct\nsources: []\nsuperseded_by: null\nttl_days: 90\ntags: []\n---\n# B\n",
  );
  return root;
}

function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

describe("makeObserve — live mode", () => {
  it("calls observeEdge: writes a record to edges.jsonl, returns the collapsed edge", async () => {
    const root = tmpVault();
    try {
      const observe = makeObserve({ vaultRoot: root, shadowMode: false });
      const r = await observe({
        fromPath: "a.md",
        toPath: "b.md",
        observedBy: "agent:test",
        blind: true,
        axis: "prompt",
      });
      expect(r.ok).toBe(true);
      expect(existsSync(edgesPath(root))).toBe(true);
      const edges = await listEdges(root, {}, new Date());
      expect(edges.ok).toBe(true);
      if (!edges.ok) throw edges.error;
      expect(edges.value.length).toBe(1);
      expect(edges.value[0].fromPath).toBe("a.md");
    } finally {
      cleanup(root);
    }
  });
});

describe("makeObserve — shadow mode", () => {
  it("does NOT write to edges.jsonl; writes ONE record to shadow-actions.jsonl", async () => {
    const root = tmpVault();
    try {
      const observe = makeObserve({
        vaultRoot: root,
        shadowMode: true,
        principal: "agent:curation-loop",
      });
      const r = await observe({
        fromPath: "a.md",
        toPath: "b.md",
        observedBy: "agent:curation-loop",
        blind: true,
        axis: "prompt",
        note: "birth/forward: A derives from B",
      });
      expect(r.ok).toBe(true);
      // The edge store is untouched — the calibration data lands in the
      // shadow log alone.
      expect(existsSync(edgesPath(root))).toBe(false);
      const shadow = await listShadowActions(root);
      expect(shadow.ok).toBe(true);
      if (!shadow.ok) throw shadow.error;
      expect(shadow.value.length).toBe(1);
      const rec = shadow.value[0];
      expect(rec.tool).toBe("vault_edge_observe");
      expect(rec.action).toBe("edge-observe");
      expect(rec.target_path).toBe("a.md");
      expect(rec.touched_paths).toEqual(["a.md", "b.md"]);
      expect(rec.agent).toBe("agent:curation-loop");
      expect(rec.principal).toBe("agent:curation-loop");
      // i_base for edge-observe is the lowest tier in SHADOW_I_BASE — sanity.
      expect(rec.i_base).toBe(0.05);
    } finally {
      cleanup(root);
    }
  });

  it("the returned stub edge has the candidate status (the loop's success branch keys on `ok`, not the row contents)", async () => {
    const root = tmpVault();
    try {
      const observe = makeObserve({ vaultRoot: root, shadowMode: true });
      const r = await observe({
        fromPath: "a.md",
        toPath: "b.md",
        observedBy: "agent:test",
        blind: true,
        axis: "prompt",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(r.value.status).toBe("candidate");
      expect(r.value.kSurvived).toBe(0);
      expect(r.value.contestedAt).toBe(null);
    } finally {
      cleanup(root);
    }
  });
});

describe("makeContest — live mode", () => {
  it("calls contestEdge after a seeded observation: shadow log empty, edge revoked", async () => {
    const root = tmpVault();
    try {
      // Seed an edge live so contest has something to revoke.
      const observe = makeObserve({ vaultRoot: root, shadowMode: false });
      const obs = await observe({
        fromPath: "a.md",
        toPath: "b.md",
        observedBy: "agent:test",
        blind: true,
        axis: "prompt",
      });
      if (!obs.ok) throw obs.error;

      const contest = makeContest({ vaultRoot: root, shadowMode: false });
      const r = await contest({
        fromPath: "a.md",
        toPath: "b.md",
        contestedBy: "agent:test",
        reason: "re-derivation failed: premise reformulated",
      });
      expect(r.ok).toBe(true);
      const edges = await listEdges(root, {}, new Date());
      if (!edges.ok) throw edges.error;
      expect(edges.value[0].status).toBe("revoked");
      // shadow-actions.jsonl was never created.
      const shadow = await listShadowActions(root);
      if (!shadow.ok) throw shadow.error;
      expect(shadow.value.length).toBe(0);
    } finally {
      cleanup(root);
    }
  });
});

describe("makeContest — shadow mode", () => {
  it("does NOT mutate the edge store; writes ONE edge-contest record", async () => {
    const root = tmpVault();
    try {
      const contest = makeContest({
        vaultRoot: root,
        shadowMode: true,
        principal: "agent:curation-loop",
      });
      const r = await contest({
        fromPath: "a.md",
        toPath: "b.md",
        contestedBy: "agent:curation-loop",
        reason: "no longer derivable",
      });
      expect(r.ok).toBe(true);
      // No live edge writes happened, so listEdges sees zero (empty store).
      expect(existsSync(edgesPath(root))).toBe(false);
      const shadow = await listShadowActions(root);
      if (!shadow.ok) throw shadow.error;
      expect(shadow.value.length).toBe(1);
      expect(shadow.value[0].action).toBe("edge-contest");
      expect(shadow.value[0].i_base).toBe(0.1);
      expect(shadow.value[0].commit_message).toContain("no longer derivable");
    } finally {
      cleanup(root);
    }
  });

  it("the returned stub edge has the revoked status + the contest reason", async () => {
    const root = tmpVault();
    try {
      const contest = makeContest({ vaultRoot: root, shadowMode: true });
      const r = await contest({
        fromPath: "a.md",
        toPath: "b.md",
        contestedBy: "agent:test",
        reason: "stale",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(r.value.status).toBe("revoked");
      expect(r.value.contestReason).toBe("stale");
      expect(r.value.contestedAt).toBeTruthy();
    } finally {
      cleanup(root);
    }
  });
});

// Suppress unused-import warning (readFileSync was used during draft).
void readFileSync;
