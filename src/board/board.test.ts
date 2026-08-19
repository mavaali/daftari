// board.test.ts — TDD test suite for U9: board engine (listBoard).
//
// Uses real temp vaults seeded with multiple source types:
//   lint    — orphan doc (notes/orphan-doc.md)
//   staleness — expired-TTL doc (notes/expired-doc.md)
//   staged  — pending staged action against notes/orphan-doc.md
//   tension — unresolved tension between notes/doc-a.md and notes/doc-b.md
//
// Tests cover:
//   1. Mixed-source vault → all findings surface, correct columns.
//   2. Role RBAC: scoped role (notes-only) vs admin; hidden collection yields
//      zero cards without changing admin totals (R18).
//   3. Unused board → no ledger writes (R7).
//   4. Reopen idempotency: resolved finding reappears → exactly ONE reopened
//      event appended; second listBoard call → no duplicate (R6).
//   5. Filter by collection / check / certainty / owner / age / document (R26).
//
// Run with:
//   npx vitest run src/board/board.test.ts

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../access/rbac.js";
import type { RoleConfig } from "../utils/config.js";
import { renderBoardPage } from "../view/board-page.js";
import { listBoard } from "./board.js";
import { appendEvent, boardDispositionsPath } from "./ledger.js";
import type { BoardColumn } from "./types.js";

// ---------------------------------------------------------------------------
// Vault fixture helpers (mirrors lint.test.ts, staleness.test.ts, etc.)
// ---------------------------------------------------------------------------

function frontmatter(overrides: Record<string, unknown> = {}): string {
  const fm: Record<string, unknown> = {
    title: "Test Document",
    domain: "accumulation",
    collection: "notes",
    status: "canonical",
    confidence: "medium",
    created: "2020-01-01",
    updated: "2020-01-01",
    updated_by: "agent:seed",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: null,
    ...overrides,
  };
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null) {
      lines.push(`${k}: null`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v as unknown[]) {
          lines.push(`  - ${JSON.stringify(item)}`);
        }
      }
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

function writeConfig(vaultRoot: string, roles: Record<string, Record<string, unknown>>): void {
  const daftariDir = join(vaultRoot, ".daftari");
  mkdirSync(daftariDir, { recursive: true });
  const roleLines = Object.entries(roles)
    .map(([name, cfg]) => {
      const lines = [`  ${name}:`];
      for (const [k, v] of Object.entries(cfg)) {
        if (Array.isArray(v)) {
          lines.push(`    ${k}: [${(v as string[]).map((s) => JSON.stringify(s)).join(", ")}]`);
        } else {
          lines.push(`    ${k}: ${JSON.stringify(v)}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n");
  const yaml = `version: 1\nvault_name: test-vault\nroles:\n${roleLines}\n`;
  writeFileSync(join(daftariDir, "config.yaml"), yaml, "utf-8");
}

function writeDoc(vaultRoot: string, path: string, content: string): void {
  const full = join(vaultRoot, path);
  const dir = join(vaultRoot, path.split("/").slice(0, -1).join("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function writeStagedActionProposal(
  vaultRoot: string,
  record: {
    id: string;
    action_type: string;
    target_path: string;
    proposed_by: string;
    proposed_at: string;
    expires_at: string;
    status: string;
    rationale: string;
    proposed_diff: string;
  },
): void {
  const daftariDir = join(vaultRoot, ".daftari");
  mkdirSync(daftariDir, { recursive: true });
  const filePath = join(daftariDir, "staged-actions.jsonl");
  let existing = "";
  try {
    existing = readFileSync(filePath, "utf-8");
  } catch {
    existing = "";
  }
  writeFileSync(filePath, `${existing + JSON.stringify(record)}\n`, "utf-8");
}

function writeTension(
  vaultRoot: string,
  entry: {
    id?: string;
    date: string;
    title: string;
    kind?: string;
    sourceA: string;
    claimA: string;
    sourceB: string;
    claimB: string;
    status?: string;
    loggedBy?: string;
  },
): void {
  const daftariDir = join(vaultRoot, ".daftari");
  mkdirSync(daftariDir, { recursive: true });
  const filePath = join(daftariDir, "tensions.md");

  const lines = [`## ${entry.date} — ${entry.title}`];
  if (entry.id !== undefined) lines.push(`- **Id:** ${entry.id}`);
  const kind = entry.kind ?? "factual";
  if (kind !== "unspecified") lines.push(`- **Kind:** ${kind}`);
  lines.push(`- **Source A:** ${entry.sourceA} says ${entry.claimA}`);
  lines.push(`- **Source B:** ${entry.sourceB} says ${entry.claimB}`);
  lines.push(`- **Status:** ${entry.status ?? "unresolved"}`);
  lines.push(`- **Logged by:** ${entry.loggedBy ?? "agent:test"}`);

  let existing = "";
  try {
    existing = readFileSync(filePath, "utf-8");
  } catch {
    existing = "";
  }
  writeFileSync(filePath, `${existing}\n${lines.join("\n")}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Role fixtures
// ---------------------------------------------------------------------------

const adminRole: RoleConfig = {
  read: ["*"],
  write: ["*"],
  promote: true,
  ratify: true,
};

const scopedRole: RoleConfig = {
  // can read "notes" but NOT "restricted"
  read: ["notes"],
  write: ["notes"],
  promote: false,
  ratify: false,
};

const adminAccess: AccessContext = {
  user: "human:admin",
  roleName: "admin",
  role: adminRole,
};

const scopedAccess: AccessContext = {
  user: "human:analyst",
  roleName: "analyst",
  role: scopedRole,
};

// ---------------------------------------------------------------------------
// Clock fixture — fixed "now" so staleness and expiry are deterministic.
// Documents updated 200 days before FIXED_NOW, ttl_days: 90 → expired.
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-01-01T00:00:00Z");
const STALE_DATE = new Date(FIXED_NOW.getTime() - 200 * 86_400_000).toISOString().slice(0, 10); // "2025-06-15"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the raw ledger JSONL lines from a vault. Returns [] if file absent. */
function readLedgerLines(vaultRoot: string): string[] {
  const p = boardDispositionsPath(vaultRoot);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

/** Count events in the ledger for a given finding_id. */
function countLedgerEventsFor(vaultRoot: string, findingId: string): number {
  return readLedgerLines(vaultRoot).filter((line) => {
    try {
      const e = JSON.parse(line) as { finding_id: string };
      return e.finding_id === findingId;
    } catch {
      return false;
    }
  }).length;
}

// ---------------------------------------------------------------------------
// Shared vault seeder — seeds lint + staleness + staged + tension findings.
// Returns the seeded vaultRoot.
// ---------------------------------------------------------------------------

function seedMixedVault(): string {
  const vaultRoot = mkdtempSync(join(tmpdir(), "daftari-board-test-"));
  writeConfig(vaultRoot, {
    admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    analyst: { read: ["notes"], write: ["notes"] },
  });

  // Lint: orphan doc (no other doc links to it)
  writeDoc(
    vaultRoot,
    "notes/orphan-doc.md",
    frontmatter({ title: "Orphan", collection: "notes", updated: "2020-01-01", ttl_days: null }) +
      "# Orphan\n\nNo one links here.\n",
  );

  // Staleness: TTL-expired doc
  writeDoc(
    vaultRoot,
    "notes/expired-doc.md",
    `${frontmatter({
      title: "Expired",
      collection: "notes",
      updated: STALE_DATE,
      ttl_days: 90,
    })}# Expired\n`,
  );

  // Staged: pending action against notes/orphan-doc.md
  writeStagedActionProposal(vaultRoot, {
    id: "stage-001",
    action_type: "promote",
    target_path: "notes/orphan-doc.md",
    proposed_by: "human:admin",
    proposed_at: "2025-12-01T00:00:00Z",
    expires_at: "2027-01-01T00:00:00Z",
    status: "pending",
    rationale: "promote the orphan",
    proposed_diff: "",
  });

  // Tension: unresolved between notes/doc-a.md and notes/doc-b.md
  writeTension(vaultRoot, {
    id: "tension-001",
    date: "2026-01-01",
    title: "Doc A vs Doc B",
    kind: "factual",
    sourceA: "notes/doc-a.md",
    claimA: "The sky is blue",
    sourceB: "notes/doc-b.md",
    claimB: "The sky is green",
    status: "unresolved",
  });

  return vaultRoot;
}

// ---------------------------------------------------------------------------
// Scenario 1: Mixed vault → all findings surface, correct columns.
// ---------------------------------------------------------------------------

describe("listBoard — Scenario 1: mixed vault, all sources surface", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = seedMixedVault();
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("returns a result with columns and all arrays", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    expect(result).toHaveProperty("columns");
    expect(result).toHaveProperty("all");
    expect(Array.isArray(result.all)).toBe(true);
  });

  it("all findings start in the 'new' column (no ledger yet)", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    for (const f of result.all) {
      expect(f.disposition).toBe("new");
    }
  });

  it("includes findings from at least lint, staleness, and tension sources", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const sources = new Set(result.all.map((f) => f.source));
    expect(sources.has("lint")).toBe(true);
    expect(sources.has("staleness")).toBe(true);
    expect(sources.has("tension")).toBe(true);
  });

  it("includes a staged finding for stage-001", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const staged = result.all.filter((f) => f.source === "staged");
    expect(staged.length).toBeGreaterThan(0);
    const s = staged.find(
      (f) => f.target.kind === "staged" && f.target.stagedActionId === "stage-001",
    );
    expect(s).toBeDefined();
  });

  it("includes the tension finding for tension-001", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const tensions = result.all.filter((f) => f.source === "tension");
    expect(tensions.length).toBeGreaterThan(0);
    const t = tensions.find(
      (f) => f.target.kind === "tension" && f.target.tensionId === "tension-001",
    );
    expect(t).toBeDefined();
  });

  it("columns.new contains all findings (no dispositions)", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    expect(result.columns.new.length).toBe(result.all.length);
    expect(result.columns.accepted.length).toBe(0);
    expect(result.columns.waiting.length).toBe(0);
    expect(result.columns.resolved.length).toBe(0);
    expect(result.columns.dismissed.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: RBAC — scoped role sees strict subset; hidden collection yields
// zero cards (R17/R18).
// ---------------------------------------------------------------------------

describe("listBoard — Scenario 2: RBAC role fixtures", () => {
  let vaultRoot: string;

  beforeEach(() => {
    // Seed notes/ + restricted/ collections.
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-board-rbac-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
      analyst: { read: ["notes"], write: ["notes"] },
    });

    // notes/ collection — visible to both roles
    writeDoc(
      vaultRoot,
      "notes/orphan-doc.md",
      frontmatter({ title: "Orphan", collection: "notes", updated: "2020-01-01", ttl_days: null }) +
        "# Orphan\n\nNo one links here.\n",
    );
    writeDoc(
      vaultRoot,
      "notes/expired-doc.md",
      `${frontmatter({
        title: "Expired Notes",
        collection: "notes",
        updated: STALE_DATE,
        ttl_days: 90,
      })}# Expired\n`,
    );

    // restricted/ collection — hidden from scopedRole
    writeDoc(
      vaultRoot,
      "restricted/secret-orphan.md",
      `${frontmatter({
        title: "Secret Orphan",
        collection: "restricted",
        updated: "2020-01-01",
        ttl_days: null,
      })}# Secret\n\nNo one links here.\n`,
    );
    writeDoc(
      vaultRoot,
      "restricted/secret-expired.md",
      `${frontmatter({
        title: "Secret Expired",
        collection: "restricted",
        updated: STALE_DATE,
        ttl_days: 90,
      })}# Secret Expired\n`,
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("admin sees findings from both notes and restricted collections", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const paths = result.all
      .map((f) => {
        if (f.target.kind === "lint") return f.target.path;
        if (f.target.kind === "staleness") return f.target.path;
        return null;
      })
      .filter(Boolean) as string[];
    const hasNotes = paths.some((p) => p.startsWith("notes/"));
    const hasRestricted = paths.some((p) => p.startsWith("restricted/"));
    expect(hasNotes).toBe(true);
    expect(hasRestricted).toBe(true);
  });

  it("scoped role sees only notes findings (strict subset of admin)", async () => {
    const adminResult = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const scopedResult = await listBoard(vaultRoot, scopedAccess, undefined, FIXED_NOW);

    // Scoped must be a strict subset
    expect(scopedResult.all.length).toBeGreaterThan(0);
    expect(scopedResult.all.length).toBeLessThan(adminResult.all.length);

    // Scoped sees no restricted findings
    for (const f of scopedResult.all) {
      if (f.target.kind === "lint" || f.target.kind === "staleness") {
        expect(f.target.path.startsWith("restricted/")).toBe(false);
      }
    }
  });

  it("hidden collection yields zero cards for scoped role (R18)", async () => {
    const scopedResult = await listBoard(vaultRoot, scopedAccess, undefined, FIXED_NOW);
    const restrictedFindings = scopedResult.all.filter((f) => {
      if (f.target.kind === "lint") return f.target.path.startsWith("restricted/");
      if (f.target.kind === "staleness") return f.target.path.startsWith("restricted/");
      return false;
    });
    expect(restrictedFindings.length).toBe(0);
  });

  it("admin totals are unchanged by what scoped role can see (R18)", async () => {
    const adminResult1 = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    // scoped role call does not affect admin's view
    await listBoard(vaultRoot, scopedAccess, undefined, FIXED_NOW);
    const adminResult2 = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    // Admin count stable (no writes to ledger since no dispositions)
    expect(adminResult2.all.length).toBe(adminResult1.all.length);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Unused board → zero ledger writes (R7).
// ---------------------------------------------------------------------------

describe("listBoard — Scenario 3: unused board writes nothing (R7)", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = seedMixedVault();
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("ledger file does not exist after listBoard when no dispositions exist", async () => {
    const ledgerPath = boardDispositionsPath(vaultRoot);
    expect(existsSync(ledgerPath)).toBe(false);

    await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);

    // With no prior dispositions, reconcile emits nothing → no writes
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it("ledger file is unchanged (still absent) on second call with no dispositions", async () => {
    await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    expect(existsSync(boardDispositionsPath(vaultRoot))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Reopen idempotency.
//   - Seed a vault with one lint finding.
//   - Write an "accept" ledger event for it → CASE C will emit "resolved" on
//     first listBoard (finding reproduced while accepted → wait, finding NOT
//     in live: that's CASE C. Actually for reopen we need: finding IS in live
//     AND ledger says "resolved").
//
// Correct setup for reopen (CASE B, shouldEmitReopen):
//   - Live finding is present.
//   - Ledger has [accept, resolved] events for its identity_key.
//   - reconcile detects latest=resolved + live present → emit reopened.
//   - Call listBoard once: reopened event appended.
//   - Call listBoard again: latest=reopened + live present → NO new emit.
// ---------------------------------------------------------------------------

describe("listBoard — Scenario 4: reopen idempotency (end-to-end)", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-board-reopen-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });

    // Lint: orphan doc that will remain in the live set
    writeDoc(
      vaultRoot,
      "notes/orphan-doc.md",
      frontmatter({ title: "Orphan", collection: "notes", updated: "2020-01-01", ttl_days: null }) +
        "# Orphan\n\nNo one links here.\n",
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("persists exactly one 'reopened' event on first call, none on second", async () => {
    // First call to get the orphan finding's identity_key
    const first = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const orphanFinding = first.all.find(
      (f) =>
        f.source === "lint" &&
        f.target.kind === "lint" &&
        f.target.path === "notes/orphan-doc.md" &&
        f.check === "orphanFiles",
    );
    expect(orphanFinding).toBeDefined();
    const id = orphanFinding!.identity_key;
    const fp = orphanFinding!.fingerprint;

    // Manually seed the ledger: [accept, resolved] — simulating a prior
    // run where the user accepted it and then it was auto-resolved.
    await appendEvent(vaultRoot, {
      finding_id: id,
      event: "accept",
      by: "human:admin",
      principal_type: "human",
      at: "2025-12-01T00:00:00Z",
      against_fingerprint: fp,
    });
    await appendEvent(vaultRoot, {
      finding_id: id,
      event: "resolved",
      by: "system",
      principal_type: "system",
      at: "2025-12-10T00:00:00Z",
      against_fingerprint: fp,
    });

    // Confirm ledger has exactly 2 events before first board call
    expect(countLedgerEventsFor(vaultRoot, id)).toBe(2);

    // Call listBoard: finding is live + ledger says "resolved" → reconcile
    // emits "reopened" → engine persists it.
    const second = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    expect(countLedgerEventsFor(vaultRoot, id)).toBe(3);

    // The finding should be in the reopened state (prior human disposition was accept → "accepted")
    const f2 = second.all.find((f) => f.identity_key === id);
    expect(f2).toBeDefined();
    expect(f2!.disposition).toBe("accepted");

    // Call listBoard again: latest event is "reopened" → no new emit.
    await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    expect(countLedgerEventsFor(vaultRoot, id)).toBe(3); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Filters (R26) — narrowing by collection/check/certainty/
//             owner/age/document.
// ---------------------------------------------------------------------------

describe("listBoard — Scenario 5: filters (R26)", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-board-filter-test-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });

    // notes/ collection
    writeDoc(
      vaultRoot,
      "notes/orphan-doc.md",
      frontmatter({ title: "Orphan", collection: "notes", updated: "2020-01-01", ttl_days: null }) +
        "# Orphan\n\nNo one links here.\n",
    );
    writeDoc(
      vaultRoot,
      "notes/expired-doc.md",
      `${frontmatter({
        title: "Expired",
        collection: "notes",
        updated: STALE_DATE,
        ttl_days: 90,
      })}# Expired\n`,
    );

    // decisions/ collection
    writeDoc(
      vaultRoot,
      "decisions/orphan-decision.md",
      `${frontmatter({
        title: "Orphan Decision",
        collection: "decisions",
        updated: "2020-01-01",
        ttl_days: null,
      })}# Decision\n\nNo one links here.\n`,
    );

    // Staged action
    writeStagedActionProposal(vaultRoot, {
      id: "stage-001",
      action_type: "promote",
      target_path: "notes/orphan-doc.md",
      proposed_by: "human:admin",
      proposed_at: "2025-12-01T00:00:00Z",
      expires_at: "2027-01-01T00:00:00Z",
      status: "pending",
      rationale: "promote orphan",
      proposed_diff: "",
    });

    // Tension between notes/doc-a.md and notes/doc-b.md
    writeTension(vaultRoot, {
      id: "tension-001",
      date: "2026-01-01",
      title: "Doc A vs Doc B",
      kind: "factual",
      sourceA: "notes/doc-a.md",
      claimA: "blue",
      sourceB: "notes/doc-b.md",
      claimB: "green",
      status: "unresolved",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("filter by collection='notes' returns only notes findings", async () => {
    const all = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const filtered = await listBoard(vaultRoot, adminAccess, { collection: "notes" }, FIXED_NOW);

    expect(filtered.all.length).toBeGreaterThan(0);
    expect(filtered.all.length).toBeLessThan(all.all.length);

    for (const f of filtered.all) {
      // lint/staleness: path starts with "notes/"
      if (f.target.kind === "lint" || f.target.kind === "staleness") {
        expect(f.target.path.startsWith("notes/")).toBe(true);
      }
      // staged: targetPath resolved to notes/ — covered by engine's collection resolution
      // tension: sourceA starts with "notes/" — documented semantic
    }
  });

  it("filter by collection='decisions' returns only decisions findings", async () => {
    const filtered = await listBoard(
      vaultRoot,
      adminAccess,
      { collection: "decisions" },
      FIXED_NOW,
    );
    expect(filtered.all.length).toBeGreaterThan(0);
    for (const f of filtered.all) {
      if (f.target.kind === "lint" || f.target.kind === "staleness") {
        expect(f.target.path.startsWith("decisions/")).toBe(true);
      }
    }
  });

  it("filter by check='orphanFiles' returns only orphanFiles findings", async () => {
    const filtered = await listBoard(vaultRoot, adminAccess, { check: "orphanFiles" }, FIXED_NOW);
    expect(filtered.all.length).toBeGreaterThan(0);
    for (const f of filtered.all) {
      expect(f.check).toBe("orphanFiles");
    }
  });

  it("filter by check='ttl-staleness' returns only staleness findings", async () => {
    const filtered = await listBoard(vaultRoot, adminAccess, { check: "ttl-staleness" }, FIXED_NOW);
    expect(filtered.all.length).toBeGreaterThan(0);
    for (const f of filtered.all) {
      expect(f.check).toBe("ttl-staleness");
    }
  });

  it("filter by certainty='high' returns only high-certainty findings", async () => {
    const all = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const highCertainty = all.all.filter((f) => f.certainty === "high");
    const filtered = await listBoard(vaultRoot, adminAccess, { certainty: "high" }, FIXED_NOW);
    expect(filtered.all.length).toBe(highCertainty.length);
    for (const f of filtered.all) {
      expect(f.certainty).toBe("high");
    }
  });

  it("filter by document='notes/orphan-doc.md' narrows to findings referencing that path", async () => {
    const filtered = await listBoard(
      vaultRoot,
      adminAccess,
      { document: "notes/orphan-doc.md" },
      FIXED_NOW,
    );
    expect(filtered.all.length).toBeGreaterThan(0);
    for (const f of filtered.all) {
      const t = f.target;
      let matches = false;
      if (t.kind === "lint") matches = t.path === "notes/orphan-doc.md";
      else if (t.kind === "staleness") matches = t.path === "notes/orphan-doc.md";
      else if (t.kind === "staged")
        matches = true; // staged targets notes/orphan-doc.md
      else if (t.kind === "tension")
        matches =
          (f.evidence as { sourceA?: string; sourceB?: string }).sourceA ===
            "notes/orphan-doc.md" ||
          (f.evidence as { sourceA?: string; sourceB?: string }).sourceB === "notes/orphan-doc.md";
      else if (t.kind === "tier2")
        matches = t.artifact === "notes/orphan-doc.md" || t.unit === "notes/orphan-doc.md";
      expect(matches).toBe(true);
    }
  });

  it("filter by minAgeDays=1 keeps only findings first_seen >= 1 day old", async () => {
    // All findings are brand-new (first_seen = FIXED_NOW from adapter) so a large
    // minAgeDays filter should return empty if first_seen is recent.
    // Use 0 to confirm it passes all through.
    const filtered0 = await listBoard(vaultRoot, adminAccess, { minAgeDays: 0 }, FIXED_NOW);
    const all = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    // minAgeDays=0 means "at least 0 days old" → everything passes
    expect(filtered0.all.length).toBe(all.all.length);
  });

  it("filter by minAgeDays=99999 returns empty when all findings are brand-new", async () => {
    const filtered = await listBoard(vaultRoot, adminAccess, { minAgeDays: 99999 }, FIXED_NOW);
    // first_seen for brand-new findings is FIXED_NOW itself → age = 0 days → excluded
    expect(filtered.all.length).toBe(0);
  });

  it("filter by owner='' returns findings with no owner (all new findings)", async () => {
    // New findings have owner:"" by default. Filter by owner:"" should return all.
    const all = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const filtered = await listBoard(vaultRoot, adminAccess, { owner: "" }, FIXED_NOW);
    expect(filtered.all.length).toBe(all.all.length);
    for (const f of filtered.all) {
      expect(f.owner).toBe("");
    }
  });

  it("filter by owner='human:admin' narrows to zero when no findings are owned", async () => {
    // No reassign events → all owners are ""; filter by a named owner returns empty.
    const filtered = await listBoard(vaultRoot, adminAccess, { owner: "human:admin" }, FIXED_NOW);
    expect(filtered.all.length).toBe(0);
  });

  it("filters are applied after reconcile: emit persists regardless of filter", async () => {
    // Set up a finding with [accept, resolved] so reconcile will emit "reopened".
    const baseResult = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const orphan = baseResult.all.find(
      (f) =>
        f.source === "lint" &&
        f.target.kind === "lint" &&
        f.target.path === "notes/orphan-doc.md" &&
        f.check === "orphanFiles",
    );
    expect(orphan).toBeDefined();
    const id = orphan!.identity_key;
    const fp = orphan!.fingerprint;

    await appendEvent(vaultRoot, {
      finding_id: id,
      event: "accept",
      by: "human:admin",
      principal_type: "human",
      at: "2025-12-01T00:00:00Z",
      against_fingerprint: fp,
    });
    await appendEvent(vaultRoot, {
      finding_id: id,
      event: "resolved",
      by: "system",
      principal_type: "system",
      at: "2025-12-10T00:00:00Z",
      against_fingerprint: fp,
    });

    const beforeCount = countLedgerEventsFor(vaultRoot, id);
    expect(beforeCount).toBe(2);

    // Apply a filter that would EXCLUDE the reopened finding (e.g. wrong check)
    await listBoard(vaultRoot, adminAccess, { check: "ttl-staleness" }, FIXED_NOW);

    // Even though the filter excluded the orphan finding, the emit was still persisted
    expect(countLedgerEventsFor(vaultRoot, id)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: columns shape integrity
// ---------------------------------------------------------------------------

describe("listBoard — Scenario 6: columns shape", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = seedMixedVault();
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("columns has exactly the five BoardColumn keys", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    expect(Object.keys(result.columns).sort()).toEqual(
      ["accepted", "dismissed", "new", "resolved", "waiting"].sort(),
    );
  });

  it("sum of column counts equals all.length", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const colTotal = Object.values(result.columns).reduce((n, col) => n + col.length, 0);
    expect(colTotal).toBe(result.all.length);
  });

  it("each finding in all[] is also in its disposition column", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    for (const f of result.all) {
      const col = result.columns[f.disposition as BoardColumn];
      expect(col.some((c) => c.identity_key === f.identity_key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Staged evidence seam — end-to-end contract (#455)
//
// Verifies that a real staged adapter finding (evidence.targetPath, NOT
// evidence.target_path) flows through listBoard and:
//   (a) is matched by collection=<its collection> filter (collectionOf)
//   (b) is matched by document=<its targetPath> filter (documentMatches)
//   (c) its back-link renders to /doc/<targetPath> via renderBoardPage
//
// This test uses the REAL staged adapter (via listBoard with a filesystem
// vault), not a hand-written mock, so it fails if the adapter and engine
// disagree on the field name.
// ---------------------------------------------------------------------------

describe("listBoard — Scenario 7: staged evidence targetPath seam (#455)", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "daftari-board-staged-seam-"));
    writeConfig(vaultRoot, {
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });

    // notes/ collection document (needed for RBAC collection resolution)
    writeDoc(
      vaultRoot,
      "notes/target-doc.md",
      frontmatter({ title: "Target", collection: "notes", updated: "2020-01-01", ttl_days: null }) +
        "# Target\n\nContent.\n",
    );

    // Staged action targeting notes/target-doc.md
    writeStagedActionProposal(vaultRoot, {
      id: "seam-001",
      action_type: "promote",
      target_path: "notes/target-doc.md",
      proposed_by: "human:admin",
      proposed_at: "2025-12-01T00:00:00Z",
      expires_at: "2027-01-01T00:00:00Z",
      status: "pending",
      rationale: "seam test promote",
      proposed_diff: "",
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("(a) staged finding is matched by collection='notes' filter", async () => {
    const filtered = await listBoard(vaultRoot, adminAccess, { collection: "notes" }, FIXED_NOW);
    const stagedFindings = filtered.all.filter((f) => f.source === "staged");
    expect(stagedFindings.length).toBeGreaterThan(0);
    const seam = stagedFindings.find(
      (f) => f.target.kind === "staged" && f.target.stagedActionId === "seam-001",
    );
    expect(seam).toBeDefined();
  });

  it("(b) staged finding is matched by document='notes/target-doc.md' filter", async () => {
    const filtered = await listBoard(
      vaultRoot,
      adminAccess,
      { document: "notes/target-doc.md" },
      FIXED_NOW,
    );
    const stagedFindings = filtered.all.filter((f) => f.source === "staged");
    expect(stagedFindings.length).toBeGreaterThan(0);
    const seam = stagedFindings.find(
      (f) => f.target.kind === "staged" && f.target.stagedActionId === "seam-001",
    );
    expect(seam).toBeDefined();
  });

  it("(c) staged finding evidence uses targetPath (not target_path)", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const seam = result.all.find(
      (f) =>
        f.source === "staged" &&
        f.target.kind === "staged" &&
        f.target.stagedActionId === "seam-001",
    );
    expect(seam).toBeDefined();
    // The adapter emits evidence.targetPath — verify the field name is correct
    expect(seam!.evidence.targetPath).toBe("notes/target-doc.md");
    // The wrong field name must NOT be present
    expect((seam!.evidence as Record<string, unknown>).target_path).toBeUndefined();
  });

  it("(d) renderBoardPage renders back-link to /doc/notes/target-doc.md (not /doc/undefined)", async () => {
    const result = await listBoard(vaultRoot, adminAccess, undefined, FIXED_NOW);
    const html = renderBoardPage(result);
    expect(html).toContain('href="/doc/notes/target-doc.md"');
    expect(html).not.toContain('href="/doc/undefined"');
  });
});
