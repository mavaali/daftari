// test/distill/partial-retry.test.ts
//
// Bead kphd (Part A): a run where SOME chunks fail and others yield claims
// lands the good claims, advances the content hash, and records the failed
// chunks' anchors. The next run over the unchanged source re-extracts only
// those chunks instead of no-op'ing past them forever. Exit code stays 0 on a
// partial run (Part B is out of scope).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../src/eval/llm.js";
import { err, ok } from "../../src/frontmatter/types.js";

const fake: { completeJson: LlmClient["completeJson"] } = {
  completeJson: async () => err({ kind: "llm", message: "unset", retryable: false }),
};

vi.mock("../../src/eval/transport.js", () => ({
  createTransportClient: () =>
    ok({
      complete: vi.fn(),
      completeWithTools: vi.fn(),
      completeJson: (opts: Parameters<LlmClient["completeJson"]>[0]) => fake.completeJson(opts),
    }),
}));

const { runDistill } = await import("../../src/distill/cli.js");
const { distillUpsert, pendingChunkRetry, readDistillState, sourceContentHash, writeDistillState } =
  await import("../../src/distill/state.js");
type ExtractedClaim = import("../../src/distill/extract.js").ExtractedClaim;
type ProposeOutcome = import("../../src/distill/propose.js").ProposeOutcome;

const CONFIG_YAML = ["version: 1", "distill:", "  model: claude-sonnet-5-5", ""].join("\n");

// 31 messages ⇒ two 30-message chunks; "Point number 30." is only in chunk 2.
const TWO_CHUNK_TRANSCRIPT = Array.from(
  { length: 31 },
  (_, i) => `[1/2/26, 9:${String(i).padStart(2, "0")}:00 AM] Alice: Point number ${i}.`,
).join("\n");
const CHUNK2_MARKER = "Point number 30.";

let vault: string;
let source: string;
let out: string[];
let errOut: string[];
let prompts: string[];
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-distill-retry-"));
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(join(vault, ".daftari", "config.yaml"), CONFIG_YAML);
  source = join(vault, "chat.txt");
  writeFileSync(source, TWO_CHUNK_TRANSCRIPT);
  out = [];
  errOut = [];
  prompts = [];
  process.stdout.write = ((c: unknown) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    errOut.push(String(c));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  rmSync(vault, { recursive: true, force: true });
});

/** Chunk 2 errors when `failChunk2`; every other chunk yields one claim naming its content. */
function client(failChunk2: boolean): void {
  fake.completeJson = async (opts) => {
    prompts.push(opts.user);
    const isChunk2 = opts.user.includes(CHUNK2_MARKER);
    if (isChunk2 && failChunk2) {
      return err({ kind: "llm", message: "unparseable JSON", retryable: false });
    }
    return ok({
      text: "{}",
      parsed: {
        claims: [{ statement: isChunk2 ? "Alice made point thirty." : "Alice listed points." }],
      },
      input_tokens: 1,
      output_tokens: 1,
      stop_reason: "end_turn",
    });
  };
}

function stagedCount(): number {
  try {
    const raw = readFileSync(join(vault, ".daftari", "staged-actions.jsonl"), "utf-8");
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function reset(): void {
  out = [];
  errOut = [];
  prompts = [];
}

describe("distill --propose — partial chunk failure is retried next run (bead kphd)", () => {
  it("(a) run 1 records the failed anchor, run 2 extracts only it, run 3 no-ops", async () => {
    // Run 1: chunk 1 lands, chunk 2 errors.
    client(true);
    expect(await runDistill(["--vault", vault, "--propose", source])).toBe(0);
    expect(stagedCount()).toBe(1);
    const run1 = readDistillState(vault).sources.chat;
    expect(run1?.content_hash).toBe(sourceContentHash(TWO_CHUNK_TRANSCRIPT));
    expect(run1?.failed_chunk_anchors).toHaveLength(1);
    expect(errOut.join("")).toMatch(/1 chunk\(s\) pending retry on the next run/);

    // Run 2: working model, only the failed chunk is sent.
    reset();
    client(false);
    expect(await runDistill(["--vault", vault, "--propose", source])).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(CHUNK2_MARKER);
    expect(errOut.join("")).toMatch(/re-extracting 1 previously failed chunk\(s\)/);
    expect(out.join("")).toMatch(/created:\s+1/);
    expect(stagedCount()).toBe(2);
    expect(readDistillState(vault).sources.chat?.failed_chunk_anchors).toBeUndefined();
    expect(errOut.join("")).not.toMatch(/pending retry/);

    // Run 3: nothing pending — a whole-source no-op, nothing new staged.
    reset();
    expect(await runDistill(["--vault", vault, "--propose", source])).toBe(0);
    expect(out.join("")).toMatch(/noop:\s+true/);
    expect(errOut.join("")).not.toMatch(/re-extracting/);
    expect(stagedCount()).toBe(2);
  });

  it("a retry whose chunk fails again keeps it pending and still exits 0", async () => {
    client(true);
    expect(await runDistill(["--vault", vault, "--propose", source])).toBe(0);
    const anchors = readDistillState(vault).sources.chat?.failed_chunk_anchors;

    reset();
    expect(await runDistill(["--vault", vault, "--propose", source])).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(readDistillState(vault).sources.chat?.failed_chunk_anchors).toEqual(anchors);
    expect(errOut.join("")).toMatch(/1 chunk\(s\) pending retry on the next run/);
    expect(stagedCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// State-level behaviour (no CLI)
// ---------------------------------------------------------------------------

const CONTENT = "alice: tea\nbob: deploy checklist\n";
const CLAIM_A: ExtractedClaim = {
  claim_key: "a1:alice-tea-aaaa1111",
  statement: "Alice prefers tea.",
  proposed_frontmatter: { title: "Alice prefers tea" },
};
const CLAIM_B: ExtractedClaim = {
  claim_key: "a2:bob-checklist-bbbb2222",
  statement: "Bob owns the checklist.",
  proposed_frontmatter: { title: "Bob owns the checklist" },
};

describe("distillUpsert — failed_chunk_anchors (bead kphd)", () => {
  it("(b) an old state file without the field still no-ops on an unchanged hash", async () => {
    const wrote = writeDistillState(vault, {
      sources: { src: { content_hash: sourceContentHash(CONTENT), claims: {} } },
    });
    expect(wrote.ok).toBe(true);
    expect(pendingChunkRetry(vault, { sourceId: "src", sourceContent: CONTENT })).toEqual([]);
    const res = await distillUpsert(vault, {
      sourceId: "src",
      sourceContent: CONTENT,
      claims: [CLAIM_A],
      runId: "r",
    });
    expect(res.ok && res.value.noop).toBe(true);
    expect(res.ok && res.value.retryAnchors).toEqual([]);
  });

  it("partial run persists anchors; the retry reports them and clears on success", async () => {
    const first = await distillUpsert(vault, {
      sourceId: "src",
      sourceContent: CONTENT,
      claims: [CLAIM_A],
      runId: "r1",
      extractionErrors: 1,
      failedChunkAnchors: ["a2"],
    });
    expect(first.ok && first.value.created).toEqual([CLAIM_A.claim_key]);
    expect(first.ok && first.value.pendingRetryAnchors).toEqual(["a2"]);
    expect(readDistillState(vault).sources.src?.failed_chunk_anchors).toEqual(["a2"]);
    expect(pendingChunkRetry(vault, { sourceId: "src", sourceContent: CONTENT })).toEqual(["a2"]);

    const second = await distillUpsert(vault, {
      sourceId: "src",
      sourceContent: CONTENT,
      claims: [CLAIM_B],
      runId: "r2",
    });
    expect(second.ok && second.value.noop).toBe(false);
    expect(second.ok && second.value.retryAnchors).toEqual(["a2"]);
    expect(second.ok && second.value.created).toEqual([CLAIM_B.claim_key]);
    expect(readDistillState(vault).sources.src).toEqual({
      content_hash: sourceContentHash(CONTENT),
      claims: {},
    });
  });

  it("a retry whose proposals fail to stage is resumed next run, not stranded", async () => {
    await distillUpsert(vault, {
      sourceId: "src",
      sourceContent: CONTENT,
      claims: [CLAIM_A],
      runId: "r1",
      extractionErrors: 1,
      failedChunkAnchors: ["a2"],
    });
    const failing = async (): Promise<ProposeOutcome> => ({
      proposed: 0,
      results: [],
      errors: [{ claim_key: CLAIM_B.claim_key, error: "stage failed" }],
    });
    await distillUpsert(vault, {
      sourceId: "src",
      sourceContent: CONTENT,
      claims: [CLAIM_B],
      runId: "r2",
      proposeClaims: failing,
    });

    // Extraction for a2 succeeded, so it is no longer a failed chunk — but its
    // claim is pending staging and the next run must not no-op past it.
    const third = await distillUpsert(vault, {
      sourceId: "src",
      sourceContent: CONTENT,
      claims: [],
      runId: "r3",
    });
    expect(third.ok && third.value.noop).toBe(false);
    expect(third.ok && third.value.created).toEqual([CLAIM_B.claim_key]);
    expect(readDistillState(vault).sources.src).toEqual({
      content_hash: sourceContentHash(CONTENT),
      claims: {},
    });
  });
  it("a scoped pass keeps its own retry manifest, separate from the unscoped one", async () => {
    const scope = "sender:assistant";
    await distillUpsert(vault, {
      sourceId: "src",
      sourceContent: CONTENT,
      claims: [CLAIM_A],
      runId: "r1",
      scope,
      extractionErrors: 1,
      failedChunkAnchors: ["a2"],
    });
    const s1 = readDistillState(vault).sources.src;
    expect(s1?.failed_chunk_anchors).toBeUndefined();
    expect(s1?.scope_failed_chunk_anchors).toEqual({ [scope]: ["a2"] });
    expect(pendingChunkRetry(vault, { sourceId: "src", sourceContent: CONTENT, scope })).toEqual([
      "a2",
    ]);
    expect(pendingChunkRetry(vault, { sourceId: "src", sourceContent: CONTENT })).toEqual([]);

    const retry = await distillUpsert(vault, {
      sourceId: "src",
      sourceContent: CONTENT,
      claims: [CLAIM_B],
      runId: "r2",
      scope,
    });
    expect(retry.ok && retry.value.retryAnchors).toEqual(["a2"]);
    expect(retry.ok && retry.value.created).toEqual([CLAIM_B.claim_key]);
    expect(readDistillState(vault).sources.src?.scope_failed_chunk_anchors).toBeUndefined();
  });
});
