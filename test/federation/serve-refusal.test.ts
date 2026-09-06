// Federation is stdio-only in v1 (#297, spec Decision 8): `daftari serve`
// on a config carrying mounts refuses at startup gating, fail-loud.

import { describe, expect, it } from "vitest";
import { validateServeStartup } from "../../src/serve/index.js";
import type { DaftariConfig } from "../../src/utils/config.js";

function baseConfig(overrides: Partial<DaftariConfig>): DaftariConfig {
  return {
    roles: {},
    schemaExtensions: [],
    indexedFields: [],
    hooks: { preWrite: [], preWriteTransform: [] },
    autoCommit: true,
    watch: true,
    warmEmbeddings: true,
    embeddingProvider: "local-minilm",
    backfillIdentityMap: {},
    holderAliases: {},
    shadowMode: false,
    shadowModeSet: false,
    gitDir: undefined,
    lintVoice: "plain",
    tensionScan: { maxLlmCalls: 200, maxDocs: 50, agent: "agent:sleep-tension-scan" },
    tools: { tier: "full", include: [], exclude: [] },
    server: { tokens: [] },
    storage: undefined,
    codeRepos: {},
    jitAnchors: true,
    autoRepin: true,
    distill: undefined,
    federation: undefined,
    ...overrides,
  };
}

describe("serve refuses federation (stdio-only v1)", () => {
  it("refuses startup when mounts are declared", () => {
    const result = validateServeStartup(
      baseConfig({
        federation: {
          mounts: [{ alias: "research", path: "../ref", index: "full", optional: false }],
          principals: {},
        },
      }),
      "127.0.0.1",
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      "federation is stdio-only in v1; remove the federation block or run stdio",
    );
  });

  it("allows a principals-only block — that is the REFERENCED vault's half", () => {
    const result = validateServeStartup(
      baseConfig({
        federation: { mounts: [], principals: { "human:mihir": { role: "researcher" } } },
      }),
      "127.0.0.1",
      {},
    );
    expect(result.ok).toBe(true);
  });
});
