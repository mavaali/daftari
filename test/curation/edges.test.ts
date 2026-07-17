import { appendFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agedStrength,
  contestEdge,
  EDGE_K_CAP,
  edgesPath,
  getEdge,
  listEdges,
  observeEdge,
  rebuildEdgesIndex,
} from "../../src/curation/edges.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { getAllDerivesFromEdges, type IndexDb, openIndexDb } from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const BY = "agent:curation-loop";

// Fixed instants for deterministic aging math.
const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-02T00:00:00Z";
const T2 = "2026-01-03T00:00:00Z";
const DAYS_90 = new Date("2026-04-02T00:00:00Z"); // T1 + 90d
const DAYS_100 = new Date("2026-04-12T00:00:00Z"); // T1 + 100d

async function seedAndVote(vault: string): Promise<void> {
  // Seed (birth, k=0) then one qualifying blind+axis vote (k=1).
  const seeded = await observeEdge(vault, {
    fromPath: "a.md",
    toPath: "b.md",
    observedBy: BY,
    blind: false,
    at: T0,
  });
  if (!seeded.ok) throw seeded.error;
  const voted = await observeEdge(vault, {
    fromPath: "a.md",
    toPath: "b.md",
    observedBy: BY,
    blind: true,
    axis: "model",
    at: T1,
  });
  if (!voted.ok) throw voted.error;
}

describe("derives_from edge store", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("seeds a zero-strength candidate on first observation (birth is not a survival)", async () => {
    const result = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      at: T0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kSurvived).toBe(0);
    expect(result.value.status).toBe("candidate");
    expect(result.value.firstObserved).toBe(T0);
    expect(result.value.lastRederived).toBe(T0);
  });

  it("counts only blind observations with a varied axis as votes", async () => {
    await seedAndVote(vault); // k=1 after a blind+axis vote
    // Not blind → no vote, clock untouched.
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: false,
      axis: "prompt",
      at: T2,
    });
    // Blind but axis-less → no vote either.
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      at: T2,
    });
    const edge = await getEdge(vault, "a.md", "b.md", new Date(T2));
    expect(edge.ok).toBe(true);
    if (!edge.ok || !edge.value) return;
    expect(edge.value.kSurvived).toBe(1);
    expect(edge.value.lastRederived).toBe(T1); // correlated sightings don't refresh
    expect(edge.value.observations).toBe(4);
  });

  it("caps k_survived at K but a vote at cap still refreshes the aging clock", async () => {
    // Seed + K+2 qualifying votes on successive days.
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: false,
      at: T0,
    });
    let lastAt = T0;
    for (let i = 0; i < EDGE_K_CAP + 2; i++) {
      lastAt = `2026-01-${String(i + 2).padStart(2, "0")}T00:00:00Z`;
      const r = await observeEdge(vault, {
        fromPath: "a.md",
        toPath: "b.md",
        observedBy: BY,
        blind: true,
        axis: "prompt",
        at: lastAt,
      });
      if (!r.ok) throw r.error;
    }
    const edge = await getEdge(vault, "a.md", "b.md", new Date(lastAt));
    expect(edge.ok).toBe(true);
    if (!edge.ok || !edge.value) return;
    expect(edge.value.kSurvived).toBe(EDGE_K_CAP);
    expect(edge.value.lastRederived).toBe(lastAt);
    expect(edge.value.strength).toBeCloseTo(EDGE_K_CAP, 5);
  });

  it("ages strength by half-life and flips trigger-bearing back to candidate", async () => {
    await seedAndVote(vault); // k=1, last re-derived T1
    const fresh = await getEdge(vault, "a.md", "b.md", new Date(T1));
    expect(fresh.ok && fresh.value?.status).toBe("trigger-bearing");
    expect(fresh.ok && fresh.value?.strength).toBeCloseTo(1, 5);

    // Exactly one half-life later: strength 0.5, still at the floor.
    const atHalf = await getEdge(vault, "a.md", "b.md", DAYS_90);
    expect(atHalf.ok && atHalf.value?.strength).toBeCloseTo(0.5, 5);
    expect(atHalf.ok && atHalf.value?.status).toBe("trigger-bearing");

    // Past the half-life: below the floor → candidate again (aged out).
    const aged = await getEdge(vault, "a.md", "b.md", DAYS_100);
    expect(aged.ok && aged.value?.strength).toBeLessThan(0.5);
    expect(aged.ok && aged.value?.status).toBe("candidate");
  });

  it("contest revokes; a later observation re-seeds a fresh earning cycle", async () => {
    await seedAndVote(vault);
    const contested = await contestEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      contestedBy: BY,
      reason: "re-derivation failed, no upstream change",
      at: T2,
    });
    expect(contested.ok).toBe(true);
    if (!contested.ok) return;
    expect(contested.value.status).toBe("revoked");
    expect(contested.value.strength).toBe(0);
    expect(contested.value.contestReason).toContain("no upstream change");

    // Re-observation after the contest starts over at k=0.
    const reseeded = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "input-neighborhood",
      at: "2026-01-04T00:00:00Z",
    });
    expect(reseeded.ok).toBe(true);
    if (!reseeded.ok) return;
    expect(reseeded.value.status).toBe("candidate");
    expect(reseeded.value.kSurvived).toBe(0);
    expect(reseeded.value.firstObserved).toBe("2026-01-04T00:00:00Z");
  });

  it("rejects contesting an unknown or already-revoked edge", async () => {
    const unknown = await contestEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      contestedBy: BY,
      reason: "x",
    });
    expect(unknown.ok).toBe(false);

    await seedAndVote(vault);
    await contestEdge(vault, { fromPath: "a.md", toPath: "b.md", contestedBy: BY, reason: "x" });
    const again = await contestEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      contestedBy: BY,
      reason: "y",
    });
    expect(again.ok).toBe(false);
  });

  it("rejects a self-edge", async () => {
    const result = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "a.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
    });
    expect(result.ok).toBe(false);
  });

  it("lists edges strongest first and filters by endpoint and status", async () => {
    await seedAndVote(vault); // a.md -> b.md, k=1
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "c.md",
      observedBy: BY,
      blind: false,
      at: T0,
    });
    await observeEdge(vault, {
      fromPath: "x.md",
      toPath: "b.md",
      observedBy: BY,
      blind: false,
      at: T0,
    });
    await contestEdge(vault, { fromPath: "x.md", toPath: "b.md", contestedBy: BY, reason: "bad" });

    const all = await listEdges(vault, {}, new Date(T1));
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(3);
    expect(all.value[0]?.fromPath).toBe("a.md"); // the voted edge is strongest
    expect(all.value[0]?.toPath).toBe("b.md");

    const fromA = await listEdges(vault, { fromPath: "a.md" }, new Date(T1));
    expect(fromA.ok && fromA.value).toHaveLength(2);

    const revoked = await listEdges(vault, { status: "revoked" }, new Date(T1));
    expect(revoked.ok && revoked.value).toHaveLength(1);
    expect(revoked.ok && revoked.value[0]?.fromPath).toBe("x.md");
  });

  it("skips corrupt jsonl lines instead of failing the read", async () => {
    await seedAndVote(vault);
    appendFileSync(edgesPath(vault), 'not json at all\n{"kind":"observe"}\n');
    const all = await listEdges(vault);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(1);
  });

  it("rebuilds the sqlite derives_from_edges table from the jsonl", async () => {
    await seedAndVote(vault); // a.md -> b.md, k=1
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "c.md",
      observedBy: BY,
      blind: false,
      at: T0,
    });

    mkdirSync(join(vault, ".daftari"), { recursive: true });
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      const rebuilt = rebuildEdgesIndex(db, vault, new Date(T1));
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;
      expect(rebuilt.value.count).toBe(2);

      const rows = getAllDerivesFromEdges(db);
      expect(rows).toHaveLength(2);
      const voted = rows.find((r) => r.to_path === "b.md");
      expect(voted?.k_survived).toBe(1);
      expect(voted?.status).toBe("trigger-bearing");
      expect(voted?.strength).toBeCloseTo(1, 5);
      expect(voted?.first_observed).toBe(T0);
      expect(voted?.last_rederived).toBe(T1);
      expect(voted?.last_age_decay).toBe(T1); // materialization instant

      // Rebuilding later re-materializes aged strength and status.
      const later = rebuildEdgesIndex(db, vault, DAYS_100);
      expect(later.ok).toBe(true);
      const agedRow = getAllDerivesFromEdges(db).find((r) => r.to_path === "b.md");
      expect(agedRow?.strength).toBeLessThan(0.5);
      expect(agedRow?.status).toBe("candidate");
    } finally {
      db.close();
    }
  });

  it("agedStrength halves per half-life window", () => {
    const last = "2026-01-01T00:00:00Z";
    expect(agedStrength(2, last, new Date("2026-01-01T00:00:00Z"))).toBeCloseTo(2, 5);
    expect(agedStrength(2, last, new Date("2026-04-01T00:00:00Z"))).toBeCloseTo(1, 5); // 90d
    expect(agedStrength(0, last, new Date("2026-01-01T00:00:00Z"))).toBe(0);
  });

  it("a same-sitting replay of the same (observer, axis) pair does not pump k", async () => {
    await seedAndVote(vault); // vote by (BY, model) at T1 → k=1
    // The identical attestation replayed at the same instant: a cram, not a vote.
    for (let i = 0; i < 5; i++) {
      await observeEdge(vault, {
        fromPath: "a.md",
        toPath: "b.md",
        observedBy: BY,
        blind: true,
        axis: "model",
        at: T1,
      });
    }
    const edge = await getEdge(vault, "a.md", "b.md", new Date(T1));
    expect(edge.ok && edge.value?.kSurvived).toBe(1);

    // The same pair counts again after the replay gap (a real later re-test —
    // the loop's quarterly re-derivation must be able to restore strength).
    const later = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "model",
      at: T2, // one day after T1
    });
    expect(later.ok && later.value.kSurvived).toBe(2);

    // A DIFFERENT pair (new axis) in the same sitting counts immediately —
    // varied-axis votes are independent even same-day.
    const newAxis = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      at: T2,
    });
    expect(newAxis.ok && newAxis.value.kSurvived).toBe(3);
  });

  it("the seed's own attestation is registered — seeder cannot instant-vote its claim", async () => {
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      at: T0,
    });
    // The identical claim a moment later is a replay of the seed, not a vote.
    const replay = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      at: T0,
    });
    expect(replay.ok && replay.value.kSurvived).toBe(0);
    // After the gap it earns normally.
    const earned = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      at: T1,
    });
    expect(earned.ok && earned.value.kSurvived).toBe(1);
  });

  it("ignores an orphan contest line injected directly into the jsonl", async () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    appendFileSync(
      edgesPath(vault),
      `${JSON.stringify({ kind: "contest", from: "ghost.md", to: "b.md", at: T0, by: BY, reason: "x" })}\n`,
    );
    const all = await listEdges(vault);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(0);
  });

  it("skips a record whose timestamp does not parse (no NaN strength)", async () => {
    await seedAndVote(vault);
    appendFileSync(
      edgesPath(vault),
      `${JSON.stringify({ kind: "observe", from: "a.md", to: "b.md", at: "yesterday", by: BY, blind: true, axis: "prompt" })}\n`,
    );
    const edge = await getEdge(vault, "a.md", "b.md", new Date(T1));
    expect(edge.ok).toBe(true);
    if (!edge.ok || !edge.value) return;
    expect(Number.isFinite(edge.value.strength)).toBe(true);
    expect(edge.value.observations).toBe(2); // the bad line never entered the trail
  });

  it("supports a full second cycle: contest, re-seed, contest again", async () => {
    await seedAndVote(vault);
    await contestEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      contestedBy: BY,
      reason: "x",
      at: T2,
    });
    const reseeded = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: false,
      at: "2026-01-04T00:00:00Z",
    });
    expect(reseeded.ok).toBe(true);
    if (!reseeded.ok) return;
    // The re-seed discards the prior cycle's contest metadata entirely.
    expect(reseeded.value.contestedAt).toBeNull();
    expect(reseeded.value.contestReason).toBeNull();

    const second = await contestEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      contestedBy: BY,
      reason: "failed again",
      at: "2026-01-05T00:00:00Z",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.status).toBe("revoked");
    expect(second.value.contestReason).toBe("failed again");
  });
});

describe("derives_from direction verdict", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("defaults to 'directed' for legacy edges with no premise vote", async () => {
    const r = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      at: T0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.directionVerdict).toBe("directed");
  });

  it("collapses agreeing premise votes to directed", async () => {
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      premiseVote: "to",
      at: T0,
    });
    const r = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "model",
      premiseVote: "to",
      at: T1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.directionVerdict).toBe("directed");
  });

  it("collapses split premise votes (from vs to) to symmetric", async () => {
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      premiseVote: "to",
      at: T0,
    });
    const r = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "model",
      premiseVote: "from",
      at: T1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.directionVerdict).toBe("symmetric");
  });

  it("an explicit symmetric vote makes the edge symmetric", async () => {
    const r = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      premiseVote: "symmetric",
      at: T0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.directionVerdict).toBe("symmetric");
  });

  it("a single directed vote is directed", async () => {
    const r = await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      premiseVote: "to",
      at: T0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.directionVerdict).toBe("directed");
  });

  it("a re-birth that FLIPS the orientation collapses to one symmetric edge, not two directed twins", async () => {
    // pass 1: a.md depends on b.md (b is premise) → observe(from=a, to=b, premise=to)
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      premiseVote: "to",
      at: T0,
    });
    // pass 2 (post-edit re-birth): direction flipped — b.md depends on a.md (a is
    // premise) → observe(from=b, to=a, premise=to). Orientation flipped vs pass 1.
    await observeEdge(vault, {
      fromPath: "b.md",
      toPath: "a.md",
      observedBy: BY,
      blind: true,
      axis: "model",
      premiseVote: "to",
      at: T1,
    });
    // Exactly ONE edge for the {a,b} pair, and it must be symmetric (conflicting
    // orientations are a split, not two trusted directed twins).
    const all = await listEdges(vault, {}, new Date(T1));
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(1);
    expect(all.value[0]?.directionVerdict).toBe("symmetric");
    const fwd = await getEdge(vault, "a.md", "b.md", new Date(T1));
    const rev = await getEdge(vault, "b.md", "a.md", new Date(T1));
    expect(fwd.ok && fwd.value?.directionVerdict).toBe("symmetric");
    expect(rev.ok && rev.value?.directionVerdict).toBe("symmetric");
  });

  it("materializes direction_verdict into the sqlite row after rebuild", async () => {
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: BY,
      blind: true,
      axis: "prompt",
      premiseVote: "symmetric",
      at: T0,
    });
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const db = opened.value;
    try {
      const rebuilt = rebuildEdgesIndex(db, vault, new Date(T1));
      expect(rebuilt.ok).toBe(true);
      const row = getAllDerivesFromEdges(db).find((r) => r.to_path === "b.md");
      expect(row?.direction_verdict).toBe("symmetric");
    } finally {
      db.close();
    }
  });
});

// #236 quick win 3: the sqlite mirror becomes the authoritative READ path.
// edges.jsonl stays the canonical store and only writer input; the table is a
// rebuildable cache kept coherent by write-through and a jsonl stat check.
describe("sql-authoritative edge reads", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  function withDb<T>(fn: (db: IndexDb) => T): T {
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    const db = opened.value;
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  it("observeEdge writes through to the sqlite index", async () => {
    await seedAndVote(vault);
    const rows = withDb((db) => getAllDerivesFromEdges(db));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.from_path).toBe("a.md");
    expect(rows[0]?.to_path).toBe("b.md");
    expect(rows[0]?.k_survived).toBe(1);
  });

  it("contestEdge writes through: row revoked, contest trail in columns", async () => {
    await seedAndVote(vault);
    const contested = await contestEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      contestedBy: BY,
      reason: "re-derivation failed, premise unchanged",
      at: T2,
    });
    expect(contested.ok).toBe(true);
    const rows = withDb((db) => getAllDerivesFromEdges(db));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("revoked");
    expect(rows[0]?.observations).toBe(2);
    expect(rows[0]?.contested_at).toBe(T2);
    expect(rows[0]?.contest_reason).toBe("re-derivation failed, premise unchanged");
  });

  it("reads are served from the sqlite index, not the jsonl", async () => {
    await seedAndVote(vault);
    // Empty the materialized table while leaving edges.jsonl and its freshness
    // marker untouched. An authoritative SQL read sees no edge; a jsonl read
    // would still see one.
    withDb((db) => db.exec("DELETE FROM derives_from_edges;"));
    const got = await getEdge(vault, "a.md", "b.md");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBeNull();
    const listed = await listEdges(vault);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toHaveLength(0);
  });

  it("rebuildEdgesIndex records the jsonl freshness marker (next read trusts the table)", async () => {
    await seedAndVote(vault);
    withDb((db) => {
      const rebuilt = rebuildEdgesIndex(db, vault, new Date(T1));
      expect(rebuilt.ok).toBe(true);
      db.exec("DELETE FROM derives_from_edges;");
    });
    const listed = await listEdges(vault, {}, new Date(T2));
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toHaveLength(0);
  });

  it("an external append to edges.jsonl is picked up on the next read (self-heal)", async () => {
    await seedAndVote(vault);
    const line = JSON.stringify({
      kind: "observe",
      from: "c.md",
      to: "d.md",
      at: T2,
      by: BY,
      blind: false,
      axis: null,
    });
    appendFileSync(edgesPath(vault), `${line}\n`);
    const listed = await listEdges(vault, {}, new Date(T2));
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(2);
    expect(listed.value.some((e) => e.fromPath === "c.md" && e.toPath === "d.md")).toBe(true);
  });

  it("status filter recomputes aged status: stored trigger-bearing decayed past the floor reads as candidate", async () => {
    await seedAndVote(vault); // k=1, aging clock at T1
    withDb((db) => {
      // Materialize at T1: strength 1.0 → stored status "trigger-bearing".
      const rebuilt = rebuildEdgesIndex(db, vault, new Date(T1));
      expect(rebuilt.ok).toBe(true);
    });
    // 100 days later the aged strength is ~0.46 < 0.5: the edge is a candidate
    // now, whatever the stored column says. A naive WHERE status = ? gets both
    // of these wrong.
    const candidates = await listEdges(vault, { status: "candidate" }, DAYS_100);
    expect(candidates.ok).toBe(true);
    if (candidates.ok) expect(candidates.value.map((e) => e.fromPath)).toContain("a.md");
    const bearing = await listEdges(vault, { status: "trigger-bearing" }, DAYS_100);
    expect(bearing.ok).toBe(true);
    if (bearing.ok) expect(bearing.value).toHaveLength(0);
  });

  it("falls back to the jsonl when the index db cannot be opened (read-only vault)", async () => {
    await seedAndVote(vault);
    const daftariDir = join(vault, ".daftari");
    for (const f of ["index.db", "index.db-wal", "index.db-shm"]) {
      rmSync(join(daftariDir, f), { force: true });
    }
    chmodSync(daftariDir, 0o555);
    try {
      const listed = await listEdges(vault, {}, new Date(T2));
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value).toHaveLength(1);
        expect(listed.value[0]?.fromPath).toBe("a.md");
      }
      const got = await getEdge(vault, "a.md", "b.md", new Date(T2));
      expect(got.ok).toBe(true);
      if (got.ok) expect(got.value?.kSurvived).toBe(1);
    } finally {
      chmodSync(daftariDir, 0o755);
    }
  });

  it("trail extras survive the sql read path", async () => {
    await seedAndVote(vault);
    await contestEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      contestedBy: BY,
      reason: "case-2 contradiction",
      at: T2,
    });
    const got = await getEdge(vault, "a.md", "b.md", new Date(T2));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value?.status).toBe("revoked");
    expect(got.value?.strength).toBe(0);
    expect(got.value?.observations).toBe(2);
    expect(got.value?.contestedAt).toBe(T2);
    expect(got.value?.contestReason).toBe("case-2 contradiction");
  });
});
