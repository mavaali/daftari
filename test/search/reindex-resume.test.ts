// #54 — resumable reindex. The durable content-addressed embeddings cache is
// the checkpoint: batches commit as they complete, so an interrupted build
// banks its progress and the next build embeds only the remainder. Driven
// with an injected fake provider (no model download), unlike reindex.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err, ok } from "../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../src/search/embedding-provider.js";
import { reindexVault } from "../../src/search/reindex.js";
import { resetProviderForTests, setProviderForTests } from "../../src/search/vector.js";
import { openIndexDb } from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const DIM = 4;

// A provider that embeds deterministically but can be told to die after a
// given number of embed() calls — the SIGTERM-mid-build stand-in.
function fakeProvider(dieAfterCalls = Number.POSITIVE_INFINITY): {
  provider: EmbeddingProvider;
  calls: () => number;
  embedded: () => number;
} {
  let calls = 0;
  let embedded = 0;
  const provider: EmbeddingProvider = {
    id: "fake-resume",
    dim: DIM,
    warm: async () => ok(undefined),
    embed: async (texts, onProgress) => {
      calls += 1;
      if (calls > dieAfterCalls) return err(new Error("provider killed mid-build"));
      embedded += texts.length;
      onProgress?.(texts.length, texts.length);
      return ok(texts.map(() => new Float32Array(DIM).fill(0.5)));
    },
  };
  return { provider, calls: () => calls, embedded: () => embedded };
}

function embeddingRowCount(vault: string): number {
  const db = openIndexDb(vault, DIM);
  if (!db.ok) throw db.error;
  try {
    const row = db.value
      .prepare("SELECT COUNT(*) AS n FROM embeddings WHERE model = ?")
      .get("fake-resume") as { n: number };
    return row.n;
  } finally {
    db.value.close();
  }
}

describe("resumable reindex (#54)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
    resetProviderForTests();
  });

  it("an interrupted build banks completed batches; the next build embeds only the rest", async () => {
    // First build: the provider dies after two embed() calls. With a batch
    // size of 2, exactly 4 embeddings must be committed before the failure.
    const dying = fakeProvider(2);
    setProviderForTests(dying.provider);
    const first = await reindexVault(vault, { embedCommitBatch: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.vectorEnabled).toBe(false); // degraded, not failed
    expect(first.value.embeddedCount).toBe(4); // committed, not attempted
    expect(embeddingRowCount(vault)).toBe(4);

    // Second build with a healthy provider: only the remainder embeds — the
    // banked batches are cache hits.
    const healthy = fakeProvider();
    setProviderForTests(healthy.provider);
    const second = await reindexVault(vault, { embedCommitBatch: 2 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.vectorEnabled).toBe(true);
    const totalUnique = second.value.embeddedCount + 4;
    expect(second.value.cacheHits).toBeGreaterThanOrEqual(4);
    expect(healthy.embedded()).toBe(second.value.embeddedCount);
    expect(embeddingRowCount(vault)).toBe(totalUnique);

    // Third build: everything cached, zero embeds — the steady state.
    const idle = fakeProvider();
    setProviderForTests(idle.provider);
    const third = await reindexVault(vault, { embedCommitBatch: 2 });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.embeddedCount).toBe(0);
    expect(idle.calls()).toBe(0);
  }, 60_000);

  it("progress stays monotonic across batch commits", async () => {
    const healthy = fakeProvider();
    setProviderForTests(healthy.provider);
    const seen: Array<[number, number]> = [];
    const result = await reindexVault(vault, {
      embedCommitBatch: 3,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(seen.length).toBeGreaterThan(0);
    const total = seen[0]?.[1] ?? 0;
    expect(seen.every(([, t]) => t === total)).toBe(true); // one global total
    for (let i = 1; i < seen.length; i++) {
      expect((seen[i]?.[0] ?? 0) >= (seen[i - 1]?.[0] ?? 0)).toBe(true);
    }
    expect(seen[seen.length - 1]?.[0]).toBe(total); // finishes at total
  }, 60_000);
});
