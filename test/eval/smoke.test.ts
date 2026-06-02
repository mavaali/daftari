// Opt-in: real Anthropic API. Skipped unless ANTHROPIC_API_KEY is set.
// Run manually before releases that touch src/eval/. Not part of CI default.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { generateQuestions } from "../../src/eval/generate.js";
import { createAnthropicClient } from "../../src/eval/llm.js";
import { runAnswerer } from "../../src/eval/run.js";
import { sampleSubgraph } from "../../src/eval/subgraph.js";
import { vaultReindex } from "../../src/tools/search.js";

const MODEL = "claude-sonnet-4-6";
const skipIfNoKey = !process.env.ANTHROPIC_API_KEY;

describe.skipIf(skipIfNoKey)("eval smoke (real LLM)", () => {
  it("runs N=3 K=1 against sample-vault without crashing", async () => {
    const vault = await mkdtemp(join(tmpdir(), "daftari-smoke-"));
    try {
      await cp(resolve(__dirname, "../fixtures/sample-vault"), vault, {
        recursive: true,
        filter: (src) => !src.includes(`${sep}.git`),
      });
      const reindex = await vaultReindex(vault);
      expect(reindex.ok).toBe(true);

      const sg = await sampleSubgraph(vault, "smoke-seed", { maxNodes: 4 });
      expect(sg.ok).toBe(true);
      if (!sg.ok) return;

      const client = createAnthropicClient();
      const qs = await generateQuestions(sg.value, client, {
        n: 3,
        model: MODEL,
        vaultHash: "h",
        seed: "smoke-seed",
      });
      expect(qs.ok).toBe(true);
      if (!qs.ok) return;

      const run = await runAnswerer(qs.value, vault, client, { k: 1, model: MODEL });
      expect(run.ok).toBe(true);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  }, 300_000); // 5-minute timeout for real LLM calls
});
