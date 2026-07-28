// RerankProvider — pluggable local cross-encoder reranker.
//
// Mirrors EmbeddingProvider (src/search/embedding-provider.ts) and its
// vector.ts selection block: config-selected, instantiated once per process
// (memoised by setRerankProvider/getRerankProvider), warm()/lazy-load,
// Result-typed failures with graceful degradation. Spec 2026-07-26-
// contextual-chunking-reranker-design.md Decision 5.
//
// "none" (the default) maps to null — callers branch on presence, no
// null-object provider. There is exactly one real provider today
// (local-bge-m3); a second would mean a new id in utils/config.ts's
// RERANK_PROVIDERS AND a new branch in instantiateProvider below.
//
// Contract:
//   - `id` is a stable namespace, mirrors EmbeddingProvider.id.
//   - `isReady()` is true once the model is loaded into memory. The search
//     path (src/tools/search.ts) checks this BEFORE ever attempting a
//     rerank and never blocks a tool call on a cold model load (spec C5,
//     from the plan's challenge resolution): a configured-but-not-warm
//     reranker skips reranking for THIS search (rerankUsed stays false) and
//     fires a background warmRerankModel() instead.
//   - `warm()` is the eager-load entry point, invoked from the same
//     background-warm path that warms the embedding model (src/index.ts's
//     runBackgroundWarm, guarded by the existing warmEmbeddings config flag
//     — no new knob, per spec Decision 8).
//   - `rerank(query, passages)` returns one relevance score per passage, in
//     input order. Result.err = degrade to the fused order — a missing or
//     failing 600MB model must never fail a search.

import type { Result } from "../frontmatter/types.js";
import type { RerankProviderId } from "../utils/config.js";
import { localBgeM3Provider, resetLocalBgeM3ForTests } from "./providers/local-bge-m3.js";

export interface RerankProvider {
  readonly id: string;
  isReady(): boolean;
  warm(): Promise<Result<void, Error>>;
  rerank(query: string, passages: string[]): Promise<Result<number[], Error>>;
}

// The active provider for this process. null means "none" — no rerank stage.
let activeProvider: RerankProvider | null = null;
// Tracked separately from `activeProvider` purely so setRerankProvider can
// no-op on a repeated call with the same id (mirrors vector.ts's
// `activeProvider.id === id` check, adapted for a nullable active provider).
let activeId: RerankProviderId = "none";

function instantiateProvider(id: RerankProviderId): RerankProvider | null {
  switch (id) {
    case "none":
      return null;
    case "local-bge-m3":
      return localBgeM3Provider;
  }
}

// Called once at server startup (after loadConfig), in the same try/fail-
// loud block as setProvider. Idempotent for the same id.
export function setRerankProvider(id: RerankProviderId): void {
  if (activeId === id) return;
  activeId = id;
  activeProvider = instantiateProvider(id);
}

// Returns the active provider, or null when rerank.provider is "none" (the
// default). Callers branch on presence — there is no null-object provider.
export function getRerankProvider(): RerankProvider | null {
  return activeProvider;
}

// Eagerly loads the active provider (if any) so the first rerank-enabled
// search does not pay the cold start. A no-op ok() when no provider is
// configured — mirrors warmModel()'s shape but never fails just because
// reranking is off.
export async function warmRerankModel(): Promise<Result<void, Error>> {
  if (!activeProvider) return { ok: true, value: undefined };
  return activeProvider.warm();
}

// Test-only: install an arbitrary provider (or null) directly, bypassing
// config-driven selection. Used by tests that need a fast, deterministic
// fake reranker without paying the model-load cost. Does NOT touch
// `activeId` — a later real setRerankProvider(id) call still compares
// against the id it was last given production-side, matching
// setProviderForTests' behaviour in vector.ts.
export function setRerankProviderForTests(p: RerankProvider | null): void {
  activeProvider = p;
}

// Test-only: revert to no provider ("none") and clear local-bge-m3's
// memoised model. Production code must not call this.
export function resetRerankProviderForTests(): void {
  activeProvider = null;
  activeId = "none";
  resetLocalBgeM3ForTests();
}
