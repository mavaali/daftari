// Risk-triaged ratification — the risk scorer (2026-07-26 spec, Decision 1;
// final plan Phase 4). Pure-function tests: each term isolated with
// hand-built fixtures, plus the C1/C4/C5 challenge dispositions and the
// spec's own motivating example.

import { describe, expect, it } from "vitest";
import {
  DIFF_BUCKET_THRESHOLDS,
  HIDDEN_BLAST_BUMP,
  RISK_KIND_WEIGHTS,
  RISK_TERM_WEIGHTS,
  rankPendingActions,
} from "../../src/curation/risk.js";
import type { StagedAction } from "../../src/curation/staged-actions.js";
import type { TensionEntry } from "../../src/curation/tension.js";
import type { LoadedDoc } from "../../src/curation/vault-docs.js";
import type { Frontmatter } from "../../src/frontmatter/types.js";

const NOW = new Date("2026-06-10T00:00:00Z");

function mkAction(overrides: Partial<StagedAction> = {}): StagedAction {
  return {
    id: "stage-001",
    actionType: "confidence-up",
    targetPath: "pricing/a.md",
    proposedBy: "agent:proposer",
    proposedAt: "2026-06-01T00:00:00Z",
    expiresAt: "2026-06-15T00:00:00Z",
    status: "pending",
    rationale: "Rationale.",
    proposedDiff: {},
    ratifiedAt: null,
    ratifiedBy: null,
    ratificationReason: null,
    decidedByPrincipal: null,
    runId: null,
    decisionKind: null,
    reasonCategory: null,
    amendedDiff: null,
    stagedByPrincipal: null,
    riskAtDecision: null,
    ...overrides,
  };
}

function mkDoc(path: string, overrides: Partial<Frontmatter> = {}, content = ""): LoadedDoc {
  const fm: Frontmatter = {
    title: path,
    domain: "accumulation",
    collection: path.split("/")[0] ?? "",
    status: "canonical",
    confidence: "medium",
    created: "2026-01-01",
    updated: "2026-01-01",
    updated_by: "agent:test",
    provenance: "direct",
    tier: null,
    sources: [],
    superseded_by: null,
    ttl_days: null,
    valid_from: null,
    valid_until: null,
    tags: [],
    describes: [],
    questions_answered: [],
    questions_raised: [],
    ...overrides,
  };
  return { path, frontmatter: fm, content, validation: { valid: true, issues: [] } };
}

function mkTension(overrides: Partial<TensionEntry> = {}): TensionEntry {
  return {
    id: "tension-001",
    date: "2026-06-01",
    title: "T",
    kind: "factual",
    sourceA: "pricing/a.md",
    claimA: "x",
    sourceB: "pricing/b.md",
    claimB: "y",
    status: "unresolved",
    loggedBy: "agent:x",
    resolved: false,
    ...overrides,
  };
}

// D term, verbatim from the spec: min(1, log10(1+bytes)/4).
function expectedD(bytes: number): number {
  return Math.min(1, Math.log10(1 + bytes) / 4);
}

// Pads a JSON object to an EXACT serialized byte count using plain ASCII
// (no escaping edge cases), so diff-bucket boundary tests land exactly on
// 255/256/4095/4096.
function diffOfBytes(targetBytes: number): unknown {
  let note = "";
  while (Buffer.byteLength(JSON.stringify({ note }), "utf-8") < targetBytes) note += "x";
  return { note };
}

describe("risk.ts — rankPendingActions", () => {
  describe("K — action-kind weight", () => {
    it("orders a supersede above a confidence-up, all else equal", () => {
      const confidenceUp = mkAction({ id: "stage-001", actionType: "confidence-up" });
      const supersede = mkAction({
        id: "stage-002",
        actionType: "supersede",
        targetPath: "pricing/b.md",
      });
      const { items } = rankPendingActions({
        actions: [confidenceUp, supersede],
        docs: [],
        tensions: [],
        now: NOW,
      });
      const a = items.find((i) => i.id === "stage-001");
      const b = items.find((i) => i.id === "stage-002");
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(RISK_KIND_WEIGHTS["confidence-up"]).toBe(0.2);
      expect(RISK_KIND_WEIGHTS.supersede).toBe(1.0);
      expect(b?.risk).toBeGreaterThan(a?.risk ?? 0);
      // K's contribution alone: 0.3 * (1.0 - 0.2) = 0.24 — larger than every
      // other term's max possible swing except B, so it should dominate here
      // since B/T/C are both 0 for these targets (empty docs/tensions).
      expect((b?.risk ?? 0) - (a?.risk ?? 0)).toBeCloseTo(RISK_TERM_WEIGHTS.K * 0.8, 3);
    });

    it("defaults an unknown action kind to write's weight (fail toward scrutiny)", () => {
      const unknown = mkAction({ actionType: "frobnicate" as unknown as string });
      const { items } = rankPendingActions({
        actions: [unknown],
        docs: [],
        tensions: [],
        now: NOW,
      });
      const write = mkAction({ id: "stage-002", actionType: "write", targetPath: "pricing/b.md" });
      const { items: writeItems } = rankPendingActions({
        actions: [write],
        docs: [],
        tensions: [],
        now: NOW,
      });
      expect(items[0]?.risk).toBeCloseTo(writeItems[0]?.risk ?? -1, 3);
    });
  });

  describe("D — proposed-diff size and the byte-bucket (C3)", () => {
    it("matches the spec's log-scaled formula", () => {
      const action = mkAction({ proposedDiff: diffOfBytes(1000) });
      const { items } = rankPendingActions({ actions: [action], docs: [], tensions: [], now: NOW });
      const bytes = Buffer.byteLength(JSON.stringify(action.proposedDiff), "utf-8");
      const K = RISK_KIND_WEIGHTS["confidence-up"] ?? 0;
      const W = 0.5; // fresh proposer, Laplace midpoint
      const expected =
        RISK_TERM_WEIGHTS.K * K + RISK_TERM_WEIGHTS.D * expectedD(bytes) + RISK_TERM_WEIGHTS.W * W;
      expect(items[0]?.risk).toBeCloseTo(expected, 3);
    });

    it("buckets small < 256 bytes, medium in [256, 4096), large >= 4096 bytes (C3 disposition)", () => {
      const cases: Array<[number, "small" | "medium" | "large"]> = [
        [DIFF_BUCKET_THRESHOLDS.mediumBytes - 1, "small"],
        [DIFF_BUCKET_THRESHOLDS.mediumBytes, "medium"],
        [DIFF_BUCKET_THRESHOLDS.largeBytes - 1, "medium"],
        [DIFF_BUCKET_THRESHOLDS.largeBytes, "large"],
      ];
      for (const [bytes, bucket] of cases) {
        const diff = diffOfBytes(bytes);
        expect(Buffer.byteLength(JSON.stringify(diff), "utf-8")).toBe(bytes);
        const action = mkAction({ proposedDiff: diff });
        const { items } = rankPendingActions({
          actions: [action],
          docs: [],
          tensions: [],
          now: NOW,
        });
        expect(items[0]?.diffBucket).toBe(bucket);
      }
    });

    it("a constant-size lifecycle pointer (empty proposedDiff) reads small", () => {
      const action = mkAction({
        actionType: "supersede",
        proposedDiff: { superseded_by: "pricing/b.md" },
      });
      const { items } = rankPendingActions({ actions: [action], docs: [], tensions: [], now: NOW });
      expect(items[0]?.diffBucket).toBe("small");
    });
  });

  describe("B — blast radius, direct inbound only", () => {
    it("counts direct source and link inbound, source wins on overlap", () => {
      const target = mkDoc("pricing/target.md");
      const viaSource = mkDoc("pricing/s1.md", { sources: ["pricing/target.md"] });
      const viaLink = mkDoc("pricing/l1.md", {}, "See [target](target.md).");
      const viaBoth = mkDoc(
        "pricing/both.md",
        { sources: ["pricing/target.md"] },
        "See [t](target.md).",
      );
      const docs = [target, viaSource, viaLink, viaBoth];
      const action = mkAction({ targetPath: "pricing/target.md" });
      const { items } = rankPendingActions({ actions: [action], docs, tensions: [], now: NOW });
      // primary: s1 + both (both wins primary over link on overlap); advisory: l1 only.
      expect(items[0]?.blast.primary).toBe(2);
      expect(items[0]?.blast.advisory).toBe(1);
      expect(items[0]?.blast.hidden).toBe("none");
    });

    it("coarsens hidden inbound to none/some/many, never an exact count (Decision 4)", () => {
      const target = mkDoc("pricing/target.md");
      const visible = mkDoc("pricing/visible.md", { sources: ["pricing/target.md"] });
      const hidden1 = mkDoc("secret/hidden1.md", {
        collection: "secret",
        sources: ["pricing/target.md"],
      });
      const docs = [target, visible, hidden1];
      const action = mkAction({ targetPath: "pricing/target.md" });
      const pathVisible = (p: string) => !p.startsWith("secret/");

      const { items } = rankPendingActions({
        actions: [action],
        docs,
        tensions: [],
        now: NOW,
        pathVisible,
      });
      expect(items[0]?.blast.primary).toBe(1); // only 'visible' counted
      expect(items[0]?.blast.hidden).toBe("some"); // coarsened bucket, not the exact hidden count (1)
    });

    it("bumps B by the hidden-bucket amount when part of the inbound is hidden", () => {
      const target = mkDoc("pricing/target.md");
      const visible = mkDoc("pricing/visible.md", { sources: ["pricing/target.md"] });
      const hidden = mkDoc("secret/hidden.md", {
        collection: "secret",
        sources: ["pricing/target.md"],
      });
      const docs = [target, visible, hidden];
      const action = mkAction({ targetPath: "pricing/target.md" });
      const pathVisible = (p: string) => !p.startsWith("secret/");

      const { items } = rankPendingActions({
        actions: [action],
        docs,
        tensions: [],
        now: NOW,
        pathVisible,
      });
      const B = Math.min(1, 1 / 10 + 0 / 40 + HIDDEN_BLAST_BUMP.some);
      const K = RISK_KIND_WEIGHTS["confidence-up"] ?? 0;
      const W = 0.5;
      const expected =
        RISK_TERM_WEIGHTS.K * K +
        RISK_TERM_WEIGHTS.D * expectedD(2) +
        RISK_TERM_WEIGHTS.B * B +
        RISK_TERM_WEIGHTS.W * W;
      expect(items[0]?.risk).toBeCloseTo(expected, 3);
    });
  });

  describe("T — open tension, endpoints canonicalized (C5)", () => {
    it("an interpretive tension flips T (independence-spec compatibility, kind-blind)", () => {
      const action = mkAction({ targetPath: "pricing/a.md" });
      const tension = mkTension({
        kind: "interpretive",
        sourceA: "pricing/a.md",
        sourceB: "pricing/b.md",
      });
      const { items } = rankPendingActions({
        actions: [action],
        docs: [],
        tensions: [tension],
        now: NOW,
      });
      expect(items[0]?.openTension).toBe(true);
    });

    it("a resolved tension does not flip T", () => {
      const action = mkAction({ targetPath: "pricing/a.md" });
      const tension = mkTension({ resolved: true });
      const { items } = rankPendingActions({
        actions: [action],
        docs: [],
        tensions: [tension],
        now: NOW,
      });
      expect(items[0]?.openTension).toBe(false);
    });

    it("a basename-spelled tension endpoint flips T on a canonical-relPath target (C5)", () => {
      const doc = mkDoc("competitive-intel/pricing-model.md");
      const action = mkAction({ targetPath: "competitive-intel/pricing-model.md" });
      const tension = mkTension({
        sourceA: "pricing-model", // basename, no extension, no directory
        sourceB: "unrelated.md",
      });
      const { items } = rankPendingActions({
        actions: [action],
        docs: [doc],
        tensions: [tension],
        now: NOW,
      });
      expect(items[0]?.openTension).toBe(true);
    });

    it("an unresolvable endpoint falls back to the raw string, never false-matching a live target", () => {
      const action = mkAction({ targetPath: "pricing/a.md" });
      const tension = mkTension({
        sourceA: "deleted-doc-that-never-existed.md",
        sourceB: "also-gone.md",
      });
      const { items } = rankPendingActions({
        actions: [action],
        docs: [],
        tensions: [tension],
        now: NOW,
      });
      expect(items[0]?.openTension).toBe(false);
    });
  });

  describe("C — conflict / retry markers (C1 disposition)", () => {
    it("clause (a): another pending action sharing the target sets C for both", () => {
      const a = mkAction({ id: "stage-001", targetPath: "pricing/a.md" });
      const b = mkAction({ id: "stage-002", targetPath: "pricing/a.md" });
      const { items } = rankPendingActions({ actions: [a, b], docs: [], tensions: [], now: NOW });
      expect(items.every((i) => i.conflict)).toBe(true);
    });

    it("clause (b): a prior rejected action with no later ratify sets C on a fresh retry", () => {
      const rejected = mkAction({
        id: "stage-001",
        actionType: "promote",
        targetPath: "pricing/a.md",
        status: "rejected",
        ratifiedAt: "2026-06-02T00:00:00Z",
      });
      const retry = mkAction({
        id: "stage-002",
        actionType: "promote",
        targetPath: "pricing/a.md",
        status: "pending",
      });
      const { items } = rankPendingActions({
        actions: [rejected, retry],
        docs: [],
        tensions: [],
        now: NOW,
      });
      const item = items.find((i) => i.id === "stage-002");
      expect(item?.conflict).toBe(true);
    });

    it("an EXPIRED same-pair record does not set C — expiry cost lives only in W", () => {
      const expired = mkAction({
        id: "stage-001",
        actionType: "promote",
        targetPath: "pricing/a.md",
        status: "expired",
        ratifiedAt: "2026-06-02T00:00:00Z",
        ratifiedBy: "system:lint-sweep",
      });
      const retry = mkAction({
        id: "stage-002",
        actionType: "promote",
        targetPath: "pricing/a.md",
        status: "pending",
      });
      const { items } = rankPendingActions({
        actions: [expired, retry],
        docs: [],
        tensions: [],
        now: NOW,
      });
      const item = items.find((i) => i.id === "stage-002");
      expect(item?.conflict).toBe(false);
    });

    it("a later ratified same-pair record clears the retry mark (C1)", () => {
      const rejected = mkAction({
        id: "stage-001",
        actionType: "promote",
        targetPath: "pricing/a.md",
        status: "rejected",
        ratifiedAt: "2026-06-01T00:00:00Z",
      });
      const laterRatified = mkAction({
        id: "stage-002",
        actionType: "promote",
        targetPath: "pricing/a.md",
        status: "ratified",
        ratifiedAt: "2026-06-03T00:00:00Z",
      });
      const pending = mkAction({
        id: "stage-003",
        actionType: "promote",
        targetPath: "pricing/a.md",
        status: "pending",
      });
      const { items } = rankPendingActions({
        actions: [rejected, laterRatified, pending],
        docs: [],
        tensions: [],
        now: NOW,
      });
      const item = items.find((i) => i.id === "stage-003");
      expect(item?.conflict).toBe(false);
    });

    it("a retry restaged under a DIFFERENT action kind does not trip C", () => {
      const rejected = mkAction({
        id: "stage-001",
        actionType: "promote",
        targetPath: "pricing/a.md",
        status: "rejected",
        ratifiedAt: "2026-06-01T00:00:00Z",
      });
      const differentKind = mkAction({
        id: "stage-002",
        actionType: "confidence-up",
        targetPath: "pricing/a.md",
        status: "pending",
      });
      const { items } = rankPendingActions({
        actions: [rejected, differentKind],
        docs: [],
        tensions: [],
        now: NOW,
      });
      expect(items[0]?.conflict).toBe(false);
    });
  });

  describe("W — proposer track record, Laplace-smoothed", () => {
    it("defaults an unseen principal to the Laplace midpoint 0.5", () => {
      const action = mkAction({ proposedBy: "agent:brand-new" });
      const { items } = rankPendingActions({ actions: [action], docs: [], tensions: [], now: NOW });
      expect(items[0]?.proposerTrackRecord).toBeCloseTo(0.5, 3);
    });

    it("is unchanged by proposed_by rotation under one authenticated stagedByPrincipal (C4)", () => {
      const decided = [
        mkAction({
          id: "stage-001",
          proposedBy: "agent:rotating-alpha",
          stagedByPrincipal: "human:mihir",
          status: "rejected",
          ratifiedAt: "2026-06-02T00:00:00Z",
        }),
        mkAction({
          id: "stage-002",
          proposedBy: "agent:rotating-beta",
          stagedByPrincipal: "human:mihir",
          status: "rejected",
          ratifiedAt: "2026-06-03T00:00:00Z",
        }),
      ];
      const pendingRotated = mkAction({
        id: "stage-003",
        proposedBy: "agent:rotating-gamma",
        stagedByPrincipal: "human:mihir",
        targetPath: "pricing/rotated.md",
      });
      const rotated = rankPendingActions({
        actions: [...decided, pendingRotated],
        docs: [],
        tensions: [],
        now: NOW,
      });

      const decidedStatic = [
        mkAction({
          id: "stage-001",
          proposedBy: "human:mihir",
          stagedByPrincipal: "human:mihir",
          status: "rejected",
          ratifiedAt: "2026-06-02T00:00:00Z",
        }),
        mkAction({
          id: "stage-002",
          proposedBy: "human:mihir",
          stagedByPrincipal: "human:mihir",
          status: "rejected",
          ratifiedAt: "2026-06-03T00:00:00Z",
        }),
      ];
      const pendingStatic = mkAction({
        id: "stage-003",
        proposedBy: "human:mihir",
        stagedByPrincipal: "human:mihir",
        targetPath: "pricing/rotated.md",
      });
      const staticResult = rankPendingActions({
        actions: [...decidedStatic, pendingStatic],
        docs: [],
        tensions: [],
        now: NOW,
      });

      expect(rotated.items[0]?.proposerTrackRecord).toBeCloseTo(
        staticResult.items[0]?.proposerTrackRecord ?? -1,
        6,
      );
      // Two rejections, no ratifies/edits/expiries: (2 + 1) / (0 + 2 + 2) = 0.75.
      expect(rotated.items[0]?.proposerTrackRecord).toBeCloseTo(0.75, 3);
    });

    it("an edited approval is not double-counted (plainRatified = ratified - edited)", () => {
      const edited = mkAction({
        id: "stage-001",
        proposedBy: "agent:editor",
        status: "ratified",
        decisionKind: "edit-then-approve",
        ratifiedAt: "2026-06-02T00:00:00Z",
      });
      const pending = mkAction({
        id: "stage-002",
        proposedBy: "agent:editor",
        targetPath: "pricing/other.md",
      });
      const { items } = rankPendingActions({
        actions: [edited, pending],
        docs: [],
        tensions: [],
        now: NOW,
      });
      // plainRatified = 1 - 1 = 0; rejected=0, edited=1, expired=0:
      // (0 + 1 + 0 + 1) / (0 + 0 + 1 + 0 + 2) = 2/3.
      expect(items[0]?.proposerTrackRecord).toBeCloseTo(2 / 3, 3);
    });
  });

  describe("sort order: risk descending, expiry-ascending tiebreak, id tiebreak", () => {
    it("the spec's motivating example: a heavily-cited supersede outranks a typo-fix confidence-up despite expiring later", () => {
      const heavilyCited = mkDoc("pricing/hot.md");
      const inbound = Array.from({ length: 10 }, (_, i) =>
        mkDoc(`pricing/dep-${i}.md`, { sources: ["pricing/hot.md"] }),
      );
      const docs = [heavilyCited, ...inbound];

      const typoFix = mkAction({
        id: "stage-001",
        actionType: "confidence-up",
        targetPath: "pricing/cold.md",
        expiresAt: "2026-06-11T00:00:00Z", // Tuesday — expires sooner
      });
      const supersede = mkAction({
        id: "stage-002",
        actionType: "supersede",
        targetPath: "pricing/hot.md",
        expiresAt: "2026-06-13T00:00:00Z", // Thursday — expires later
        proposedDiff: { superseded_by: "pricing/hot-v2.md" },
      });

      const { items } = rankPendingActions({
        actions: [typoFix, supersede],
        docs,
        tensions: [],
        now: NOW,
      });
      expect(items[0]?.id).toBe("stage-002");
      expect(items[1]?.id).toBe("stage-001");
    });

    it("breaks a risk tie by soonest-to-expire, then by id", () => {
      const a = mkAction({
        id: "stage-002",
        expiresAt: "2026-06-20T00:00:00Z",
        targetPath: "pricing/a.md",
      });
      const b = mkAction({
        id: "stage-001",
        expiresAt: "2026-06-12T00:00:00Z",
        targetPath: "pricing/b.md",
      });
      const { items } = rankPendingActions({ actions: [a, b], docs: [], tensions: [], now: NOW });
      expect(items[0]?.risk).toBeCloseTo(items[1]?.risk ?? -1, 6);
      expect(items.map((i) => i.id)).toEqual(["stage-001", "stage-002"]);
    });
  });

  describe("vantage filtering (Decision 4)", () => {
    it("omits a pending item whose target is unreadable and buckets the remainder", () => {
      const visible = mkAction({ id: "stage-001", targetPath: "pricing/open.md" });
      const hidden = mkAction({ id: "stage-002", targetPath: "secret/hidden.md" });
      const pathVisible = (p: string) => !p.startsWith("secret/");
      const { items, hiddenPending } = rankPendingActions({
        actions: [visible, hidden],
        docs: [],
        tensions: [],
        now: NOW,
        pathVisible,
      });
      expect(items.map((i) => i.id)).toEqual(["stage-001"]);
      expect(hiddenPending).toBe("some");
    });

    it("reports 'none' hidden under an operator run (no pathVisible)", () => {
      const a = mkAction({ id: "stage-001" });
      const { hiddenPending } = rankPendingActions({
        actions: [a],
        docs: [],
        tensions: [],
        now: NOW,
      });
      expect(hiddenPending).toBe("none");
    });
  });
});
