// vault_context handler-level tests (spec 2026-07-26-context-packs-
// progressive-disclosure-design.md, final plan Phase 2.7).
//
// Structural assertions only (C6) — inclusion, flag presence, RBAC omission,
// log contents. No golden-brief byte pin anywhere in this file.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { readReadLog } from "../../src/curation/read-log.js";
import { addTension } from "../../src/curation/tension.js";
import { reindexVault } from "../../src/search/reindex.js";
import {
  contextTools,
  DEFAULT_BUDGET,
  MAX_BUDGET,
  MIN_BUDGET,
  parseBudget,
  vaultContext,
} from "../../src/tools/context.js";
import { expectMatchesOutputSchema } from "../helpers/output-schema.js";

const contextTool = contextTools.find((t) => t.name === "vault_context");
if (!contextTool) throw new Error("vault_context not registered");

function frontmatter(fields: {
  title: string;
  collection: string;
  status?: string;
  supersededBy?: string;
}): string {
  const lines = [
    "---",
    `title: "${fields.title}"`,
    `collection: ${fields.collection}`,
    "domain: product",
    `status: ${fields.status ?? "canonical"}`,
    "confidence: high",
    "created: 2026-01-01",
    "updated: 2026-01-01",
    "updated_by: human:alice",
    "tags: []",
  ];
  if (fields.supersededBy) lines.push(`superseded_by: ${fields.supersededBy}`);
  lines.push("---", "");
  return lines.join("\n");
}

const WIDGET_QUERY = "widget launch plan announcement";
const WIDGET_BODY = "widget launch plan announcement ".repeat(20);

function publicRole(): AccessContext {
  return {
    user: "reader",
    roleName: "public-reader",
    role: { read: ["public"], write: [], promote: false, ratify: false },
  };
}

describe("vault_context", () => {
  let vault: string;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), "daftari-context-"));
    mkdirSync(join(vault, "public"), { recursive: true });
    mkdirSync(join(vault, "secret"), { recursive: true });
    mkdirSync(join(vault, ".daftari"), { recursive: true });

    const widgetBody = WIDGET_BODY;

    // Plain matching doc — no supersession, no tension.
    writeFileSync(
      join(vault, "public", "alpha.md"),
      `${frontmatter({ title: "Alpha", collection: "public" })}${widgetBody}\n`,
    );

    // A supersession chain: old-widget (stale, matches the query, carries a
    // tension) -> new-widget (the head, canonical, carries NO tension).
    writeFileSync(
      join(vault, "public", "old-widget.md"),
      `${frontmatter({ title: "Old Widget", collection: "public", status: "superseded", supersededBy: "public/new-widget.md" })}${widgetBody}\n`,
    );
    writeFileSync(
      join(vault, "public", "new-widget.md"),
      `${frontmatter({ title: "New Widget", collection: "public" })}The current widget plan supersedes the old one.\n`,
    );
    writeFileSync(
      join(vault, "public", "other.md"),
      `${frontmatter({ title: "Other", collection: "public" })}Unrelated content.\n`,
    );

    // A restricted-hop chain: stale doc (public, matches query) superseded by
    // a document in a collection the test role cannot read.
    writeFileSync(
      join(vault, "public", "restricted-stale.md"),
      `${frontmatter({ title: "Restricted Stale", collection: "public", status: "superseded", supersededBy: "secret/restricted-head.md" })}${widgetBody}\n`,
    );
    writeFileSync(
      join(vault, "secret", "restricted-head.md"),
      `${frontmatter({ title: "Restricted Head", collection: "secret" })}Secret current content.\n`,
    );

    // A hidden doc that ALSO matches the query lexically — an observable
    // RBAC-dropped BM25-side candidate (C4's counted case).
    writeFileSync(
      join(vault, "secret", "hidden-match.md"),
      `${frontmatter({ title: "Hidden Match", collection: "secret" })}${widgetBody}\n`,
    );

    // A hidden doc that is topically related but shares NO lexical terms
    // with WIDGET_QUERY (paraphrased entirely differently) — used to prove
    // hidden_remainder does NOT catch semantic-only hidden relevance (C4):
    // the vector half is RBAC-pushdown-scrubbed before this document could
    // ever become an observable drop, so it is structurally invisible to
    // the count, not merely absent by chance.
    writeFileSync(
      join(vault, "secret", "quiet.md"),
      `${frontmatter({ title: "Quiet", collection: "secret" })}Merchandise release schedule for retail partners.\n`,
    );

    // Many large filler docs so a small budget cannot include them all —
    // forces a real budget cut for the C1 read-log test.
    for (let i = 0; i < 8; i++) {
      writeFileSync(
        join(vault, "public", `filler-${i}.md`),
        `${frontmatter({ title: `Filler ${i}`, collection: "public" })}${widgetBody.repeat(30)}\n`,
      );
    }

    await addTension(vault, {
      kind: "factual",
      title: "widget scope disagreement",
      sourceA: "public/old-widget.md",
      claimA: "the widget ships in Q1",
      sourceB: "public/other.md",
      claimB: "the widget ships in Q2",
      loggedBy: "human:alice",
    });

    const reindexed = await reindexVault(vault);
    if (!reindexed.ok) throw reindexed.error;
  }, 120_000);

  afterAll(() => {
    // Best-effort; temp dirs are cleaned by the OS eventually either way,
    // matching the sibling rerank fixture's posture.
  });

  it("assembles a brief for a matching task, output matches the schema", async () => {
    const result = await vaultContext(vault, { task: WIDGET_QUERY, budget: 4000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.included.length).toBeGreaterThan(0);
    expectMatchesOutputSchema(contextTool, result.value);
  });

  it("zero-hit task returns the empty-pack shape (C9)", async () => {
    // An empty vault (no documents at all) is the unambiguous zero-hit case:
    // with any real corpus, vector similarity is never exactly zero for
    // every candidate, so this vault is built with nothing to match at all
    // rather than trying to word a query no document resembles.
    const empty = mkdtempSync(join(tmpdir(), "daftari-context-empty-"));
    mkdirSync(join(empty, ".daftari"), { recursive: true });
    const result = await vaultContext(empty, { task: "anything at all" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.included).toEqual([]);
    expect(result.value.manifest.omitted_over_budget).toBe(0);
    expect(result.value.brief).toContain("No matching documents");
  }, 30_000);

  describe("budget parsing (C9)", () => {
    it("absent/non-numeric budget defaults", () => {
      expect(parseBudget(undefined)).toEqual({ ok: true, value: DEFAULT_BUDGET });
      expect(parseBudget("4000")).toEqual({ ok: true, value: DEFAULT_BUDGET });
      expect(parseBudget(Number.NaN)).toEqual({ ok: true, value: DEFAULT_BUDGET });
    });

    it("a finite budget below the minimum is an error, never silently clamped up", () => {
      const result = parseBudget(499);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain(String(MIN_BUDGET));
    });

    it("a finite budget above the maximum clamps down silently", () => {
      expect(parseBudget(MAX_BUDGET + 5000)).toEqual({ ok: true, value: MAX_BUDGET });
    });

    it("the handler surfaces the same budget error", async () => {
      const result = await vaultContext(vault, { task: WIDGET_QUERY, budget: 100 });
      expect(result.ok).toBe(false);
    });
  });

  describe("RBAC (omission over redaction, no existence leak)", () => {
    it("a restricted role's pack never names an unreadable document", async () => {
      const result = await vaultContext(vault, { task: WIDGET_QUERY, budget: 8000 }, publicRole());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.brief).not.toContain("secret/");
      expect(result.value.brief).not.toContain("hidden-match");
      for (const e of result.value.manifest.included) {
        expect(e.path.startsWith("secret/")).toBe(false);
      }
    });

    it("hidden_remainder is coarsened (some/many), never an exact count, when a readable RBAC drop is observed", async () => {
      const result = await vaultContext(vault, { task: WIDGET_QUERY, budget: 8000 }, publicRole());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(["some", "many"]).toContain(result.value.manifest.hidden_remainder);
    });

    // C4: a lexically-quiet hidden document (no shared BM25 terms with the
    // task, in an unreadable collection) yields hidden_remainder: "none" —
    // asserted DELIBERATELY. "none" here means "no withholding observed",
    // never "nothing withheld": the vector half of retrieval is RBAC-
    // pushdown-scrubbed (2026-07-26 fusion spec, Decision 3), so this
    // document was never a candidate to begin with, not merely filtered.
    it("a lexically-quiet hidden document yields hidden_remainder: 'none' (C4)", async () => {
      // Isolated vault: the ONLY hidden document is a paraphrase sharing no
      // BM25 terms with the task, and no other secret doc exists to
      // contaminate the count via a different channel.
      const quietVault = mkdtempSync(join(tmpdir(), "daftari-context-quiet-"));
      mkdirSync(join(quietVault, "public"), { recursive: true });
      mkdirSync(join(quietVault, "secret"), { recursive: true });
      writeFileSync(
        join(quietVault, "public", "task-doc.md"),
        `${frontmatter({ title: "Task Doc", collection: "public" })}${WIDGET_BODY}\n`,
      );
      writeFileSync(
        join(quietVault, "secret", "quiet.md"),
        `${frontmatter({ title: "Quiet", collection: "secret" })}Merchandise release schedule for retail partners.\n`,
      );
      const reindexed = await reindexVault(quietVault);
      if (!reindexed.ok) throw reindexed.error;

      const result = await vaultContext(
        quietVault,
        { task: WIDGET_QUERY, budget: 8000 },
        publicRole(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.manifest.hidden_remainder).toBe("none");
    }, 30_000);
  });

  describe("supersession collapse (C3 — head-keyed flags)", () => {
    it("a chain head entry carries supersedes: N and none of the stale member's own flags", async () => {
      const result = await vaultContext(vault, { task: WIDGET_QUERY, budget: 16000 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // old-widget.md never appears — it collapsed into its head.
      expect(result.value.manifest.included.map((e) => e.path)).not.toContain(
        "public/old-widget.md",
      );
      const head = result.value.manifest.included.find((e) => e.path === "public/new-widget.md");
      expect(head).toBeTruthy();
      expect(result.value.brief).toContain("supersedes 1 older document matching this task");
      // The stale member's tension (old-widget vs other.md) must NOT be
      // borrowed onto the head's entry — the head carries no tension.
      const headBlockStart = result.value.brief.indexOf("### New Widget");
      const nextHeading = result.value.brief.indexOf("\n### ", headBlockStart + 1);
      const headBlock = result.value.brief.slice(
        headBlockStart,
        nextHeading === -1 ? undefined : nextHeading,
      );
      expect(headBlock).not.toContain("contested");
      expect(headBlock).not.toContain("the widget ships in Q1");
    });
  });

  describe("restricted supersession hop", () => {
    it("a restricted hop yields the path-free 'current source: restricted' flag, kept as itself", async () => {
      const result = await vaultContext(vault, { task: WIDGET_QUERY, budget: 16000 }, publicRole());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const entry = result.value.manifest.included.find(
        (e) => e.path === "public/restricted-stale.md",
      );
      expect(entry).toBeTruthy();
      expect(result.value.brief).toContain("current source: restricted");
      expect(result.value.brief).not.toContain("secret/restricted-head.md");
    });
  });

  describe("empty index — auto-reindex path", () => {
    it("a fresh vault with no built index still returns a pack (ensureIndexReady auto-reindexes)", async () => {
      const fresh = mkdtempSync(join(tmpdir(), "daftari-context-fresh-"));
      mkdirSync(join(fresh, "notes"), { recursive: true });
      writeFileSync(
        join(fresh, "notes", "a.md"),
        `${frontmatter({ title: "A", collection: "notes" })}${widgetBodyFallback()}\n`,
      );
      const result = await vaultContext(fresh, { task: "some task text" }, undefined);
      expect(result.ok).toBe(true);
    }, 60_000);
  });

  describe("read log (C1) — only survivors of the budget cut are logged", () => {
    it("the read log contains exactly the included paths and none of the budget-cut entries", async () => {
      // A dedicated, freshly-reindexed vault — a shared vault would have
      // accumulated read-log entries from every earlier vault_context call
      // in this file, which would make an exact-set comparison meaningless.
      const logVault = mkdtempSync(join(tmpdir(), "daftari-context-log-"));
      mkdirSync(join(logVault, "public"), { recursive: true });
      for (let i = 0; i < 8; i++) {
        writeFileSync(
          join(logVault, "public", `doc-${i}.md`),
          `${frontmatter({ title: `Doc ${i}`, collection: "public" })}${WIDGET_BODY.repeat(30)}\n`,
        );
      }
      const reindexed = await reindexVault(logVault);
      if (!reindexed.ok) throw reindexed.error;

      const budget = MIN_BUDGET; // small on purpose, forces a real cut
      const result = await vaultContext(logVault, { task: WIDGET_QUERY, budget });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Sanity: this scenario must actually exercise a cut, or the assertion
      // below would pass vacuously.
      expect(result.value.manifest.omitted_over_budget).toBeGreaterThan(0);

      const logResult = await readReadLog(logVault);
      expect(logResult.ok).toBe(true);
      if (!logResult.ok) return;
      const loggedPaths = new Set(
        logResult.value.filter((e) => e.tool === "vault_context").map((e) => e.file),
      );
      const includedPaths = new Set(result.value.manifest.included.map((e) => e.path));
      expect(loggedPaths).toEqual(includedPaths);
    }, 60_000);
  });
});

function widgetBodyFallback(): string {
  return "some task text ".repeat(5);
}
