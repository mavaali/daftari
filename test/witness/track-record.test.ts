// The position wager book (multi-user witness): positions are staked by the
// same schedule as doc claims, settled by the CURRENT ratification —
// org_position.dissent burns (unless standing via an `accepted` resolution),
// alignment at ratify time credits, self-revision is structurally free, and
// pos-000 legacy snapshots price nothing. Everything is read-time from
// visible frontmatter + visible tensions; no new persistent state.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { recordProvenance } from "../../src/curation/provenance.js";
import { addTension, resolveTension } from "../../src/curation/tension.js";
import {
  buildWitness,
  POSITION_RATIFIED_CREDIT,
  WAGER_STAKES,
} from "../../src/witness/track-record.js";

const TODAY = new Date().toISOString().slice(0, 10);

let vault: string;

interface PositionSpec {
  id: string;
  principal: string;
  stance: string;
  confidence: string;
  created?: string;
  superseded_by?: string | null;
}

interface OrgPositionSpec {
  stance: string;
  confidence?: string;
  ratified_by?: string;
  ratified_at: string;
  dissent: string[];
}

function positionYaml(p: PositionSpec): string {
  return [
    `  - id: "${p.id}"`,
    `    principal: "${p.principal}"`,
    `    stance: "${p.stance}"`,
    `    statement: null`,
    `    confidence: "${p.confidence}"`,
    `    provenance: "direct"`,
    `    valid_from: null`,
    `    superseded_by: ${p.superseded_by ? `"${p.superseded_by}"` : "null"}`,
    `    created: "${p.created ?? TODAY}"`,
    `    sources: []`,
  ].join("\n");
}

function orgPositionYaml(o: OrgPositionSpec): string {
  const dissent =
    o.dissent.length === 0
      ? "  dissent: []"
      : `  dissent:\n${o.dissent.map((d) => `    - "${d}"`).join("\n")}`;
  return [
    "org_position:",
    `  stance: "${o.stance}"`,
    `  confidence: "${o.confidence ?? "high"}"`,
    `  ratified_by: "${o.ratified_by ?? "carol"}"`,
    `  ratified_at: "${o.ratified_at}"`,
    dissent,
  ].join("\n");
}

function writeClaimDoc(
  relPath: string,
  opts: {
    positions?: PositionSpec[];
    orgPosition?: OrgPositionSpec;
    confidence?: string;
    collection?: string;
  } = {},
): void {
  const collection = opts.collection ?? relPath.split("/")[0] ?? "";
  const extra: string[] = [];
  if (opts.positions) {
    extra.push(`positions:\n${opts.positions.map(positionYaml).join("\n")}`);
  }
  if (opts.orgPosition) extra.push(orgPositionYaml(opts.orgPosition));
  mkdirSync(join(vault, relPath.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(
    join(vault, relPath),
    `---
title: "Doc ${relPath}"
domain: "accumulation"
collection: "${collection}"
status: "canonical"
confidence: "${opts.confidence ?? "medium"}"
created: "${TODAY}"
updated: "${TODAY}"
updated_by: "agent:test"
provenance: "direct"
superseded_by: null
ttl_days: 120
sources: []
tags: []
${extra.join("\n")}
---

Body.
`,
    "utf-8",
  );
}

async function positionalTension(
  doc: string,
  positionA: string,
  positionB: string,
): Promise<string> {
  const minted = await addTension(vault, {
    kind: "positional",
    title: `Positional: ${positionA} vs ${positionB}`,
    sourceA: doc,
    claimA: "claim A",
    sourceB: doc,
    claimB: "claim B",
    positionA,
    positionB,
    loggedBy: "alice",
  });
  expect(minted.ok).toBe(true);
  if (!minted.ok) throw minted.error;
  return minted.value.id as string;
}

async function resolve(id: string, kind: string): Promise<void> {
  const r = await resolveTension(vault, id, {
    resolved_at: new Date().toISOString(),
    resolved_by: "carol",
    kind: kind as never,
  });
  expect(r.ok).toBe(true);
}

async function witness(access?: AccessContext) {
  const result = await buildWitness(vault, new Date(), access);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

function principal(w: Awaited<ReturnType<typeof witness>>, name: string) {
  const r = w.principals.find((p) => p.principal === name);
  expect(r).toBeDefined();
  if (!r) throw new Error(`no record for ${name}`);
  return r;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-poswitness-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("the position wager book", () => {
  it("prices the open book: live positions stake, unresolved tensions put stake at risk", async () => {
    writeClaimDoc("pricing/claim.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "low" },
      ],
    });
    await positionalTension("pricing/claim.md", "pos-001", "pos-002");

    const w = await witness();
    const alice = principal(w, "alice").positions;
    expect(alice.taken).toBe(1);
    expect(alice.live).toBe(1);
    expect(alice.exposure).toBe(WAGER_STAKES.high);
    expect(alice.contestedOpen).toBe(1);
    expect(alice.stakeAtRisk).toBe(WAGER_STAKES.high);

    const bob = principal(w, "bob").positions;
    expect(bob.exposure).toBe(0); // low stakes are free
    expect(bob.contestedOpen).toBe(1);
    expect(bob.stakeAtRisk).toBe(0);
  });

  it("excludes pos-000 legacy snapshots from pricing, counting them vault-level", async () => {
    writeClaimDoc("pricing/legacy.md", {
      positions: [
        { id: "pos-000", principal: "unknown", stance: "assert", confidence: "high" },
        { id: "pos-001", principal: "alice", stance: "dispute", confidence: "medium" },
      ],
    });

    const w = await witness();
    expect(w.principals.find((p) => p.principal === "unknown")).toBeUndefined();
    expect(w.legacyPositions).toBe(1);
    const alice = principal(w, "alice").positions;
    expect(alice.taken).toBe(1);
    expect(alice.exposure).toBe(WAGER_STAKES.medium);
  });

  it("burns dissent at its stake and credits alignment at ratify time", async () => {
    writeClaimDoc("pricing/ratified.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "medium" },
      ],
      orgPosition: { stance: "assert", ratified_at: TODAY, dissent: ["pos-002"] },
    });

    const w = await witness();
    const bob = principal(w, "bob").positions;
    expect(bob.dissented).toBe(1);
    expect(bob.burned).toBe(WAGER_STAKES.medium);
    expect(bob.balance).toBe(-WAGER_STAKES.medium);

    const alice = principal(w, "alice").positions;
    expect(alice.ratifiedAligned).toBe(1);
    expect(alice.credited).toBe(POSITION_RATIFIED_CREDIT);
    expect(alice.balance).toBe(POSITION_RATIFIED_CREDIT);
  });

  it("standing dissent (accepted resolution) is never taxed", async () => {
    writeClaimDoc("pricing/standing.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "medium" },
      ],
      orgPosition: { stance: "assert", ratified_at: TODAY, dissent: ["pos-002"] },
    });
    const t = await positionalTension("pricing/standing.md", "pos-001", "pos-002");
    await resolve(t, "accepted");

    const bob = principal(await witness(), "bob").positions;
    expect(bob.dissented).toBe(1);
    expect(bob.standingDissent).toBe(1);
    expect(bob.burned).toBe(0);
  });

  it("self-revision is free: a superseded position neither stakes nor burns", async () => {
    writeClaimDoc("pricing/revised.md", {
      positions: [
        {
          id: "pos-001",
          principal: "alice",
          stance: "assert",
          confidence: "high",
          superseded_by: "pos-002",
        },
        { id: "pos-002", principal: "alice", stance: "qualify", confidence: "medium" },
      ],
    });

    const alice = principal(await witness(), "alice").positions;
    expect(alice.taken).toBe(2);
    expect(alice.live).toBe(1);
    expect(alice.selfRevised).toBe(1);
    expect(alice.exposure).toBe(WAGER_STAKES.medium); // only the live entry stakes
    expect(alice.burned).toBe(0);
  });

  it("a corrected resolution burns both live holders, at most once per position", async () => {
    writeClaimDoc("pricing/corrected.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "medium" },
      ],
      // pos-002 is ALSO in dissent — the burn must not double.
      orgPosition: { stance: "assert", ratified_at: TODAY, dissent: ["pos-002"] },
    });
    const t = await positionalTension("pricing/corrected.md", "pos-001", "pos-002");
    await resolve(t, "corrected");

    const w = await witness();
    const alice = principal(w, "alice").positions;
    expect(alice.corrected).toBe(1);
    expect(alice.burned).toBe(WAGER_STAKES.high);
    const bob = principal(w, "bob").positions;
    expect(bob.burned).toBe(WAGER_STAKES.medium); // dissent + corrected = one burn
  });

  it("`consolidated` closes the contest but never grants immunity — dissent still burns", async () => {
    // The pricing-composition pin: if anyone later "simplifies" the batch
    // kind into `accepted`, dissenters stop burning and this fails.
    writeClaimDoc("pricing/batch.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "medium" },
      ],
      orgPosition: { stance: "assert", ratified_at: TODAY, dissent: ["pos-002"] },
    });
    const t = await positionalTension("pricing/batch.md", "pos-001", "pos-002");
    await resolve(t, "consolidated");

    const w = await witness();
    const bob = principal(w, "bob").positions;
    expect(bob.contestedOpen).toBe(0); // the contest is adjudicated
    expect(bob.standingDissent).toBe(0); // no accidental immunity
    expect(bob.dissented).toBe(1);
    expect(bob.burned).toBe(WAGER_STAKES.medium); // the dissent burn survives
    const alice = principal(w, "alice").positions;
    expect(alice.credited).toBe(POSITION_RATIFIED_CREDIT);
    expect(alice.burned).toBe(0);
  });

  it("superseded and invalid resolutions settle nothing", async () => {
    writeClaimDoc("pricing/nonevents.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "high" },
        { id: "pos-003", principal: "carol", stance: "dispute", confidence: "high" },
      ],
    });
    const t1 = await positionalTension("pricing/nonevents.md", "pos-001", "pos-002");
    const t2 = await positionalTension("pricing/nonevents.md", "pos-001", "pos-003");
    await resolve(t1, "superseded");
    await resolve(t2, "invalid");

    const w = await witness();
    for (const name of ["alice", "bob", "carol"]) {
      const p = principal(w, name).positions;
      expect(p.burned).toBe(0);
      expect(p.credited).toBe(0);
      expect(p.contestedOpen).toBe(0); // both tensions are resolved
    }
  });

  it("no bandwagon credit, and post-ratification re-contest stays open, unsettled", async () => {
    writeClaimDoc("pricing/late.md", {
      positions: [
        {
          id: "pos-001",
          principal: "alice",
          stance: "assert",
          confidence: "high",
          created: "2025-12-01", // predates the ratification
        },
        // carol aligns AFTER ratification — no credit.
        { id: "pos-002", principal: "carol", stance: "assert", confidence: "high", created: TODAY },
        // dave re-contests AFTER ratification — open exposure, no settlement.
        { id: "pos-003", principal: "dave", stance: "dispute", confidence: "high", created: TODAY },
        // bob's dissent-at-ratify keeps dissentIds non-empty, so dave's
        // absence from it is the rule firing, not a vacuous fixture.
        {
          id: "pos-004",
          principal: "bob",
          stance: "dispute",
          confidence: "medium",
          created: "2025-12-15",
        },
      ],
      orgPosition: { stance: "assert", ratified_at: "2026-01-01", dissent: ["pos-004"] },
    });

    const w = await witness();
    expect(principal(w, "carol").positions.credited).toBe(0);
    const dave = principal(w, "dave").positions;
    expect(dave.dissented).toBe(0);
    expect(dave.burned).toBe(0);
    expect(dave.exposure).toBe(WAGER_STAKES.high);
    // alice's position predates the ratification — credited.
    expect(principal(w, "alice").positions.credited).toBe(POSITION_RATIFIED_CREDIT);
    // bob's dissent-at-ratify still burns — the list is live, not vacuous.
    expect(principal(w, "bob").positions.burned).toBe(WAGER_STAKES.medium);
  });

  it("reports no top writer when nobody has written", async () => {
    // Positions exist but the provenance log is empty: a zero-write
    // principal must not be named top writer of 0% of writes.
    writeClaimDoc("pricing/silent.md", {
      positions: [{ id: "pos-001", principal: "alice", stance: "assert", confidence: "low" }],
    });

    const w = await witness();
    expect(w.concentration).toEqual({ topPrincipal: null, topShare: 0 });
  });

  it("re-minting the same stance does not launder a dissent burn", async () => {
    // bob's dissented pos-002 is superseded by pos-003 with the SAME stance:
    // that is a re-mint, not a revision — the burn follows the chain.
    writeClaimDoc("pricing/launder.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        {
          id: "pos-002",
          principal: "bob",
          stance: "dispute",
          confidence: "medium",
          superseded_by: "pos-003",
        },
        { id: "pos-003", principal: "bob", stance: "dispute", confidence: "high" },
      ],
      orgPosition: { stance: "assert", ratified_at: TODAY, dissent: ["pos-002"] },
    });

    const bob = principal(await witness(), "bob").positions;
    expect(bob.dissented).toBe(1);
    expect(bob.burned).toBe(WAGER_STAKES.high); // the LIVE re-mint's stake
  });

  it("flipping to align after dissent is a genuine revision — free", async () => {
    writeClaimDoc("pricing/flip.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        {
          id: "pos-002",
          principal: "bob",
          stance: "dispute",
          confidence: "high",
          superseded_by: "pos-003",
        },
        { id: "pos-003", principal: "bob", stance: "assert", confidence: "medium" },
      ],
      orgPosition: { stance: "assert", ratified_at: TODAY, dissent: ["pos-002"] },
    });

    const bob = principal(await witness(), "bob").positions;
    expect(bob.dissented).toBe(0);
    expect(bob.burned).toBe(0);
    expect(bob.selfRevised).toBe(1);
  });

  it("accepted standing immunity beats a corrected burn on the same position", async () => {
    writeClaimDoc("pricing/immunity.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "medium" },
        { id: "pos-003", principal: "carol", stance: "assert", confidence: "high" },
      ],
      orgPosition: { stance: "assert", ratified_at: TODAY, dissent: ["pos-002"] },
    });
    const t1 = await positionalTension("pricing/immunity.md", "pos-001", "pos-002");
    const t2 = await positionalTension("pricing/immunity.md", "pos-003", "pos-002");
    await resolve(t1, "accepted");
    await resolve(t2, "corrected");

    const bob = principal(await witness(), "bob").positions;
    expect(bob.standingDissent).toBe(1);
    expect(bob.burned).toBe(0); // standing dissent is priced 0, full stop
  });

  it("a superseded position party to a corrected tension is never taxed", async () => {
    writeClaimDoc("pricing/revised-corrected.md", {
      positions: [
        {
          id: "pos-001",
          principal: "alice",
          stance: "assert",
          confidence: "high",
          superseded_by: "pos-003",
        },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "high" },
        { id: "pos-003", principal: "alice", stance: "qualify", confidence: "low" },
      ],
    });
    const t = await positionalTension("pricing/revised-corrected.md", "pos-001", "pos-002");
    await resolve(t, "corrected");

    const alice = principal(await witness(), "alice").positions;
    expect(alice.selfRevised).toBe(1);
    expect(alice.corrected).toBe(0);
    expect(alice.burned).toBe(0); // the flip to qualify is a genuine revision
  });

  it("prices positions only on canonical docs, like the doc book", async () => {
    writeClaimDoc("pricing/dead.md", {
      positions: [{ id: "pos-001", principal: "alice", stance: "assert", confidence: "high" }],
      orgPosition: { stance: "assert", ratified_at: TODAY, dissent: [] },
    });
    // Retire the doc: its ratification must stop paying.
    const raw = join(vault, "pricing/dead.md");
    const { readFileSync } = await import("node:fs");
    writeFileSync(
      raw,
      readFileSync(raw, "utf-8").replace('status: "canonical"', 'status: "deprecated"'),
      "utf-8",
    );

    const w = await witness();
    expect(w.principals.find((p) => p.principal === "alice")).toBeUndefined();
  });

  it("hedged dissent burns nothing — low confidence stays free", async () => {
    writeClaimDoc("pricing/hedged.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "low" },
      ],
      orgPosition: { stance: "assert", ratified_at: TODAY, dissent: ["pos-002"] },
    });

    const bob = principal(await witness(), "bob").positions;
    expect(bob.dissented).toBe(1);
    expect(bob.burned).toBe(0);
  });

  it("scopes the position book to readable collections — omission, not redaction", async () => {
    writeClaimDoc("pricing/visible.md", {
      positions: [{ id: "pos-001", principal: "alice", stance: "assert", confidence: "high" }],
    });
    writeClaimDoc("secrets/hidden.md", {
      positions: [
        { id: "pos-000", principal: "unknown", stance: "assert", confidence: "high" },
        { id: "pos-001", principal: "mallory", stance: "assert", confidence: "high" },
      ],
    });

    const scoped: AccessContext = {
      user: "sam",
      roleName: "scoped",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const w = await witness(scoped);
    expect(w.principals.find((p) => p.principal === "mallory")).toBeUndefined();
    expect(w.legacyPositions).toBe(0); // the hidden snapshot is not counted
    expect(principal(w, "alice").positions.exposure).toBe(WAGER_STAKES.high);
  });

  it("first/last position dates track Position.created per principal", async () => {
    writeClaimDoc("pricing/series.md", {
      positions: [
        {
          id: "pos-001",
          principal: "alice",
          stance: "assert",
          confidence: "low",
          created: "2026-05-01",
          superseded_by: "pos-002",
        },
        {
          id: "pos-002",
          principal: "alice",
          stance: "assert",
          confidence: "low",
          created: "2026-07-01",
        },
      ],
    });

    const alice = principal(await witness(), "alice").positions;
    expect(alice.firstAt).toBe("2026-05-01");
    expect(alice.lastAt).toBe("2026-07-01");
  });
});

describe("composite flat-curve warning and asset-class separation", () => {
  it("does not fire when writes concentrate but positions distribute", async () => {
    writeClaimDoc("pricing/multi.md", {
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "medium" },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "medium" },
        { id: "pos-003", principal: "carol", stance: "qualify", confidence: "medium" },
      ],
    });
    // One scaffolding agent authored everything.
    for (let i = 0; i < 20; i++) {
      const r = await recordProvenance(vault, {
        tool: "vault_write",
        file: "pricing/multi.md",
        agent: "agent:scaffold",
        principal: "agent:scaffold",
        action: i === 0 ? "create" : "update",
      });
      expect(r.ok).toBe(true);
    }

    const w = await witness();
    expect(w.concentration.topShare).toBe(1);
    expect(w.positionConcentration.topShare).toBeLessThan(0.95);
    expect(w.flatCurveWarning).toBe(false); // positions carry the signal
  });

  it("revision churn does not re-arm the warning — concentration counts live positions", async () => {
    // alice has revised 19 times (19 superseded + 1 live); bob holds one
    // live opposing position. Two live, opposed positions = real signal.
    const churn: PositionSpec[] = [];
    for (let i = 1; i <= 19; i++) {
      churn.push({
        id: `pos-${String(i).padStart(3, "0")}`,
        principal: "alice",
        stance: "assert",
        confidence: "low",
        superseded_by: `pos-${String(i + 1).padStart(3, "0")}`,
      });
    }
    churn.push({ id: "pos-020", principal: "alice", stance: "assert", confidence: "low" });
    churn.push({ id: "pos-021", principal: "bob", stance: "dispute", confidence: "low" });
    writeClaimDoc("pricing/churn.md", { positions: churn });
    const r = await recordProvenance(vault, {
      tool: "vault_write",
      file: "pricing/churn.md",
      agent: "agent:scaffold",
      principal: "agent:scaffold",
      action: "create",
    });
    expect(r.ok).toBe(true);

    const w = await witness();
    expect(w.positionConcentration.topShare).toBe(0.5); // live: 1 of 2
    expect(w.flatCurveWarning).toBe(false);
  });

  it("still fires when there are no positions at all (today's behavior)", async () => {
    writeClaimDoc("pricing/solo.md");
    const r = await recordProvenance(vault, {
      tool: "vault_write",
      file: "pricing/solo.md",
      agent: "agent:solo",
      principal: "agent:solo",
      action: "create",
    });
    expect(r.ok).toBe(true);

    const w = await witness();
    expect(w.flatCurveWarning).toBe(true);
  });

  it("keeps positional tensions out of the doc book and tensionsLogged", async () => {
    writeClaimDoc("pricing/separated.md", {
      confidence: "high",
      positions: [
        { id: "pos-001", principal: "alice", stance: "assert", confidence: "high" },
        { id: "pos-002", principal: "bob", stance: "dispute", confidence: "high" },
      ],
    });
    const r = await recordProvenance(vault, {
      tool: "vault_write",
      file: "pricing/separated.md",
      agent: "agent:author",
      principal: "agent:author",
      action: "create",
    });
    expect(r.ok).toBe(true);
    const t = await positionalTension("pricing/separated.md", "pos-001", "pos-002");

    // Unresolved positional tension: the doc author's DOC book is untouched.
    let author = principal(await witness(), "agent:author");
    expect(author.contestedOpen).toBe(0);
    expect(author.stakeAtRisk).toBe(0);

    // Corrected positional tension: the doc author's doc stake does not burn.
    await resolve(t, "corrected");
    author = principal(await witness(), "agent:author");
    expect(author.lost).toBe(0);
    expect(author.burnedStake).toBe(0);

    // The system-minted positional tension is not a curation act.
    const alice = principal(await witness(), "alice");
    expect(alice.tensionsLogged).toBe(0);
  });
});
