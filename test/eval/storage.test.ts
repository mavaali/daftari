import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendHistory,
  readHistory,
  readQuestionSet,
  writeQuestionSet,
} from "../../src/eval/storage.js";
import {
  HISTORY_RETENTION,
  type HistoryEntry,
  type QuestionSet,
  SPEC_VERSION,
} from "../../src/eval/types.js";

let vault: string;
beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "daftari-eval-"));
});
afterEach(async () => {
  await rm(vault, { recursive: true, force: true });
});

const sampleQuestionSet = (id = "qs-1"): QuestionSet => ({
  id,
  vault_hash: "abc123",
  seed: "seed-1",
  timestamp: "2026-05-31T00:00:00Z",
  subgraph: { seed_doc: "a.md", nodes: ["a.md"], edges: [] },
  questions: [],
  generator_model: "claude-sonnet-fake",
  prompt_version: 1,
  tier_counts_requested: { retrieval: 5, cross_reference: 5, contradiction: 5 },
  tier_counts_produced: { retrieval: 5, cross_reference: 5, contradiction: 5 },
});

describe("storage", () => {
  it("round-trips a question set", async () => {
    const qs = sampleQuestionSet();
    await writeQuestionSet(vault, qs);
    const back = await readQuestionSet(vault, qs.id);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(qs);
  });

  it("rotates history at the retention boundary", async () => {
    for (let i = 0; i < HISTORY_RETENTION + 5; i++) {
      const entry: HistoryEntry = {
        score_id: `s-${i}`,
        score: 0.5,
        score_std: 0.01,
        by_tier: { retrieval: 0.9, cross_reference: 0.6, contradiction: 0.3 },
        vault_hash: "abc",
        timestamp: new Date(2026, 4, 31, 0, 0, i).toISOString(),
        n: 15,
        k: 2,
        models: { generator: "g", answerer: "a", grader: "gr" },
        prompt_version: 1,
        spec_version: SPEC_VERSION,
      };
      await appendHistory(vault, entry);
    }
    const h = await readHistory(vault);
    expect(h.ok).toBe(true);
    if (h.ok) expect(h.value.runs.length).toBe(HISTORY_RETENTION);
  });

  it("returns err for a missing question set", async () => {
    const back = await readQuestionSet(vault, "does-not-exist");
    expect(back.ok).toBe(false);
  });
});
