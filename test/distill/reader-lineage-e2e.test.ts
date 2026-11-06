// Task 9 (6mf.4): End-to-end acceptance tests.
//
// Test 1: Re-distill with a different reader through stage→ratify ⇒ lineage
//   accumulates [ingest r1, update r2], readers = {r1,r2}, scalars dropped.
// Test 2: Panel `survives` with observes applied ⇒ from-doc gains one
//   `revision` lineage entry for the panel model.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAppendReaderLineage } from "../../src/consolidate/edge-write.js";
import { type RevisionDeps, revisionPanel } from "../../src/consolidate/revision.js";
import { stageActionWithConflictCheck } from "../../src/curation/staged-actions.js";
import {
  encodeLineageEntry,
  encodeRevisionReader,
  parseLineageEntry,
  readersFromLineage,
} from "../../src/distill/reader-fingerprint.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { ok } from "../../src/frontmatter/types.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultRatify } from "../../src/tools/staged-actions.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:test-e2e";
const READER_1 = "modelA@0.5|prompt=aaaaaaaa|retry=false";
const READER_2 = "modelB@0.3|prompt=bbbbbbbb|retry=false";
const LINEAGE_INGEST_R1 = encodeLineageEntry("2026-01-01T00:00:00Z", "ingest", READER_1);
const LINEAGE_UPDATE_R2 = encodeLineageEntry("2026-08-17T12:00:00Z", "update", READER_2);

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "E2E Test Note",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "medium",
    created: "2026-01-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["note"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// E2E test 1: stage→ratify accumulates lineage (R2 + R1 integration)
// ---------------------------------------------------------------------------

describe("reader-lineage e2e: stage→ratify accumulates lineage (6mf.4)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("re-distill with different reader through stage→ratify ⇒ lineage=[ingest r1, update r2], readers={r1,r2}, scalars dropped", async () => {
    // --- v1: seed the doc with reader_1 + ingest lineage ---
    const written = await vaultWrite(vault, {
      path: "pricing/e2e-doc.md",
      body: "# E2E Doc\n\nInitial statement.\n",
      frontmatter: frontmatter({
        readers: [READER_1],
        reader_lineage: [LINEAGE_INGEST_R1],
        reader_model: "modelA",
        reader_served_model: "modelA-0.5",
      }),
      agent: AGENT,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw written.error;

    // --- v2: stage an update with reader_2 (update op) ---
    const staged = await stageActionWithConflictCheck(vault, {
      actionType: "write",
      targetPath: "pricing/e2e-doc.md",
      proposedBy: "agent:distill",
      rationale: "Re-distilled with modelB — refined statement.",
      proposedDiff: {
        frontmatter: frontmatter({
          readers: [READER_2],
          reader_lineage: [LINEAGE_UPDATE_R2],
          reader_model: "modelB",
          reader_served_model: "modelB-0.3",
          title: "E2E Doc (revised)",
        }),
        body: "# E2E Doc\n\nRefined statement.\n",
      },
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw staged.error;

    // --- ratify (approve) ---
    const ratified = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: "human:operator",
      reason: "Reviewed and approved.",
    });
    expect(ratified.ok).toBe(true);
    if (!ratified.ok) throw ratified.error;
    expect(ratified.value.applied).toBe(true);

    // --- verify lineage union ---
    const doc = await vaultRead(vault, "pricing/e2e-doc.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;

    const raw = doc.value.raw;
    const lineage = Array.isArray(raw.reader_lineage) ? (raw.reader_lineage as string[]) : [];

    // Both entries must be present (ingest r1 first, update r2 second)
    expect(lineage).toEqual(expect.arrayContaining([LINEAGE_INGEST_R1, LINEAGE_UPDATE_R2]));
    expect(lineage.length).toBe(2);

    // readers = {r1, r2} (both preserved, not just the latest writer)
    const readers = Array.isArray(raw.readers) ? (raw.readers as string[]) : [];
    expect(readers).toEqual(expect.arrayContaining([READER_1, READER_2]));
    expect(readers.length).toBe(2);

    // readers[] == dedupe(reader-part of lineage) — invariant holds
    const computedReaders = readersFromLineage(lineage);
    expect(readers.sort()).toEqual(computedReaders.sort());

    // 6mf.1: >1 distinct reader ⇒ scalar reader_* dropped
    expect(raw.reader_model).toBeUndefined();
    expect(raw.reader_served_model).toBeUndefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// E2E test 2: revision panel survives ⇒ from-doc gains revision lineage entry
// ---------------------------------------------------------------------------

describe("reader-lineage e2e: revision panel appends lineage to real vault doc (6mf.4)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("panel survives with observes applied ⇒ from-doc gains one revision entry for the panel model", async () => {
    // Seed the from-doc (the one revision will stamp)
    const fromPath = "pricing/e2e-from.md";
    const toPath = "pricing/e2e-to.md";
    const written = await vaultWrite(vault, {
      path: fromPath,
      body: "# From Doc\n\nA statement.\n",
      frontmatter: frontmatter({ readers: [READER_1], reader_lineage: [LINEAGE_INGEST_R1] }),
      agent: AGENT,
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw written.error;

    // Also seed to-doc (revision panel loads both)
    const writtenTo = await vaultWrite(vault, {
      path: toPath,
      body: "# To Doc\n\nRelated statement.\n",
      frontmatter: frontmatter(),
      agent: AGENT,
    });
    expect(writtenTo.ok).toBe(true);
    if (!writtenTo.ok) throw writtenTo.error;

    const PANEL_MODEL = "claude-haiku-test";
    const dueEdge = {
      fromPath,
      toPath,
      strength: 2.5,
      kSurvived: 3,
      firstObserved: "2026-04-01T00:00:00Z",
      lastRederived: "2026-05-01T00:00:00Z",
      status: "trigger-bearing" as const,
      observations: 3,
      contestedAt: null,
      contestReason: null,
    };

    // Wire the real makeAppendReaderLineage in live mode
    const appendReaderLineage = makeAppendReaderLineage({ vaultRoot: vault, shadowMode: false });

    const mockLlm: LlmClient = {
      complete: vi.fn(),
      completeJson: vi.fn(async () =>
        ok({
          text: JSON.stringify({ verdict: "survives", reason: "link is valid" }),
          parsed: { verdict: "survives", reason: "link is valid" },
          input_tokens: 100,
          output_tokens: 20,
          stop_reason: "end_turn",
        }),
      ),
      completeWithTools: vi.fn(),
    };

    const deps: RevisionDeps = {
      admit: async () => ({ admit: true, gate: null, reason: "ok", impact: 0 }),
      llm: mockLlm,
      loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
      observe: async () => ok({ ...dueEdge }),
      contest: async () => ok({ ...dueEdge }),
      recordRevisionTrace: async () => ok(undefined),
      appendReaderLineage,
    };

    const result = await revisionPanel(dueEdge, deps, {
      vaultRoot: vault,
      agent: AGENT,
      panelSize: 2,
      budgetRemaining: 100,
      model: PANEL_MODEL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.decision).toBe("survives");
    expect(result.value.observedCount).toBeGreaterThan(0);

    // The from-doc must now have a `revision` lineage entry for the panel model
    const doc = await vaultRead(vault, fromPath);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;

    const raw = doc.value.raw;
    const lineage = Array.isArray(raw.reader_lineage) ? (raw.reader_lineage as string[]) : [];

    // Original ingest entry must still be present (append-only)
    expect(lineage).toEqual(expect.arrayContaining([LINEAGE_INGEST_R1]));

    // Must have exactly one `revision` entry for the panel model
    const revisionEntries = lineage.filter((e) => {
      const p = parseLineageEntry(e);
      return p?.op === "revision" && p.reader === encodeRevisionReader(PANEL_MODEL);
    });
    expect(revisionEntries.length).toBe(1);

    // Total: 1 ingest + 1 revision
    expect(lineage.length).toBe(2);
  }, 30_000);
});
