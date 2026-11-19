// Bead 9mpe — every review decision surface stamps decided_by_kind (from the
// authenticated principal, never the caller's claim), changed_anything, and a
// review-journal event; board and docket surfacings record first-shown.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { boardDispositionsPath } from "../../src/board/ledger.js";
import { runCourt } from "../../src/court/index.js";
import {
  type DecisionEvent,
  docReviewItem,
  readReviewEvents,
} from "../../src/curation/review-log.js";
import {
  getStagedActionById,
  stageAction,
  stagedActionsPath,
  sweepExpiredActions,
} from "../../src/curation/staged-actions.js";
import { addTension, resolveTension } from "../../src/curation/tension.js";
import { vaultBoardDispose, vaultBoardList } from "../../src/tools/board.js";
import { vaultTensionResolve } from "../../src/tools/curation.js";
import { vaultRatify } from "../../src/tools/staged-actions.js";
import { vaultWrite, writeTools } from "../../src/tools/write.js";
import { loadConfig } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const ROLE = { read: ["*"], write: ["*"], promote: true, ratify: true, dispose: true };
const HUMAN: AccessContext = { user: "mihir", roleName: "admin", role: ROLE };
const AGENT: AccessContext = { user: "mavaali", roleName: "admin", role: ROLE };

function writeConfig(vault: string, extra = ""): void {
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(
    join(vault, ".daftari", "config.yaml"),
    [
      "version: 1",
      "roles:",
      "  admin: { read: ['*'], write: ['*'], promote: true, ratify: true, dispose: true }",
      "principal_kinds:",
      "  mihir: human",
      "  mavaali: agent",
      extra,
      "",
    ].join("\n"),
  );
}

async function seed(vault: string, path: string): Promise<void> {
  const written = await vaultWrite(vault, {
    path,
    body: `# Note\n\nBody of ${path}.\n`,
    frontmatter: {
      title: "A Note",
      domain: "accumulation",
      collection: "pricing",
      status: "draft",
      confidence: "medium",
      created: "2026-05-01",
      provenance: "direct",
      sources: [],
      superseded_by: null,
      ttl_days: 90,
      tags: ["note"],
    },
    agent: "agent:seed",
  });
  if (!written.ok) throw written.error;
}

async function stagePromote(vault: string, path: string, proposedAt?: string): Promise<string> {
  const staged = await stageAction(vault, {
    actionType: "promote",
    targetPath: path,
    proposedBy: "agent:loop",
    rationale: "Matured.",
    proposedDiff: {},
    ...(proposedAt ? { proposedAt } : {}),
  });
  if (!staged.ok) throw staged.error;
  return staged.value.id;
}

function decisions(vault: string): DecisionEvent[] {
  return readReviewEvents(vault).filter((e): e is DecisionEvent => e.ev === "decision");
}

function lastStagedRecord(vault: string): Record<string, unknown> {
  const lines = readFileSync(stagedActionsPath(vault), "utf-8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
}

async function logTension(vault: string): Promise<string> {
  const t = await addTension(vault, {
    title: "Price conflict",
    kind: "factual",
    sourceA: "pricing/a.md",
    claimA: "A says 10",
    sourceB: "pricing/b.md",
    claimB: "B says 12",
    loggedBy: "system:tension-scan",
  });
  if (!t.ok) throw t.error;
  return t.value.id as string;
}

describe("review instrumentation (9mpe)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
    writeConfig(vault);
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  describe("staged actions", () => {
    it("a reject is stamped from the authenticated principal, not the caller's claim", async () => {
      await seed(vault, "pricing/draft.md");
      const id = await stagePromote(vault, "pricing/draft.md");
      const r = await vaultRatify(
        vault,
        { id, decision: "reject", principal: "human:mihir" }, // the claim
        AGENT, // the authenticated identity
      );
      expect(r.ok).toBe(true);
      expect(lastStagedRecord(vault)).toMatchObject({
        status: "rejected",
        decided_by_kind: "agent",
      });
      expect(decisions(vault)).toEqual([
        expect.objectContaining({
          surface: "staged",
          item: id,
          action: "rejected",
          decided_by_kind: "agent",
          changed_anything: false,
        }),
      ]);
    }, 60_000);

    it("an approve that wrote is changed_anything; the dispatched promote is not double-counted", async () => {
      await seed(vault, "pricing/draft.md");
      const id = await stagePromote(vault, "pricing/draft.md");
      const r = await vaultRatify(vault, { id, decision: "approve", principal: "x" }, HUMAN);
      expect(r.ok).toBe(true);
      const ds = decisions(vault);
      expect(ds).toHaveLength(1);
      expect(ds[0]).toMatchObject({
        surface: "staged",
        item: id,
        action: "ratified",
        decided_by_kind: "human",
        changed_anything: true,
      });
      const action = await getStagedActionById(vault, id);
      if (!action.ok) throw action.error;
      expect(action.value?.decidedByKind).toBe("human");
    }, 60_000);

    it("the expiry sweep is an agent decision that changed nothing", async () => {
      await seed(vault, "pricing/draft.md");
      const id = await stagePromote(vault, "pricing/draft.md", "2020-01-01T00:00:00Z");
      const swept = await sweepExpiredActions(vault, new Date("2026-01-01T00:00:00Z"));
      if (!swept.ok) throw swept.error;
      expect(swept.value.expired).toEqual([id]);
      expect(lastStagedRecord(vault)).toMatchObject({
        status: "expired",
        decided_by_kind: "agent",
      });
      expect(decisions(vault)[0]).toMatchObject({
        item: id,
        action: "expired",
        decided_by_kind: "agent",
        changed_anything: false,
      });
    }, 60_000);

    it("an old decision record without decided_by_kind reads as unknown", async () => {
      await seed(vault, "pricing/draft.md");
      const id = await stagePromote(vault, "pricing/draft.md");
      appendFileSync(
        stagedActionsPath(vault),
        `${JSON.stringify({ id, status: "rejected", ratified_at: "2026-01-01T00:00:00Z", ratified_by: "x" })}\n`,
      );
      const action = await getStagedActionById(vault, id);
      if (!action.ok) throw action.error;
      expect(action.value?.decidedByKind).toBe("unknown");
    }, 60_000);
  });

  it("a direct vault_promote records a promote decision with a hashed item", async () => {
    await seed(vault, "pricing/draft.md");
    const tool = writeTools.find((t) => t.name === "vault_promote");
    if (!tool) throw new Error("vault_promote missing");
    const r = await tool.handler(vault, { path: "pricing/draft.md", agent: "human:me" }, AGENT);
    expect((r as { ok: boolean }).ok).toBe(true);
    expect(decisions(vault)).toEqual([
      expect.objectContaining({
        surface: "promote",
        item: docReviewItem("pricing/draft.md"),
        action: "promote",
        decided_by_kind: "agent",
        changed_anything: true,
      }),
    ]);
    expect(readFileSync(join(vault, ".daftari", "review-log.jsonl"), "utf-8")).not.toContain(
      "pricing/draft.md",
    );
  }, 60_000);

  describe("tensions", () => {
    it("logging appends tension_open; resolving appends a decision with the caller's kind", async () => {
      const id = await logTension(vault);
      expect(readReviewEvents(vault)).toEqual([
        expect.objectContaining({ ev: "tension_open", item: id }),
      ]);
      const r = await vaultTensionResolve(
        vault,
        { id, kind: "accepted", rationale: "both true" },
        HUMAN,
      );
      expect(r.ok).toBe(true);
      expect(decisions(vault)).toEqual([
        expect.objectContaining({
          surface: "tension",
          item: id,
          action: "accepted",
          decided_by_kind: "human",
          changed_anything: false,
        }),
      ]);
      // No content in the journal.
      const raw = readFileSync(join(vault, ".daftari", "review-log.jsonl"), "utf-8");
      expect(raw).not.toContain("Price conflict");
      expect(raw).not.toContain("both true");
      expect(raw).not.toContain("pricing/a.md");
    });

    it("an in-process resolve without a kind records unknown", async () => {
      const id = await logTension(vault);
      const r = await resolveTension(vault, id, {
        resolved_at: new Date().toISOString(),
        resolved_by: "human:claimed",
        kind: "accepted",
      });
      expect(r.ok).toBe(true);
      expect(decisions(vault)[0]).toMatchObject({ item: id, decided_by_kind: "unknown" });
    });
  });

  describe("board", () => {
    it("listing records first-shown per viewer kind; dispose stamps decided_by_kind", async () => {
      await seed(vault, "pricing/draft.md");
      const stageId = await stagePromote(vault, "pricing/draft.md");
      const config = loadConfig(vault);
      if (!config.ok) throw config.error;

      const listed = await vaultBoardList(vault, HUMAN, config.value);
      if (!listed.ok) throw listed.error;
      const finding = listed.value.all.find(
        (f) => f.target.kind === "staged" && f.target.stagedActionId === stageId,
      );
      if (!finding) throw new Error("staged finding missing from board");
      const shown = readReviewEvents(vault).filter((e) => e.ev === "shown");
      expect(shown).toContainEqual(
        expect.objectContaining({ surface: "board", item: stageId, viewer_kind: "human" }),
      );
      // A second listing adds no duplicate.
      await vaultBoardList(vault, HUMAN, config.value);
      expect(
        readReviewEvents(vault).filter((e) => e.ev === "shown" && e.item === stageId),
      ).toHaveLength(1);

      const disposed = await vaultBoardDispose(vault, HUMAN, config.value, {
        finding_id: finding.identity_key,
        event: "dismiss",
        rationale: "noise",
      });
      if (!disposed.ok) throw disposed.error;
      expect(disposed.value.event.decided_by_kind).toBe("human");
      const ledger = readFileSync(boardDispositionsPath(vault), "utf-8");
      expect(ledger).toContain('"decided_by_kind":"human"');
      expect(decisions(vault)).toContainEqual(
        expect.objectContaining({
          surface: "board",
          item: stageId,
          action: "dismiss",
          decided_by_kind: "human",
          changed_anything: false,
        }),
      );
    }, 60_000);
  });

  describe("court docket", () => {
    it("printing the docket records shown for open tensions, attributed to the CLI principal", async () => {
      writeConfig(vault, `  'cli:${userInfo().username}': human`);
      const id = await logTension(vault);
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(await runCourt(["--vault", vault])).toBe(0);
      } finally {
        out.mockRestore();
      }
      expect(readReviewEvents(vault).filter((e) => e.ev === "shown")).toEqual([
        expect.objectContaining({ surface: "docket", item: id, viewer_kind: "human" }),
      ]);
    });
  });
});
