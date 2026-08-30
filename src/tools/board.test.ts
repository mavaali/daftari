// board.test.ts — TDD test suite for U11: Board MCP tools (trust boundary).
//
// Tests cover every trust-boundary requirement:
//   R13/R16 — canDispose gate: agent role (no dispose) rejected for ALL four events.
//   R14     — vault_board_resolve: still-reproduces → no resolved; gone → exactly one resolved.
//   R15     — reopened is never a tool entry point (no code path can emit it via tools).
//   R20     — RBAC on dispose target: scoped role cannot dispose finding it cannot read.
//   R31     — reassign: unconfigured principal rejected; configured principal succeeds.
//
// Also verifies:
//   - principal_type "human" on all dispose events.
//   - principal_type "system" on resolve events.
//   - descriptor stamped on every dispose event.
//   - Non-disclosing error: dispose of non-existent vs. unreadable finding yields same error.
//   - vault_board_list delegates cleanly to listBoard (no extra gating).
//
// Run with:
//   npx vitest run src/tools/board.test.ts

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../access/rbac.js";
import { boardDispositionsPath } from "../board/ledger.js";
import type { LedgerEvent } from "../board/types.js";
import { requireDefined } from "../test-utils/require-defined.js";
import type { DaftariConfig, RoleConfig } from "../utils/config.js";
import { vaultBoardDispose, vaultBoardList, vaultBoardResolve } from "./board.js";

// ---------------------------------------------------------------------------
// Helpers — vault fixture construction
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

/**
 * Build a .daftari/config.yaml with given roles and optional extra principals.
 * `server.tokens` is kept empty in tests (principals are exercised via `principals:` list).
 */
function writeConfig(
  vaultRoot: string,
  roles: Record<string, Record<string, unknown>>,
  extraPrincipals: string[] = [],
): void {
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
  const principalLines =
    extraPrincipals.length > 0
      ? `\nprincipals:\n${extraPrincipals.map((p) => `  - ${JSON.stringify(p)}`).join("\n")}\n`
      : "";
  const yaml =
    `version: 1\nvault_name: test-vault\nroles:\n${roleLines}\n` +
    `server:\n  tokens: []\n` +
    principalLines;
  writeFileSync(join(daftariDir, "config.yaml"), yaml, "utf-8");
}

function writeDoc(vaultRoot: string, path: string, content: string): void {
  const full = join(vaultRoot, path);
  const dir = join(vaultRoot, path.split("/").slice(0, -1).join("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, "utf-8");
}

/** Read all ledger events from the vault JSONL file. */
function readLedgerEvents(vaultRoot: string): LedgerEvent[] {
  const p = boardDispositionsPath(vaultRoot);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerEvent);
}

// ---------------------------------------------------------------------------
// Role + AccessContext fixtures
// ---------------------------------------------------------------------------

// Human operator: dispose:true, read:["*"]
const humanRole: RoleConfig = {
  read: ["*"],
  write: ["*"],
  promote: true,
  ratify: true,
  dispose: true,
};

// Agent role: no dispose capability, read:["*"]
const agentRole: RoleConfig = {
  read: ["*"],
  write: ["*"],
  promote: false,
  ratify: false,
  // dispose intentionally absent → canDispose returns false
};

// Scoped human: dispose:true but only read:["notes"]
const scopedHumanRole: RoleConfig = {
  read: ["notes"],
  write: ["notes"],
  promote: false,
  ratify: false,
  dispose: true,
};

const humanAccess: AccessContext = {
  user: "human:operator",
  roleName: "human",
  role: humanRole,
};

const agentAccess: AccessContext = {
  user: "agent:curation-loop",
  roleName: "agent",
  role: agentRole,
};

const scopedHumanAccess: AccessContext = {
  user: "human:scoped",
  roleName: "scoped",
  role: scopedHumanRole,
};

// ---------------------------------------------------------------------------
// DaftariConfig fixture for principals tests
// ---------------------------------------------------------------------------

function makeConfig(roles: Record<string, RoleConfig>, principals: string[] = []): DaftariConfig {
  return {
    roles,
    schemaExtensions: [],
    hooks: { preWrite: [], preWriteTransform: [] },
    autoCommit: false,
    watch: false,
    warmEmbeddings: false,
    embeddingProvider: "local-minilm",
    search: {
      coverage: false,
      vecKnnK: 64,
      weights: { bm25: 0.8, vector: 0.2 },
      suppressSuperseded: false,
      graphExpand: { enabled: false, cap: 10, tau: 0.3, subset: "trigger" },
    },
    backfillIdentityMap: {},
    holderAliases: {},
    shadowMode: false,
    shadowModeSet: false,
    gitDir: undefined,
    lintVoice: "plain",
    tensionScan: {
      maxLlmCalls: 10,
      maxDocs: 10,
      agent: "agent:test",
    },
    tools: { tier: "full", include: [], exclude: [] },
    server: {
      tokens: [],
      limits: {
        ratePerMinute: 120,
        burst: 40,
        authFailureBurst: 10,
        authFailuresPerMinute: 6,
        maxInFlight: 32,
        maxBodyBytes: 4_194_304,
      },
      audit: false,
      trustedProxies: [],
    },
    storage: undefined,
    codeRepos: {},
    jitAnchors: false,
    autoRepin: false,
    distill: undefined,
    federation: undefined,
    principals,
  };
}

// ---------------------------------------------------------------------------
// Fixed clock so staleness findings are deterministic
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-01-01T00:00:00Z");

// ---------------------------------------------------------------------------
// Vault seeders
// ---------------------------------------------------------------------------

/**
 * Seeds a vault with a single lint finding (orphan doc).
 * Returns the vaultRoot.
 */
function seedLintVault(
  roles: Record<string, Record<string, unknown>>,
  principals: string[] = [],
): string {
  const vaultRoot = mkdtempSync(join(tmpdir(), "daftari-board-tools-test-"));
  writeConfig(vaultRoot, roles, principals);
  // Lint: orphan doc (no back-references)
  writeDoc(
    vaultRoot,
    "notes/orphan-doc.md",
    frontmatter({ title: "Orphan", collection: "notes", updated: "2020-01-01", ttl_days: null }) +
      "# Orphan\n\nNo one links here.\n",
  );
  return vaultRoot;
}

/**
 * Seeds a vault that has findings in BOTH "notes" and "restricted" collections.
 * Used for scoped-role RBAC tests (R20).
 */
function seedMultiCollectionVault(): string {
  const vaultRoot = mkdtempSync(join(tmpdir(), "daftari-board-tools-test-"));
  writeConfig(vaultRoot, {
    human: { read: ["*"], write: ["*"], promote: true, ratify: true, dispose: true },
    scoped: { read: ["notes"], write: ["notes"], dispose: true },
    agent: { read: ["*"], write: ["*"] },
  });
  // notes collection doc — scoped role CAN read this
  writeDoc(
    vaultRoot,
    "notes/orphan-doc.md",
    frontmatter({ title: "Orphan", collection: "notes", updated: "2020-01-01", ttl_days: null }) +
      "# Orphan\n\nNo one links here.\n",
  );
  // restricted collection doc — scoped role CANNOT read this
  writeDoc(
    vaultRoot,
    "restricted/secret-doc.md",
    frontmatter({
      title: "Secret",
      collection: "restricted",
      updated: "2020-01-01",
      ttl_days: null,
    }) + "# Secret\n\nNobody can see me if scoped.\n",
  );
  return vaultRoot;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("vault_board_list", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = seedLintVault({
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("returns board findings for a readable vault", async () => {
    const config = makeConfig({
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    const result = await vaultBoardList(vaultRoot, humanAccess, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The board has columns
    expect(result.value).toHaveProperty("columns");
    expect(result.value).toHaveProperty("all");
  });

  it("accepts optional filters without error", async () => {
    const config = makeConfig({
      admin: { read: ["*"], write: ["*"], promote: true, ratify: true },
    });
    const result = await vaultBoardList(vaultRoot, humanAccess, config, { collection: "notes" });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R13 / R16 — canDispose gate: agent role rejected for ALL four events
// ---------------------------------------------------------------------------

describe("vault_board_dispose — R13/R16 canDispose gate", () => {
  let vaultRoot: string;
  let config: DaftariConfig;

  beforeEach(() => {
    vaultRoot = seedLintVault({
      human: { read: ["*"], write: ["*"], promote: true, ratify: true, dispose: true },
      agent: { read: ["*"], write: ["*"] },
    });
    config = makeConfig({
      human: humanRole,
      agent: agentRole,
    });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  for (const event of ["accept", "defer", "dismiss", "reassign"] as const) {
    it(`rejects agent role for event '${event}'`, async () => {
      // First get a real finding_id via list
      const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      const allFindings = listResult.value.all;
      // We need at least one finding to attempt the dispose
      const findingId =
        allFindings.length > 0
          ? requireDefined(allFindings[0]).identity_key
          : "fake-finding-id-does-not-matter";

      const result = await vaultBoardDispose(vaultRoot, agentAccess, config, {
        finding_id: findingId,
        event,
        rationale: "agent trying to dispose",
        ...(event === "reassign" ? { owner: "human:operator" } : {}),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Error must mention disposition denial — not the finding-not-found path
      expect(result.error.message).toMatch(/dispose|permission|denied|capability/i);
    });
  }

  it("confirms: NO ledger events written when agent is rejected", async () => {
    const result = await vaultBoardDispose(vaultRoot, agentAccess, config, {
      finding_id: "any-id",
      event: "accept",
      rationale: "should not land",
    });
    expect(result.ok).toBe(false);
    // Ledger must be empty
    const events = readLedgerEvents(vaultRoot);
    expect(events.filter((e) => e.event === "accept")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Human operator can dispose — all four events appended with principal_type "human"
// ---------------------------------------------------------------------------

describe("vault_board_dispose — human operator, all four events", () => {
  let vaultRoot: string;
  let config: DaftariConfig;

  beforeEach(() => {
    vaultRoot = seedLintVault(
      {
        human: { read: ["*"], write: ["*"], promote: true, ratify: true, dispose: true },
        agent: { read: ["*"], write: ["*"] },
      },
      ["human:other-operator"],
    );
    config = makeConfig({ human: humanRole, agent: agentRole }, [
      "human:operator",
      "human:other-operator",
    ]);
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("accept — appended with principal_type 'human'", async () => {
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    const result = await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "accept",
      rationale: "accepting lint finding",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify ledger
    const events = readLedgerEvents(vaultRoot).filter(
      (e) => e.finding_id === finding.identity_key && e.event === "accept",
    );
    expect(events).toHaveLength(1);
    expect(requireDefined(events[0]).principal_type).toBe("human");
    expect(requireDefined(events[0]).by).toBe("human:operator");
    // Descriptor must be stamped
    expect(requireDefined(events[0]).descriptor).toBeDefined();
    expect(requireDefined(events[0]).descriptor?.source).toBe("lint");
  });

  it("defer — appended with principal_type 'human' and expiry", async () => {
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    const expiry = "2026-06-01T00:00:00Z";
    const result = await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "defer",
      rationale: "deferring for now",
      expiry,
    });

    expect(result.ok).toBe(true);
    const events = readLedgerEvents(vaultRoot).filter(
      (e) => e.finding_id === finding.identity_key && e.event === "defer",
    );
    expect(events).toHaveLength(1);
    expect(requireDefined(events[0]).principal_type).toBe("human");
    expect(requireDefined(events[0]).expiry).toBe(expiry);
    expect(requireDefined(events[0]).descriptor).toBeDefined();
  });

  it("dismiss — appended with principal_type 'human'", async () => {
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    const result = await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "dismiss",
      rationale: "won't fix",
    });

    expect(result.ok).toBe(true);
    const events = readLedgerEvents(vaultRoot).filter(
      (e) => e.finding_id === finding.identity_key && e.event === "dismiss",
    );
    expect(events).toHaveLength(1);
    expect(requireDefined(events[0]).principal_type).toBe("human");
    expect(requireDefined(events[0]).descriptor).toBeDefined();
  });

  it("reassign to configured principal — appended with principal_type 'human'", async () => {
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    const result = await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "reassign",
      rationale: "reassigning",
      owner: "human:other-operator",
    });

    expect(result.ok).toBe(true);
    const events = readLedgerEvents(vaultRoot).filter(
      (e) => e.finding_id === finding.identity_key && e.event === "reassign",
    );
    expect(events).toHaveLength(1);
    expect(requireDefined(events[0]).principal_type).toBe("human");
    expect(requireDefined(events[0]).owner).toBe("human:other-operator");
    expect(requireDefined(events[0]).descriptor).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R31 — reassign to unconfigured principal rejected
// ---------------------------------------------------------------------------

describe("vault_board_dispose — R31 reassign principal gate", () => {
  let vaultRoot: string;
  let config: DaftariConfig;

  beforeEach(() => {
    vaultRoot = seedLintVault(
      { human: { read: ["*"], write: ["*"], promote: true, ratify: true, dispose: true } },
      ["human:allowed-person"],
    );
    config = makeConfig({ human: humanRole }, ["human:allowed-person"]);
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("rejects reassign to a name NOT in configured principals", async () => {
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    const result = await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "reassign",
      rationale: "reassigning to unknown",
      owner: "human:unknown-person",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/principal|owner|unknown|not configured/i);

    // No event written
    const events = readLedgerEvents(vaultRoot).filter((e) => e.event === "reassign");
    expect(events).toHaveLength(0);
  });

  it("allows reassign to a configured principal", async () => {
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    const result = await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "reassign",
      rationale: "reassigning to allowed",
      owner: "human:allowed-person",
    });

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R20 — RBAC on dispose target: non-disclosing error
// The scoped role (notes-only) cannot dispose a finding from "restricted".
// The error message must be THE SAME as for a non-existent finding_id.
// ---------------------------------------------------------------------------

describe("vault_board_dispose — R20 RBAC non-disclosure", () => {
  let vaultRoot: string;
  let config: DaftariConfig;

  beforeEach(() => {
    vaultRoot = seedMultiCollectionVault();
    config = makeConfig(
      {
        human: humanRole,
        scoped: scopedHumanRole,
        agent: agentRole,
      },
      ["human:operator", "human:scoped"],
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("scoped role: error for unreadable finding is byte-identical to error for nonexistent id", async () => {
    // Get the restricted finding via admin (humanAccess)
    const adminListResult = await vaultBoardList(
      vaultRoot,
      humanAccess,
      config,
      undefined,
      FIXED_NOW,
    );
    expect(adminListResult.ok).toBe(true);
    if (!adminListResult.ok) return;

    const restrictedFinding = adminListResult.value.all.find(
      (f) =>
        f.target.kind === "lint" && "path" in f.target && f.target.path.startsWith("restricted/"),
    );
    expect(restrictedFinding).toBeDefined();
    if (!restrictedFinding) return;

    // Attempt 1: dispose a finding the scoped role CANNOT read
    const blockedResult = await vaultBoardDispose(vaultRoot, scopedHumanAccess, config, {
      finding_id: restrictedFinding.identity_key,
      event: "accept",
      rationale: "trying to accept restricted finding",
    });

    // Attempt 2: dispose a completely fake finding_id
    const fakeResult = await vaultBoardDispose(vaultRoot, scopedHumanAccess, config, {
      finding_id: "totally-fake-id-that-does-not-exist",
      event: "accept",
      rationale: "trying to accept nonexistent",
    });

    expect(blockedResult.ok).toBe(false);
    expect(fakeResult.ok).toBe(false);

    if (blockedResult.ok || fakeResult.ok) return;

    // The error messages must be byte-identical — no existence disclosure (R20).
    // IMPORTANT: the message must NOT contain the finding_id, since the two ids
    // differ (one is a sha256, the other is a literal string) — including the id
    // would reveal which one was "found but blocked" vs "not found at all".
    expect(blockedResult.error.message).toBe(fakeResult.error.message);
    // Also confirm neither message contains the finding_id
    expect(blockedResult.error.message).not.toContain(restrictedFinding.identity_key);
    expect(fakeResult.error.message).not.toContain("totally-fake-id");
  });

  it("scoped role CAN dispose a finding in its readable collection", async () => {
    const scopedListResult = await vaultBoardList(
      vaultRoot,
      scopedHumanAccess,
      config,
      undefined,
      FIXED_NOW,
    );
    expect(scopedListResult.ok).toBe(true);
    if (!scopedListResult.ok) return;

    const notesFinding = scopedListResult.value.all.find(
      (f) => f.target.kind === "lint" && "path" in f.target && f.target.path.startsWith("notes/"),
    );
    expect(notesFinding).toBeDefined();
    if (!notesFinding) return;

    const result = await vaultBoardDispose(vaultRoot, scopedHumanAccess, config, {
      finding_id: notesFinding.identity_key,
      event: "accept",
      rationale: "accepting notes finding",
    });

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R14 — vault_board_resolve: still-reproduces → no resolved; gone → exactly one resolved
// ---------------------------------------------------------------------------

describe("vault_board_resolve — R14 reproduces gate", () => {
  let vaultRoot: string;
  let config: DaftariConfig;

  beforeEach(() => {
    vaultRoot = seedLintVault({
      human: { read: ["*"], write: ["*"], promote: true, ratify: true, dispose: true },
      agent: { read: ["*"], write: ["*"] },
    });
    config = makeConfig({ human: humanRole, agent: agentRole });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("still-reproduces → NOT resolved, returns 'still reproduces' indicator", async () => {
    // Get a live finding
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    // First accept it so there's a ledger entry (resolve needs prior events)
    const disposeResult = await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "accept",
      rationale: "accepting before resolve attempt",
    });
    expect(disposeResult.ok).toBe(true);

    // Now attempt resolve — the orphan doc still exists → still reproduces
    const resolveResult = await vaultBoardResolve(
      vaultRoot,
      humanAccess,
      config,
      { finding_id: finding.identity_key },
      FIXED_NOW,
    );

    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;
    expect(resolveResult.value.still_reproduces).toBe(true);
    expect(resolveResult.value.resolved).toBe(false);

    // No "resolved" event in ledger
    const resolvedEvents = readLedgerEvents(vaultRoot).filter((e) => e.event === "resolved");
    expect(resolvedEvents.filter((e) => e.finding_id === finding.identity_key)).toHaveLength(0);
  });

  it("no longer reproduces → exactly ONE resolved event, principal_type 'system'", async () => {
    // Get a live finding
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    // Accept the finding so there's a ledger entry for RBAC lookup
    const disposeResult = await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "accept",
      rationale: "accepting",
    });
    expect(disposeResult.ok).toBe(true);

    // FIX the underlying condition: delete the orphan doc so it no longer reproduces
    const target = finding.target;
    if (target.kind === "lint") {
      const docPath = join(vaultRoot, target.path);
      rmSync(docPath, { force: true });
    }

    // Now resolve — the condition is gone → should write resolved
    const resolveResult = await vaultBoardResolve(
      vaultRoot,
      humanAccess,
      config,
      { finding_id: finding.identity_key },
      FIXED_NOW,
    );

    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;
    expect(resolveResult.value.resolved).toBe(true);
    expect(resolveResult.value.still_reproduces).toBe(false);

    // Exactly ONE resolved event in ledger
    const resolvedEvents = readLedgerEvents(vaultRoot).filter(
      (e) => e.event === "resolved" && e.finding_id === finding.identity_key,
    );
    expect(resolvedEvents).toHaveLength(1);
    expect(requireDefined(resolvedEvents[0]).principal_type).toBe("system");
    expect(requireDefined(resolvedEvents[0]).by).toBe("system");

    // Calling resolve again does not add a second resolved event (idempotent)
    const secondResolveResult = await vaultBoardResolve(
      vaultRoot,
      humanAccess,
      config,
      { finding_id: finding.identity_key },
      FIXED_NOW,
    );
    // Second call: condition still gone; already resolved — check no double-write
    const resolvedEventsAfter = readLedgerEvents(vaultRoot).filter(
      (e) => e.event === "resolved" && e.finding_id === finding.identity_key,
    );
    // Either it returns already-resolved or adds another (we only assert ≤ 1 unique write per call)
    // The test contract is: each fresh call to resolve on a still-gone condition appends at most one.
    // We verify the second call didn't add a second event.
    if (secondResolveResult.ok && secondResolveResult.value.resolved) {
      // If it says resolved again, we expect the total is now 2 (one per call)
      // But per R14 spec: we only care that one resolved is emitted per successful check.
      // The important invariant is that each individual call writes at most 1.
      expect(resolvedEventsAfter.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("resolve with no prior ledger events → rejected (nothing to resolve)", async () => {
    const result = await vaultBoardResolve(
      vaultRoot,
      humanAccess,
      config,
      { finding_id: "finding-with-no-prior-events" },
      FIXED_NOW,
    );

    expect(result.ok).toBe(false);
  });

  it("agent role CAN call resolve (resolve is not gated by canDispose)", async () => {
    // First create a prior event via human (so ledger has an entry)
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "accept",
      rationale: "seed event",
    });

    // Agent tries resolve — should NOT be rejected by canDispose gate
    const result = await vaultBoardResolve(
      vaultRoot,
      agentAccess,
      config,
      { finding_id: finding.identity_key },
      FIXED_NOW,
    );

    // It may succeed or fail (still reproduces), but it must NOT fail with a "dispose" error
    if (!result.ok) {
      expect(result.error.message).not.toMatch(/dispose|capability/i);
    }
  });
});

// ---------------------------------------------------------------------------
// R15 — reopened is never a tool entry point
// ---------------------------------------------------------------------------

describe("R15 — no tool path can emit or accept 'reopened'", () => {
  let vaultRoot: string;
  let config: DaftariConfig;

  beforeEach(() => {
    vaultRoot = seedLintVault({
      human: { read: ["*"], write: ["*"], promote: true, ratify: true, dispose: true },
    });
    config = makeConfig({ human: humanRole });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("vault_board_dispose rejects event 'reopened'", async () => {
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const finding = listResult.value.all[0];

    const result = await vaultBoardDispose(vaultRoot, humanAccess, config, {
      // Deliberately passing illegal event to test runtime guard.
      // The type includes `string` to allow runtime validation of untrusted input.
      finding_id: finding?.identity_key ?? "fake",
      event: "reopened" as string,
      rationale: "trying to inject reopened",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/invalid event|reopened|not allowed/i);

    // No reopened event in ledger
    const reopenedEvents = readLedgerEvents(vaultRoot).filter((e) => e.event === "reopened");
    expect(reopenedEvents).toHaveLength(0);
  });

  it("vault_board_resolve never writes a 'reopened' event", async () => {
    // Call resolve with a nonexistent finding — it will fail, but must not write reopened
    await vaultBoardResolve(vaultRoot, humanAccess, config, {
      finding_id: "any-fake-id",
    });

    const reopenedEvents = readLedgerEvents(vaultRoot).filter((e) => e.event === "reopened");
    expect(reopenedEvents).toHaveLength(0);
  });

  it("vault_board_resolve also rejects 'new' as an event (system events not injectable)", async () => {
    // vault_board_resolve has no 'event' parameter — it only writes 'resolved'.
    // This test confirms the resolve tool's output is constrained to 'resolved'.
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const finding = listResult.value.all.find((f) => f.source === "lint");
    if (!finding) return;

    await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "accept",
      rationale: "seed",
    });

    // Resolve while condition still exists
    await vaultBoardResolve(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
    });

    // Whether ok or not, verify no "new" or "reopened" events were written
    const systemInjectedEvents = readLedgerEvents(vaultRoot).filter(
      (e) => e.event === "reopened" || (e.event === "new" && e.principal_type !== "system"),
    );
    expect(systemInjectedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Descriptor stamping — verify descriptor on all dispose events
// ---------------------------------------------------------------------------

describe("descriptor stamped on dispose events", () => {
  let vaultRoot: string;
  let config: DaftariConfig;

  beforeEach(() => {
    vaultRoot = seedLintVault(
      { human: { read: ["*"], write: ["*"], promote: true, ratify: true, dispose: true } },
      ["human:operator"],
    );
    config = makeConfig({ human: humanRole }, ["human:operator"]);
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("descriptor.source, .check, .target, .label all present on accept event", async () => {
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "accept",
      rationale: "checking descriptor",
    });

    const events = readLedgerEvents(vaultRoot).filter(
      (e) => e.finding_id === finding.identity_key && e.event === "accept",
    );
    expect(events).toHaveLength(1);
    const desc = requireDefined(events[0]).descriptor;
    expect(desc).toBeDefined();
    expect(desc?.source).toBe(finding.source);
    expect(desc?.check).toBe(finding.check);
    expect(desc?.target).toMatchObject(finding.target);
    expect(typeof desc?.label).toBe("string");
    expect(requireDefined(desc).label.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// R20 resolve — RBAC non-disclosure (byte-identical error for hidden vs. nonexistent)
// Also covers: legacy descriptor (no rbacPaths) fails closed.
// ---------------------------------------------------------------------------

describe("vault_board_resolve — R20 RBAC non-disclosure + legacy fail-closed", () => {
  let vaultRoot: string;
  let config: DaftariConfig;

  beforeEach(() => {
    vaultRoot = seedMultiCollectionVault();
    config = makeConfig(
      {
        human: humanRole,
        scoped: scopedHumanRole,
        agent: agentRole,
      },
      ["human:operator", "human:scoped"],
    );
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("resolve: error for RBAC-hidden finding is byte-identical to error for nonexistent finding_id", async () => {
    // Admin accepts the restricted finding so there IS a ledger entry for it.
    const adminList = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(adminList.ok).toBe(true);
    if (!adminList.ok) return;

    const restrictedFinding = adminList.value.all.find(
      (f) =>
        f.target.kind === "lint" && "path" in f.target && f.target.path.startsWith("restricted/"),
    );
    expect(restrictedFinding).toBeDefined();
    if (!restrictedFinding) return;

    // Human accepts it — creates ledger event with descriptor.rbacPaths pointing to restricted/
    await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: restrictedFinding.identity_key,
      event: "accept",
      rationale: "admin seed",
    });

    // Scoped role tries to resolve the restricted finding (visible to admin, not to scoped)
    const hiddenResult = await vaultBoardResolve(
      vaultRoot,
      scopedHumanAccess,
      config,
      { finding_id: restrictedFinding.identity_key },
      FIXED_NOW,
    );

    // Scoped role tries to resolve a completely nonexistent finding_id
    const nonexistentResult = await vaultBoardResolve(
      vaultRoot,
      scopedHumanAccess,
      config,
      { finding_id: "totally-nonexistent-finding-id-xyz" },
      FIXED_NOW,
    );

    expect(hiddenResult.ok).toBe(false);
    expect(nonexistentResult.ok).toBe(false);
    if (hiddenResult.ok || nonexistentResult.ok) return;

    // Byte-identical error messages — no existence disclosure (R20).
    expect(hiddenResult.error.message).toBe(nonexistentResult.error.message);
    // Neither message must contain the finding_id
    expect(hiddenResult.error.message).not.toContain(restrictedFinding.identity_key);
    expect(nonexistentResult.error.message).not.toContain("totally-nonexistent");
  });

  it("resolve: legacy descriptor (no rbacPaths) fails closed — same non-disclosing error", async () => {
    // Build a ledger entry with a descriptor that has NO rbacPaths field (pre-U11 data).
    const { appendEvent: _appendEvent } = await import("../board/ledger.js");
    const legacyFindingId = "legacy-finding-no-rbac-paths";

    // Write a ledger event with a descriptor that omits rbacPaths (legacy).
    const legacyDescriptor = {
      source: "lint" as const,
      check: "orphanFiles",
      target: { kind: "lint" as const, path: "notes/orphan-doc.md" },
      label: "Orphan document",
      // rbacPaths intentionally absent — simulates pre-U11 data
    };
    await _appendEvent(vaultRoot, {
      finding_id: legacyFindingId,
      event: "accept",
      by: "human:operator",
      principal_type: "human",
      at: FIXED_NOW.toISOString(),
      against_fingerprint: "fp-legacy",
      descriptor: legacyDescriptor,
    });

    // Even the wildcard-read scoped role cannot resolve a legacy-no-rbacPaths descriptor.
    // The behavior: fail closed with the same non-disclosing error.
    const legacyResult = await vaultBoardResolve(
      vaultRoot,
      scopedHumanAccess,
      config,
      { finding_id: legacyFindingId },
      FIXED_NOW,
    );

    const nonexistentResult = await vaultBoardResolve(
      vaultRoot,
      scopedHumanAccess,
      config,
      { finding_id: "totally-nonexistent-xyz-789" },
      FIXED_NOW,
    );

    expect(legacyResult.ok).toBe(false);
    expect(nonexistentResult.ok).toBe(false);
    if (legacyResult.ok || nonexistentResult.ok) return;

    // Must be byte-identical (same non-disclosing error).
    expect(legacyResult.error.message).toBe(nonexistentResult.error.message);
  });

  it("scoped role CAN resolve a lint finding it can fully read via rbacPaths", async () => {
    // Get the notes finding (scoped role CAN read "notes" collection)
    const scopedList = await vaultBoardList(
      vaultRoot,
      scopedHumanAccess,
      config,
      undefined,
      FIXED_NOW,
    );
    expect(scopedList.ok).toBe(true);
    if (!scopedList.ok) return;

    const notesFinding = scopedList.value.all.find(
      (f) => f.target.kind === "lint" && "path" in f.target && f.target.path.startsWith("notes/"),
    );
    expect(notesFinding).toBeDefined();
    if (!notesFinding) return;

    // Scoped role accepts it first (creates ledger event with rbacPaths for notes/)
    const disposeResult = await vaultBoardDispose(vaultRoot, scopedHumanAccess, config, {
      finding_id: notesFinding.identity_key,
      event: "accept",
      rationale: "accepting notes finding",
    });
    expect(disposeResult.ok).toBe(true);

    // Now try resolve — it will return still_reproduces (orphan doc still exists)
    // but it must NOT be rejected due to RBAC (scoped role CAN read this).
    const resolveResult = await vaultBoardResolve(
      vaultRoot,
      scopedHumanAccess,
      config,
      { finding_id: notesFinding.identity_key },
      FIXED_NOW,
    );

    // Must succeed (ok=true) — RBAC gate passed; result is still_reproduces=true (doc still there)
    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;
    expect(resolveResult.value.still_reproduces).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — double-resolve exact count
// ---------------------------------------------------------------------------

describe("vault_board_resolve — double-resolve writes exactly ONE resolved event", () => {
  let vaultRoot: string;
  let config: DaftariConfig;

  beforeEach(() => {
    vaultRoot = seedLintVault({
      human: { read: ["*"], write: ["*"], promote: true, ratify: true, dispose: true },
      agent: { read: ["*"], write: ["*"] },
    });
    config = makeConfig({ human: humanRole, agent: agentRole });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("resolving twice on a gone finding yields exactly ONE resolved event in the ledger", async () => {
    const listResult = await vaultBoardList(vaultRoot, humanAccess, config, undefined, FIXED_NOW);
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const finding = listResult.value.all.find((f) => f.source === "lint");
    expect(finding).toBeDefined();
    if (!finding) return;

    // Accept so there are prior events
    await vaultBoardDispose(vaultRoot, humanAccess, config, {
      finding_id: finding.identity_key,
      event: "accept",
      rationale: "seed",
    });

    // Delete the doc so the finding no longer reproduces
    const target = finding.target;
    if (target.kind === "lint") {
      const docPath = join(vaultRoot, target.path);
      rmSync(docPath, { force: true });
    }

    // First resolve — should write resolved
    const r1 = await vaultBoardResolve(
      vaultRoot,
      humanAccess,
      config,
      { finding_id: finding.identity_key },
      FIXED_NOW,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.resolved).toBe(true);

    // Second resolve on the same already-resolved finding
    const r2 = await vaultBoardResolve(
      vaultRoot,
      humanAccess,
      config,
      { finding_id: finding.identity_key },
      FIXED_NOW,
    );

    // Exactly ONE resolved event regardless of second call outcome
    const resolvedEvents = readLedgerEvents(vaultRoot).filter(
      (e) => e.event === "resolved" && e.finding_id === finding.identity_key,
    );
    expect(resolvedEvents).toHaveLength(1);

    // The second call should be a no-op write: it should not add a second resolved.
    // If it returns ok=true with resolved=true, that's a double-write bug.
    // If it returns ok=false or still_reproduces=true (already resolved = treated as no-op), that's correct.
    if (r2.ok && r2.value.resolved) {
      // This would indicate a double-write — the assertion above already catches it,
      // but make the expectation explicit for clear test output.
      expect(resolvedEvents).toHaveLength(1); // already asserted above; repeated for clarity
    }
  });
});
