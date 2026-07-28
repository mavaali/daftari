// Part B rerank pipeline integration (spec 2026-07-26-contextual-chunking-
// reranker-design.md, plan §4.3), exercised through vaultSearch with a FAKE
// RerankProvider (setRerankProviderForTests) — no real model, no network.
//
// Fixture: 60 documents in the `public` collection, all matching the shared
// probe term with varying repetition counts, so pure lexical BM25 (weights:
// {bm25: 1, vector: 0}, which also skips embedQuery entirely — no model
// load) produces a deterministic (if not hand-predictable — BM25 saturates
// term frequency non-linearly against document length) fused order. The
// baseline order is captured EMPIRICALLY in beforeAll (one real vaultSearch
// call with no reranker) rather than assumed from the repetition scheme, so
// the tests below never depend on BM25's internal scoring curve. One more
// document lives in a `secret` collection the test role cannot read, for the
// RBAC-ordering test.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { ok } from "../../src/frontmatter/types.js";
import { reindexVault } from "../../src/search/reindex.js";
import type { RerankProvider } from "../../src/search/rerank-provider.js";
import {
  resetRerankProviderForTests,
  setRerankProviderForTests,
} from "../../src/search/rerank-provider.js";
import * as indexDb from "../../src/storage/index-db.js";
import { vaultSearch } from "../../src/tools/search.js";

const QUERY = "zzzrerankprobe";
const PROBE_COUNT = 60;
const RERANK_POOL = 50; // must match src/tools/search.ts's RERANK_POOL

function probeBody(repetitions: number): string {
  return Array.from({ length: repetitions }, () => QUERY).join(" ");
}

function probeFrontmatter(title: string, collection: string): string {
  return (
    `---\ntitle: "${title}"\ncollection: ${collection}\ndomain: product\n` +
    "status: canonical\nconfidence: high\ncreated: 2026-01-01\nupdated: 2026-01-01\n" +
    "tags: []\n---\n\n"
  );
}

const FUSED_WEIGHTS = { bm25: 1, vector: 0 }; // pure lexical — never loads the embedding model

function publicOnlyAccess(): AccessContext {
  return {
    user: "t",
    roleName: "public-reader",
    role: { read: ["public"], write: [], promote: false, ratify: false },
  };
}

function fakeProvider(overrides: Partial<RerankProvider> = {}): RerankProvider {
  return {
    id: "fake-rerank",
    isReady: () => true,
    warm: async () => ok(undefined),
    rerank: async (_query, passages) => ok(passages.map(() => 0)),
    ...overrides,
  };
}

async function search(args: Record<string, unknown>) {
  return vaultSearch(vault, { query: QUERY, weights: FUSED_WEIGHTS, ...args }, publicOnlyAccess());
}

let vault: string;
// The natural fused order (no reranker), captured once in beforeAll — the
// ground truth every "fused order stands" assertion below compares against,
// instead of a hand-predicted BM25 ranking.
let fusedTop50: string[];

describe("vaultSearch — Part B rerank pipeline (fake provider)", () => {
  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), "daftari-rerank-"));
    mkdirSync(join(vault, "public"), { recursive: true });
    mkdirSync(join(vault, "secret"), { recursive: true });

    for (let i = 0; i < PROBE_COUNT; i++) {
      const repetitions = PROBE_COUNT - i;
      const name = `probe-${String(i).padStart(3, "0")}`;
      writeFileSync(
        join(vault, "public", `${name}.md`),
        `${probeFrontmatter(name, "public")}${probeBody(repetitions)}\n`,
      );
    }
    // Matches everyone's repetition count heavily so it would rank at the
    // very top if it were visible — the RBAC test's whole point.
    writeFileSync(
      join(vault, "secret", "hidden.md"),
      `${probeFrontmatter("hidden", "secret")}${probeBody(1000)}\n`,
    );

    const reindexed = await reindexVault(vault);
    if (!reindexed.ok) throw reindexed.error;

    resetRerankProviderForTests(); // ensure "none" for the baseline capture
    const baseline = await search({ limit: RERANK_POOL });
    if (!baseline.ok) throw baseline.error;
    fusedTop50 = baseline.value.hits.map((h) => h.path);
    if (fusedTop50.length !== RERANK_POOL) {
      throw new Error(`expected ${RERANK_POOL} fused hits, got ${fusedTop50.length}`);
    }
  }, 60_000);

  afterAll(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  afterEach(() => {
    resetRerankProviderForTests();
  });

  it("baseline: the captured fused order is stable across repeated calls", async () => {
    const result = await search({ limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.map((h) => h.path)).toEqual(fusedTop50.slice(0, 10));
    expect(result.value.rerankUsed).toBe(false); // no reranker configured yet
  });

  // (a) reorder happens AFTER RBAC — a fake that would top-score a forbidden
  // doc's passage never gets the chance, because RBAC drops it before the
  // rerank stage ever sees it.
  it("reorder happens after RBAC: a forbidden doc's passage never reaches the reranker or the hits", async () => {
    let sawSecretPassage = false;
    setRerankProviderForTests(
      fakeProvider({
        rerank: async (_q, passages) => {
          if (passages.some((p) => p.includes("hidden"))) sawSecretPassage = true;
          return ok(passages.map(() => 0));
        },
      }),
    );
    const result = await search({ limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.some((h) => h.path === "secret/hidden.md")).toBe(false);
    expect(sawSecretPassage).toBe(false);
  });

  // (b) reorder happens BEFORE the slice — a hit ranked outside the default
  // limit-10 page (fused rank 12, 1-based) can be promoted to #1.
  it("reorder happens before the slice: a fused-#12 hit can land #1 in a limit-10 page", async () => {
    const promoted = fusedTop50[11]; // 1-based rank 12
    if (!promoted) throw new Error("fixture too small");
    const promotedName = promoted.replace("public/", "").replace(".md", "");
    setRerankProviderForTests(
      fakeProvider({
        rerank: async (_q, passages) => ok(passages.map((p) => (p.includes(promotedName) ? 1 : 0))),
      }),
    );
    const result = await search({ limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits[0]?.path).toBe(promoted);
    expect(result.value.hits).toHaveLength(10);
    expect(result.value.rerankUsed).toBe(true);
  });

  // (c) a rerank Result.err degrades to the fused order, rerankUsed: false.
  it("a Result.err from the provider degrades to the fused order", async () => {
    setRerankProviderForTests(
      fakeProvider({
        rerank: async () => ({ ok: false, error: new Error("boom") }) as const,
      }),
    );
    const result = await search({ limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.map((h) => h.path)).toEqual(fusedTop50.slice(0, 10));
    expect(result.value.rerankUsed).toBe(false);
  });

  // (d) a slow fake exceeding RERANK_TIMEOUT_MS (1500ms, src/tools/search.ts)
  // degrades to the fused order exactly like a Result.err.
  it("a slow provider exceeding the timeout degrades to the fused order", async () => {
    setRerankProviderForTests(
      fakeProvider({
        rerank: async (_q, passages) => {
          await new Promise((resolve) => setTimeout(resolve, 1700));
          return ok(passages.map(() => 1)); // would reorder everything if it landed
        },
      }),
    );
    const result = await search({ limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.map((h) => h.path)).toEqual(fusedTop50.slice(0, 10));
    expect(result.value.rerankUsed).toBe(false);
  }, 5_000);

  // (e) a not-ready provider skips reranking for THIS search and fires a
  // background warm instead — never a synchronous model load inside the call.
  it("a not-ready provider skips reranking and fires a background warm (C5)", async () => {
    let warmCalls = 0;
    setRerankProviderForTests(
      fakeProvider({
        isReady: () => false,
        warm: async () => {
          warmCalls += 1;
          return ok(undefined);
        },
      }),
    );
    const result = await search({ limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rerankUsed).toBe(false);
    expect(result.value.hits.map((h) => h.path)).toEqual(fusedTop50.slice(0, 10));
    // The background warm is fire-and-forget; give its microtask a tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(warmCalls).toBeGreaterThanOrEqual(1);
  });

  // (f) provider "none" (the default / no provider installed): no ref
  // capture, rerankUsed: false, and passageRefs never leaks onto the result.
  it("provider none: no ref capture, rerankUsed false, no passageRefs on the result", async () => {
    resetRerankProviderForTests();
    const result = await search({ limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rerankUsed).toBe(false);
    expect("passageRefs" in result.value).toBe(false);
  });

  // (g) the #3 agent-as-judge rerank_candidates pool reflects the RERANKED
  // order, not the pre-rerank fused order (spec Decision 7).
  it("rerank_candidates draws from the reranked order", async () => {
    const promoted = fusedTop50[11];
    if (!promoted) throw new Error("fixture too small");
    const promotedName = promoted.replace("public/", "").replace(".md", "");
    setRerankProviderForTests(
      fakeProvider({
        rerank: async (_q, passages) => ok(passages.map((p) => (p.includes(promotedName) ? 1 : 0))),
      }),
    );
    const result = await search({ limit: 10, rerank_candidates: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rerank?.candidates[0]?.path).toBe(promoted);
  });

  // (h) the pool is fixed at RERANK_POOL (50); an all-tied fake (stable sort
  // preserves order) never disturbs the top-50 fused order — the closest
  // observable proxy for "the tail past the pool keeps the fused order",
  // since parseLimit's own max (50) coincides with RERANK_POOL and a caller
  // can never request a page wide enough to see past index 49 directly.
  it("an all-tied rerank score never disturbs the pool's fused order", async () => {
    setRerankProviderForTests(fakeProvider()); // default: score 0 for everyone
    const result = await search({ limit: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits).toHaveLength(RERANK_POOL);
    expect(result.value.hits.map((h) => h.path)).toEqual(fusedTop50);
  });

  // (i) passage resolution touches only the top-RERANK_POOL permitted pool,
  // never the full 60-candidate set — a spy on the batched chunk-text lookup
  // sees a single call sized at most RERANK_POOL (C2).
  it("passage resolution touches only the top-50 permitted pool, not the full candidate set", async () => {
    setRerankProviderForTests(fakeProvider());
    const rowidsSpy = vi.spyOn(indexDb, "getChunkTextsByRowids");
    const hashSpy = vi.spyOn(indexDb, "getChunkByPathAndHash");
    const firstSpy = vi.spyOn(indexDb, "getFirstChunk");
    try {
      const result = await search({ limit: 10 });
      expect(result.ok).toBe(true);
      // Pure-lexical, chunk-mode, every doc matched by BM25 (no title/tag
      // fallback and no vector signal at all with vector:0) => every ref is
      // "lexical", resolved in exactly one batched call sized at RERANK_POOL.
      expect(rowidsSpy).toHaveBeenCalledTimes(1);
      const rowids = rowidsSpy.mock.calls[0]?.[1] ?? [];
      expect(rowids.length).toBeLessThanOrEqual(RERANK_POOL);
      expect(hashSpy).not.toHaveBeenCalled();
      expect(firstSpy).not.toHaveBeenCalled();
    } finally {
      rowidsSpy.mockRestore();
      hashSpy.mockRestore();
      firstSpy.mockRestore();
    }
  });
});
