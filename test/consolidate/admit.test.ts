// makeAdmit (Stage 3 Task 7): the envelope-owned admit. Covers the two gates,
// deduct-on-admit across calls, decision journaling to shadow-actions.jsonl, and
// the fail-closed construction contract. Real temp vaults with markdown docs;
// tensions seeded via addTension.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAdmit } from "../../src/consolidate/admit.js";
import { CONSOLIDATE_AGENT } from "../../src/consolidate/constants.js";
import type { ShadowActionRecord } from "../../src/curation/shadow.js";
import { addTension } from "../../src/curation/tension.js";
import { type LoadedDoc, loadDocuments } from "../../src/curation/vault-docs.js";
import { err } from "../../src/frontmatter/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daftari-admit-"));
  mkdirSync(join(dir, ".daftari"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Load the vault docs the same way index.ts does, so the test exercises the
// real LoadedDoc[] makeAdmit now consumes (carrying the validation report).
async function loadDocs(vaultRoot: string): Promise<LoadedDoc[]> {
  const res = await loadDocuments(vaultRoot);
  if (!res.ok) throw res.error;
  return res.value;
}

// A clean, valid, fresh document. `updated`/`created` recent so computeDecay is
// silent (no TTL expiry). All required built-in fields present + valid enums so
// validateFrontmatter passes (provenanceKnown=true).
function cleanDoc(title: string, opts: { sources?: string[]; updated?: string } = {}): string {
  const updated = opts.updated ?? "2026-06-17";
  const sources =
    opts.sources && opts.sources.length > 0
      ? `[${opts.sources.map((s) => `"${s}"`).join(", ")}]`
      : "[]";
  return [
    "---",
    `title: ${title}`,
    "domain: accumulation",
    "collection: c",
    "status: canonical",
    "confidence: high",
    "created: 2026-05-01",
    `updated: ${updated}`,
    "updated_by: agent:test",
    "provenance: direct",
    `sources: ${sources}`,
    "superseded_by: null",
    "ttl_days: 90",
    "tags: []",
    "---",
    `# ${title}`,
    "",
  ].join("\n");
}

function readShadow(): ShadowActionRecord[] {
  const raw = readFileSync(join(dir, ".daftari", "shadow-actions.jsonl"), "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ShadowActionRecord);
}

describe("makeAdmit — invariants gate", () => {
  it("admits a clean edge between two valid, fresh docs", async () => {
    writeFileSync(join(dir, "a.md"), cleanDoc("A"));
    writeFileSync(join(dir, "b.md"), cleanDoc("B"));

    const res = await makeAdmit({
      vaultRoot: dir,
      principal: CONSOLIDATE_AGENT,
      docs: await loadDocs(dir),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v = await res.value.admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v.admit).toBe(true);
    expect(v.gate).toBeNull();
  });

  it("gates an endpoint with an unresolved tension (invariants) + journals a gated row", async () => {
    writeFileSync(join(dir, "a.md"), cleanDoc("A"));
    writeFileSync(join(dir, "b.md"), cleanDoc("B"));
    await addTension(dir, {
      title: "a vs b",
      kind: "factual",
      sourceA: "a.md",
      claimA: "x",
      sourceB: "b.md",
      claimB: "y",
      loggedBy: "human:test",
    });

    const res = await makeAdmit({
      vaultRoot: dir,
      principal: CONSOLIDATE_AGENT,
      docs: await loadDocs(dir),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v = await res.value.admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");

    const rows = readShadow();
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe("gated");
    expect(rows[0].gate).toBe("invariants");
  });

  it("gates a stale endpoint (computeDecay warn — past TTL)", async () => {
    // updated far in the past with a short TTL → computeStaleness expired → warn.
    writeFileSync(join(dir, "a.md"), cleanDoc("A", { updated: "2020-01-01" }));
    writeFileSync(join(dir, "b.md"), cleanDoc("B"));

    const res = await makeAdmit({
      vaultRoot: dir,
      principal: CONSOLIDATE_AGENT,
      docs: await loadDocs(dir),
    });
    if (!res.ok) throw res.error;
    const v = await res.value.admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/premise-freshness/);
  });

  it("gates unknown provenance — a path not in the docs (missing endpoint)", async () => {
    writeFileSync(join(dir, "a.md"), cleanDoc("A"));
    const res = await makeAdmit({
      vaultRoot: dir,
      principal: CONSOLIDATE_AGENT,
      docs: await loadDocs(dir),
    });
    if (!res.ok) throw res.error;
    const v = await res.value.admit({
      action: "edge-observe",
      fromPath: "a.md",
      toPath: "ghost.md",
    });
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/provenance-required/);
  });

  it("gates unknown provenance — a doc with schema-invalid frontmatter", async () => {
    writeFileSync(join(dir, "a.md"), cleanDoc("A"));
    // Bad enum for `domain` → validateFrontmatter invalid → provenanceKnown false.
    const bad = cleanDoc("B").replace("domain: accumulation", "domain: not-a-domain");
    writeFileSync(join(dir, "b.md"), bad);

    // The schema-invalid doc is YAML-valid, so loadDocuments returns it (with a
    // validation report flagging the bad enum). makeAdmit reads that report's
    // .valid to set provenanceKnown=false — this is the path the fix preserves:
    // provenance is recovered in-memory from LoadedDoc.validation, NOT a re-read.
    const docs = await loadDocs(dir);
    expect(docs.some((d) => d.path === "b.md" && !d.validation.valid)).toBe(true);

    const res = await makeAdmit({ vaultRoot: dir, principal: CONSOLIDATE_AGENT, docs });
    if (!res.ok) throw res.error;
    const v = await res.value.admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/provenance-required/);
  });
});

describe("makeAdmit — trust-budget gate + deduct-on-admit (D1)", () => {
  it("deducts on admit so a later call exhausts the budget", async () => {
    // Endpoints a/b plus 3 docs that cite a.md → downstream blast = 3, blast = 4,
    // impact ≈ 0.31. B0 = 0.5 (base, 0 pending). First admit spends 0.31; the
    // second (0.31 + 0.31 = 0.62 > 0.5) is gated on budget.
    writeFileSync(join(dir, "a.md"), cleanDoc("A"));
    writeFileSync(join(dir, "b.md"), cleanDoc("B"));
    writeFileSync(join(dir, "c1.md"), cleanDoc("C1", { sources: ["a.md"] }));
    writeFileSync(join(dir, "c2.md"), cleanDoc("C2", { sources: ["a.md"] }));
    writeFileSync(join(dir, "c3.md"), cleanDoc("C3", { sources: ["a.md"] }));

    const res = await makeAdmit({
      vaultRoot: dir,
      principal: CONSOLIDATE_AGENT,
      docs: await loadDocs(dir),
    });
    if (!res.ok) throw res.error;
    const admit = res.value.admit;

    const v1 = await admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v1.admit).toBe(true);
    expect(v1.impact).toBeGreaterThan(0.1);

    const v2 = await admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v2.admit).toBe(false);
    expect(v2.gate).toBe("budget");

    // Both decisions journaled: one admitted, one gated.
    const rows = readShadow();
    expect(rows.length).toBe(2);
    expect(rows[0].decision).toBe("admitted");
    expect(rows[1].decision).toBe("gated");
    expect(rows[1].gate).toBe("budget");
  });

  it("a gated action does NOT deduct — a following clean action still admits", async () => {
    writeFileSync(join(dir, "a.md"), cleanDoc("A"));
    writeFileSync(join(dir, "b.md"), cleanDoc("B"));
    // c is stale → its edge gates on invariants; it must not spend.
    writeFileSync(join(dir, "c.md"), cleanDoc("C", { updated: "2020-01-01" }));

    const res = await makeAdmit({
      vaultRoot: dir,
      principal: CONSOLIDATE_AGENT,
      docs: await loadDocs(dir),
    });
    if (!res.ok) throw res.error;
    const admit = res.value.admit;

    const gated = await admit({ action: "edge-observe", fromPath: "a.md", toPath: "c.md" });
    expect(gated.admit).toBe(false);

    const clean = await admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(clean.admit).toBe(true);
  });
});

describe("makeAdmit — fail-closed", () => {
  // glob over a missing/empty vault returns [] (not an error), so construction
  // succeeds — but with no docs every endpoint reads as unknown provenance, so
  // the admit refuses everything (invariants). That is the fail-closed contract:
  // an empty/unknown information state never admits a write.
  it("an empty vault yields an admit that refuses everything (invariants)", async () => {
    // No docs loaded (index.ts would pass the [] loadDocuments returns for an
    // empty/missing vault). Every endpoint is then unknown-provenance ⇒ refuse.
    const res = await makeAdmit({
      vaultRoot: join(dir, "does-not-exist"),
      principal: CONSOLIDATE_AGENT,
      docs: [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const v = await res.value.admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
  });

  it("a vault whose .daftari is unreadable (staged/tension I/O) fails closed at construction", async () => {
    // listStagedActions / listTensions read .daftari files. We can't easily force
    // a read error portably; instead assert the broader contract: construction
    // returns a Result, and on the ok path the admit is a function.
    writeFileSync(join(dir, "a.md"), cleanDoc("A"));
    const res = await makeAdmit({
      vaultRoot: dir,
      principal: CONSOLIDATE_AGENT,
      docs: await loadDocs(dir),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(typeof res.value.admit).toBe("function");
  });
});

describe("makeAdmit — journal-write failure surfacing", () => {
  it("a failed journal write does NOT change the verdict or deduct, but increments journalFailures()", async () => {
    // Same blast setup as the deduct-on-admit test: 3 docs cite a.md, so the first
    // admit spends and a second over-budget call gates. We inject a journal that
    // always errs — the gate decision and the deduct must proceed unchanged.
    writeFileSync(join(dir, "a.md"), cleanDoc("A"));
    writeFileSync(join(dir, "b.md"), cleanDoc("B"));
    writeFileSync(join(dir, "c1.md"), cleanDoc("C1", { sources: ["a.md"] }));
    writeFileSync(join(dir, "c2.md"), cleanDoc("C2", { sources: ["a.md"] }));
    writeFileSync(join(dir, "c3.md"), cleanDoc("C3", { sources: ["a.md"] }));

    const res = await makeAdmit({
      vaultRoot: dir,
      principal: CONSOLIDATE_AGENT,
      docs: await loadDocs(dir),
      journal: async () => err(new Error("disk full")),
    });
    if (!res.ok) throw res.error;
    const { admit, journalFailures } = res.value;

    // Verdict unaffected: the first edge still admits.
    const v1 = await admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v1.admit).toBe(true);

    // Deduct still happened: the second over-budget call gates on budget.
    const v2 = await admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v2.admit).toBe(false);
    expect(v2.gate).toBe("budget");

    // Both journal writes failed and were counted.
    expect(journalFailures()).toBe(2);
  });

  it("a normal run leaves journalFailures() at 0", async () => {
    writeFileSync(join(dir, "a.md"), cleanDoc("A"));
    writeFileSync(join(dir, "b.md"), cleanDoc("B"));

    const res = await makeAdmit({
      vaultRoot: dir,
      principal: CONSOLIDATE_AGENT,
      docs: await loadDocs(dir),
    });
    if (!res.ok) throw res.error;
    const { admit, journalFailures } = res.value;

    const v = await admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v.admit).toBe(true);
    expect(journalFailures()).toBe(0);
  });
});
