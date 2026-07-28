// RerankProvider selection (spec 2026-07-26-contextual-chunking-reranker-
// design.md Decision 5). Mirrors the embedding-provider selection tests in
// spirit: memoisation, "none" -> null, isReady semantics, test seams — all
// exercised with a fake provider so this file never touches the real
// local-bge-m3 model or the network.

import { afterEach, describe, expect, it } from "vitest";
import { ok } from "../../src/frontmatter/types.js";
import {
  getRerankProvider,
  type RerankProvider,
  resetRerankProviderForTests,
  setRerankProvider,
  setRerankProviderForTests,
  warmRerankModel,
} from "../../src/search/rerank-provider.js";

function fakeProvider(overrides: Partial<RerankProvider> = {}): RerankProvider {
  return {
    id: "fake-rerank",
    isReady: () => true,
    warm: async () => ok(undefined),
    rerank: async (_query, passages) => ok(passages.map(() => 1)),
    ...overrides,
  };
}

describe("rerank provider selection", () => {
  afterEach(() => {
    resetRerankProviderForTests();
  });

  it("defaults to no provider ('none' maps to null)", () => {
    expect(getRerankProvider()).toBeNull();
  });

  it("setRerankProvider('none') keeps it null", () => {
    setRerankProvider("none");
    expect(getRerankProvider()).toBeNull();
  });

  it("setRerankProvider('local-bge-m3') installs the real provider object", () => {
    setRerankProvider("local-bge-m3");
    const provider = getRerankProvider();
    expect(provider).not.toBeNull();
    expect(provider?.id).toBe("local-bge-m3");
  });

  it("setRerankProvider is idempotent for a repeated id", () => {
    setRerankProvider("local-bge-m3");
    const first = getRerankProvider();
    setRerankProvider("local-bge-m3");
    const second = getRerankProvider();
    expect(second).toBe(first); // same object reference — no reinstantiation
  });

  it("setRerankProviderForTests installs an arbitrary provider, bypassing config selection", () => {
    const fake = fakeProvider();
    setRerankProviderForTests(fake);
    expect(getRerankProvider()).toBe(fake);
  });

  it("setRerankProviderForTests(null) simulates 'none' without touching setRerankProvider's memoisation", () => {
    setRerankProviderForTests(fakeProvider());
    setRerankProviderForTests(null);
    expect(getRerankProvider()).toBeNull();
  });

  it("resetRerankProviderForTests reverts to no provider", () => {
    setRerankProviderForTests(fakeProvider());
    resetRerankProviderForTests();
    expect(getRerankProvider()).toBeNull();
  });

  it("isReady() reflects the installed fake provider's own semantics", () => {
    const notReady = fakeProvider({ isReady: () => false });
    setRerankProviderForTests(notReady);
    expect(getRerankProvider()?.isReady()).toBe(false);

    setRerankProviderForTests(fakeProvider({ isReady: () => true }));
    expect(getRerankProvider()?.isReady()).toBe(true);
  });

  it("warmRerankModel() is a no-op ok() when no provider is configured", async () => {
    const result = await warmRerankModel();
    expect(result.ok).toBe(true);
  });

  it("warmRerankModel() delegates to the active provider's warm()", async () => {
    let warmed = false;
    setRerankProviderForTests(
      fakeProvider({
        warm: async () => {
          warmed = true;
          return ok(undefined);
        },
      }),
    );
    const result = await warmRerankModel();
    expect(result.ok).toBe(true);
    expect(warmed).toBe(true);
  });
});
