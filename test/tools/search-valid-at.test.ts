// vault_search's valid_at / valid_only arguments.
//
// The load-bearing detail is WHERE the validity pass sits in the pipeline. It
// runs on the full RBAC-filtered candidate set, BEFORE the user-facing slice.
// Filtering after the slice would reintroduce the exact page-shrink bug
// `overFetch` was added to fix: expired docs occupying the top-`limit` slots
// would be dropped and shrink the page below `limit`, even though more valid
// docs ranked just past the cut — and the shortfall would read to the caller
// as a thin result set rather than as filtering.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vaultReindex, vaultSearch } from "../../src/tools/search.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const QUERY = "quarterly seat pricing plan";

// Six documents that all match the query, alternating expired / valid so the
// top of the ranking is guaranteed to contain expired hits.
function seedDoc(vault: string, name: string, validity: Record<string, string>): void {
  const lines = Object.entries({
    title: `Seat pricing ${name}`,
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-01-05",
    updated: "2026-01-05",
    updated_by: "agent:test",
    provenance: "direct",
    ...validity,
  }).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(
    join(vault, "pricing", `${name}.md`),
    `---\n${lines.join("\n")}\ntags: []\n---\n\n${QUERY} for ${name}. Quarterly seat pricing plan detail.\n`,
  );
}

describe("vault_search — valid_at", () => {
  let vault: string;

  beforeAll(async () => {
    vault = makeTempVault();
    // Three expired, three currently valid — all strong matches for QUERY.
    seedDoc(vault, "exp-a", { valid_from: "2020-01-01", valid_until: "2020-12-31" });
    seedDoc(vault, "exp-b", { valid_from: "2021-01-01", valid_until: "2021-12-31" });
    seedDoc(vault, "exp-c", { valid_from: "2022-01-01", valid_until: "2022-12-31" });
    seedDoc(vault, "cur-a", { valid_from: "2026-01-01" });
    seedDoc(vault, "cur-b", { valid_from: "2026-01-01" });
    seedDoc(vault, "cur-c", { valid_from: "2026-01-01" });
    const r = await vaultReindex(vault);
    if (!r.ok) throw r.error;
  }, 120_000);

  afterAll(() => {
    cleanupVault(vault);
  });

  it("adds no validity annotation when valid_at is omitted", async () => {
    const r = await vaultSearch(vault, { query: QUERY, limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Zero cost and zero output change for every existing caller.
    expect(r.value.hits.every((h) => h.validity === undefined)).toBe(true);
  }, 60_000);

  it("annotates every hit when valid_at is supplied", async () => {
    const r = await vaultSearch(vault, { query: QUERY, valid_at: "2026-06-01", limit: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const annotated = r.value.hits.filter((h) => h.path.startsWith("pricing/"));
    expect(annotated.length).toBeGreaterThan(0);
    for (const hit of annotated) {
      if (hit.path.includes("exp-")) expect(hit.validity?.state).toBe("expired");
      if (hit.path.includes("cur-")) expect(hit.validity?.state).toBe("in-window");
    }
  }, 60_000);

  it("annotates relative to valid_at, not to today", async () => {
    const r = await vaultSearch(vault, { query: QUERY, valid_at: "2020-06-01", limit: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const expA = r.value.hits.find((h) => h.path.includes("exp-a"));
    expect(expA?.validity?.state).toBe("in-window");
    const curA = r.value.hits.find((h) => h.path.includes("cur-a"));
    expect(curA?.validity?.state).toBe("not-yet");
  }, 60_000);

  it("does not filter by default — annotation only", async () => {
    const r = await vaultSearch(vault, { query: QUERY, valid_at: "2026-06-01", limit: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hits.some((h) => h.validity?.state === "expired")).toBe(true);
  }, 60_000);

  it("drops expired hits under valid_only", async () => {
    const r = await vaultSearch(vault, {
      query: QUERY,
      valid_at: "2026-06-01",
      valid_only: true,
      limit: 10,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hits.some((h) => h.validity?.state === "expired")).toBe(false);
    expect(r.value.hits.some((h) => h.validity?.state === "not-yet")).toBe(false);
  }, 60_000);

  it("KEEPS unknown hits under valid_only — absence is not evidence", async () => {
    // Every fixture document predates the feature and authors no interval.
    // Filtering them out would silently delete the vault from its own results.
    const r = await vaultSearch(vault, {
      query: "Helios compute credit consumption pricing",
      valid_at: "2026-06-01",
      valid_only: true,
      limit: 10,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hits.length).toBeGreaterThan(0);
    expect(r.value.hits.some((h) => h.validity === null || h.validity === undefined)).toBe(true);
  }, 60_000);

  // --- C8: the page-shrink regression --------------------------------------

  it("returns a FULL page when expired docs occupy the top-limit slots", async () => {
    // Three of the six seeded docs are expired. Asking for 3 under valid_only
    // must return 3 valid ones, not a page shrunk by whatever the ranker
    // happened to put on top.
    const r = await vaultSearch(vault, {
      query: QUERY,
      valid_at: "2026-06-01",
      valid_only: true,
      limit: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seeded = r.value.hits.filter((h) => h.path.includes("pricing/cur-"));
    expect(seeded.length).toBe(3);
    expect(r.value.hits.every((h) => h.validity?.state !== "expired")).toBe(true);
  }, 60_000);

  it("reports count as the length of the final hit list", async () => {
    const r = await vaultSearch(vault, {
      query: QUERY,
      valid_at: "2026-06-01",
      valid_only: true,
      limit: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.count).toBe(r.value.hits.length);
  }, 60_000);

  it("rejects a malformed valid_at rather than silently ignoring it", async () => {
    const r = await vaultSearch(vault, { query: QUERY, valid_at: "June 2026" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/valid_at/);
  }, 60_000);

  it("rejects an out-of-range valid_at", async () => {
    const r = await vaultSearch(vault, { query: QUERY, valid_at: "2026-13-45" });
    expect(r.ok).toBe(false);
  }, 60_000);

  it("foregrounds a covering chain member via validAtSource", async () => {
    // v1 held Q1, v2 replaced it from Q2. Querying at a Q1 date from a hit on
    // v2 should point back at v1.
    seedDoc(vault, "chain-v1", { valid_from: "2026-01-01", valid_until: "2026-03-31" });
    seedDoc(vault, "chain-v2", { valid_from: "2026-04-01" });
    const v1 = join(vault, "pricing", "chain-v1.md");
    const text = readFileSync(v1, "utf8");
    writeFileSync(v1, text.replace("tags: []", "superseded_by: pricing/chain-v2.md\ntags: []"));
    const re = await vaultReindex(vault);
    if (!re.ok) throw re.error;

    const r = await vaultSearch(vault, { query: QUERY, valid_at: "2026-02-15", limit: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v2hit = r.value.hits.find((h) => h.path.includes("chain-v2"));
    expect(v2hit?.validAtSource?.kind).toBe("resolved");
    if (v2hit?.validAtSource?.kind !== "resolved") return;
    expect(v2hit.validAtSource.path).toBe("pricing/chain-v1.md");
  }, 120_000);
});
