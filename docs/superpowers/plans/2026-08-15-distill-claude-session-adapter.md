# Distill Claude-session adapter + confidence gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `daftari distill` ingest Claude Code / bot session JSONL and add a corroboration gate so human-sourced or well-corroborated claims auto-ratify while assistant-inferred novel claims queue for a human.

**Architecture:** A new pure `ClaudeSessionAdapter` (mirrors `ChatTranscriptAdapter`) plugs into `ADAPTER_REGISTRY`. Provenance comes from running distill twice per session with a `--sender` filter (Approach 1 — no `extract.ts` schema surgery). The U8 overlap-hinter is extended to surface the top neighbor's fused search score; propose stamps it as `proposedDiff.corroboration ∈ [0,1]`; `distill --review --auto-safe --corroboration-threshold T` ratifies only staged claims at or above `T`. The sleep job then pipes real session logs through this staged, auditable pipeline instead of hand-rolled memory writes.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest (`test/distill/*.test.ts`, `makeTempVault`/`cleanupVault` from `test/helpers/temp-vault.js`), Biome lint, daftari CLI (`daftari distill`), zsh/launchd for the sleep-job wiring.

**Spec:** `docs/superpowers/specs/2026-08-14-distill-claude-session-adapter-design.md` (R1–R15). Read it first.

---

## Pre-flight (do once, before Task 1)

- [ ] **P0: Rebase onto current main.** The branch `feat/distill-claude-session-adapter` is 3 commits ahead / 9 behind `origin/main`. Rebase to avoid drift against the merged a28 pipeline.

Run:
```bash
cd /Users/mihirwagle/projects/daftari
git fetch origin
git rebase origin/main
```
Expected: clean rebase (the branch only adds a spec doc + a vitest-config tweak). Resolve any conflict in `vitest.config.*` conservatively. Then:
```bash
npm test
```
Expected: full suite green before any new code.

---

## File Structure

| File | New/Modify | Responsibility |
|---|---|---|
| `src/distill/adapters/claude-session.ts` | **new** | `ClaudeSessionAdapter implements SourceAdapter` — parse session JSONL → `NormalizedMessage[]` (R1–R4) |
| `test/distill/claude-session.test.ts` | **new** | Adapter unit tests |
| `src/distill/index.ts` | modify | Register `claude-session` in `ADAPTER_REGISTRY`; export the adapter class |
| `src/distill/cli.ts` | modify | `--source-type` flag + `.jsonl` auto-detect (R5); `--sender` filter (R6); `--auto-safe` + `--corroboration-threshold` in `reviewRun` (R8) |
| `test/distill/cli.test.ts` | modify | Adapter-selection + `--sender` filter tests |
| `src/distill/propose.ts` | modify | `OverlapSearchFn` returns top score; stamp `proposedDiff.corroboration` (R7) |
| `test/distill/propose.test.ts` + `test/distill/overlap-hint.test.ts` | modify | Corroboration stamping tests |
| `src/distill/state.ts` | modify | Thread the richer `OverlapSearchFn` return through `distillUpsert` (type-only; call is unchanged) |
| `test/distill/review.test.ts` | modify | `--auto-safe` gate tests |
| `src/utils/config.ts` | modify | Recognise + validate `corroboration_threshold` float in `distill:` block (R12) |
| `test/**/config*.test.ts` | modify | Config validation tests for the new key |
| `test/distill/session-e2e.test.ts` | **new** | R9 five-step end-to-end flow on a temp vault |
| `~/scripts/mavaali-sleep.sh` | modify (mavaali install, NOT this repo) | Replace hand-rolled extraction with the R9 flow (R9/R10) |

**Requirement → Task map:** R1–R4 → T1 · R5 → T2 · R6 → T3 · R7 → T4 · R8/R12 → T5 · R9-e2e → T6 · R9/R10 sleep-job → T7. Non-goals R13–R15 are asserted by omission (no code).

---

## Task 1: `claude-session` adapter (R1–R4)

**Files:**
- Create: `src/distill/adapters/claude-session.ts`
- Test: `test/distill/claude-session.test.ts`

The adapter is a pure `parse(raw: string) => NormalizedMessage[]`. `raw` is the full JSONL file text (newline-delimited JSON objects). Each line is one record. Rules (from spec R1–R4):

- Split on `\n`; skip blank lines; `JSON.parse` each line inside try/catch — a malformed line is **skipped, never throws**.
- Keep only records whose top-level `.type` is `"user"` or `"assistant"`. Drop everything else (`progress`, `queue-operation`, `last-prompt`, `pr-link`, `system`, and any unknown type).
- `sender`: `"user"` or `"assistant"`, taken from `.message.role` when present, else the top-level `.type`.
- Text from `.message.content`:
  - a **string** → used verbatim;
  - an **array** → concatenate the `.text` of each block whose block `.type === "text"`, in order, joined by `"\n"`; **omit `tool_use`, `tool_result`, and `thinking` blocks**, and any block lacking a `.text` string.
- `ts`: `.timestamp` (UTC millis, e.g. `2026-07-31T03:47:39.817Z`) truncated to `YYYY-MM-DDTHH:MM:SS` (first 19 chars). If `.timestamp` is missing/not a string, skip the record.
- `type` is always `"text"`; `attachment` is always `null` (image/file blocks dropped, R14).
- A record whose resulting text is **empty after trim** (tool-only / thinking-only turn) is **skipped**.
- Empty input (`""` or whitespace) → `[]`.

- [ ] **Step 1: Write the failing test file.**

```typescript
// test/distill/claude-session.test.ts
import { describe, expect, it } from "vitest";
import { ClaudeSessionAdapter } from "../../src/distill/adapters/claude-session.js";

const adapter = new ClaudeSessionAdapter();

function jsonl(...records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

describe("ClaudeSessionAdapter", () => {
  it("sourceId is claude-session", () => {
    expect(adapter.sourceId()).toBe("claude-session");
  });

  it("empty input → []", () => {
    expect(adapter.parse("")).toEqual([]);
    expect(adapter.parse("   \n  ")).toEqual([]);
  });

  it("string content is used verbatim; sender + ts mapped", () => {
    const raw = jsonl({
      type: "user",
      timestamp: "2026-07-31T03:47:39.817Z",
      message: { role: "user", content: "pick up bead b6b" },
    });
    expect(adapter.parse(raw)).toEqual([
      {
        ts: "2026-07-31T03:47:39",
        sender: "user",
        type: "text",
        text: "pick up bead b6b",
        attachment: null,
      },
    ]);
  });

  it("array content keeps text blocks in order, drops tool_use/tool_result/thinking", () => {
    const raw = jsonl({
      type: "assistant",
      timestamp: "2026-07-31T03:48:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "scratchpad" },
          { type: "text", text: "First." },
          { type: "tool_use", name: "Bash", input: {} },
          { type: "text", text: "Second." },
          { type: "tool_result", content: "output" },
        ],
      },
    });
    expect(adapter.parse(raw)).toEqual([
      {
        ts: "2026-07-31T03:48:00",
        sender: "assistant",
        type: "text",
        text: "First.\nSecond.",
        attachment: null,
      },
    ]);
  });

  it("thinking-only and tool-only turns are skipped (empty text)", () => {
    const raw = jsonl(
      {
        type: "assistant",
        timestamp: "2026-07-31T03:49:00.000Z",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-07-31T03:49:01.000Z",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] },
      },
    );
    expect(adapter.parse(raw)).toEqual([]);
  });

  it("drops bot/system event types", () => {
    const raw = jsonl(
      { type: "progress", timestamp: "2026-07-31T03:50:00.000Z", body: "…" },
      { type: "queue-operation", timestamp: "2026-07-31T03:50:01.000Z" },
      { type: "last-prompt", timestamp: "2026-07-31T03:50:02.000Z" },
      { type: "pr-link", timestamp: "2026-07-31T03:50:03.000Z" },
      { type: "system", timestamp: "2026-07-31T03:50:04.000Z", content: "boot" },
      { type: "totally-unknown", timestamp: "2026-07-31T03:50:05.000Z" },
      {
        type: "user",
        timestamp: "2026-07-31T03:50:06.000Z",
        message: { role: "user", content: "kept" },
      },
    );
    const out = adapter.parse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("kept");
  });

  it("malformed/truncated JSON line is skipped, not thrown", () => {
    const raw = [
      '{"type":"user","timestamp":"2026-07-31T03:51:00.000Z","message":{"role":"user","content":"a"}}',
      '{"type":"user","timestamp":"2026-07-31T03:51:01.00', // truncated
      '',
      '{"type":"user","timestamp":"2026-07-31T03:51:02.000Z","message":{"role":"user","content":"b"}}',
    ].join("\n");
    const out = adapter.parse(raw);
    expect(out.map((m) => m.text)).toEqual(["a", "b"]);
  });

  it("record with missing/invalid timestamp is skipped", () => {
    const raw = jsonl(
      { type: "user", message: { role: "user", content: "no ts" } },
      { type: "user", timestamp: 12345, message: { role: "user", content: "num ts" } },
    );
    expect(adapter.parse(raw)).toEqual([]);
  });

  it("sender falls back to top-level type when message.role absent", () => {
    const raw = jsonl({
      type: "assistant",
      timestamp: "2026-07-31T03:52:00.000Z",
      message: { content: "no role field" },
    });
    expect(adapter.parse(raw)[0].sender).toBe("assistant");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run test/distill/claude-session.test.ts`
Expected: FAIL — cannot resolve `../../src/distill/adapters/claude-session.js`.

- [ ] **Step 3: Write the adapter.**

```typescript
// src/distill/adapters/claude-session.ts
//
// SourceAdapter for Claude Code / bot session JSONL logs.
// Each input line is one JSON record. Only user/assistant turns become
// NormalizedMessage rows; tool_use/tool_result/thinking blocks and all
// bot/system event types are dropped. Pure: no I/O, never throws on a
// malformed line (that line is skipped).

import type { NormalizedMessage, SourceAdapter } from "./types.js";

// Top-level record types that carry human/assistant prose. Everything else
// (progress, queue-operation, last-prompt, pr-link, system, unknown) is dropped.
const KEPT_TYPES = new Set(["user", "assistant"]);

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      parts.push((block as Record<string, unknown>).text as string);
    }
  }
  return parts.join("\n");
}

export class ClaudeSessionAdapter implements SourceAdapter {
  sourceId(): string {
    return "claude-session";
  }

  parse(raw: string): NormalizedMessage[] {
    if (!raw.trim()) return [];

    const messages: NormalizedMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;

      let rec: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object") continue;
        rec = parsed as Record<string, unknown>;
      } catch {
        continue; // malformed/truncated line — skip, never throw (R1)
      }

      const topType = rec.type;
      if (typeof topType !== "string" || !KEPT_TYPES.has(topType)) continue; // R2

      const ts = rec.timestamp;
      if (typeof ts !== "string" || ts.length < 19) continue; // R4: need YYYY-MM-DDTHH:MM:SS

      const message = rec.message;
      if (message === null || typeof message !== "object") continue;
      const msg = message as Record<string, unknown>;

      const sender =
        typeof msg.role === "string" && (msg.role === "user" || msg.role === "assistant")
          ? msg.role
          : topType; // R4: role wins, else top-level type

      const text = extractText(msg.content).trim(); // R3
      if (text === "") continue; // tool-only / thinking-only turn → skip

      messages.push({
        ts: ts.slice(0, 19), // truncate UTC millis to whole seconds (R4)
        sender,
        type: "text",
        text,
        attachment: null,
      });
    }

    return messages;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run test/distill/claude-session.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint + commit.**

```bash
npx biome check --write src/distill/adapters/claude-session.ts test/distill/claude-session.test.ts
git add src/distill/adapters/claude-session.ts test/distill/claude-session.test.ts
git commit -m "feat(distill): claude-session JSONL SourceAdapter (R1–R4)"
```

---

## Task 2: Adapter selection — registry + `--source-type` + auto-detect (R5)

**Files:**
- Modify: `src/distill/index.ts` (register + export)
- Modify: `src/distill/cli.ts` (flag, auto-detect, selection at the parse site ~L291-327, L406-415)
- Test: `test/distill/cli.test.ts`

Selection rule: explicit `--source-type <chat-transcript|claude-session>` wins; absent → auto-detect by the source path extension (`.jsonl` → `claude-session`, else `chat-transcript`). stdin with no `--source-type` → `chat-transcript` (unchanged default). An unknown `--source-type` value is a usage error (exit 2).

- [ ] **Step 1: Register the adapter in `index.ts`.**

In `src/distill/index.ts`, add to the import block near L44 and the registry at L54-56:
```typescript
import { ChatTranscriptAdapter } from "./adapters/chat-transcript.js";
import { ClaudeSessionAdapter } from "./adapters/claude-session.js"; // ADD

export const ADAPTER_REGISTRY: Record<string, SourceAdapter> = {
  "chat-transcript": new ChatTranscriptAdapter(),
  "claude-session": new ClaudeSessionAdapter(), // ADD
};
```
Also add a re-export next to the existing `ChatTranscriptAdapter` export (~L22):
```typescript
export { ClaudeSessionAdapter } from "./adapters/claude-session.js";
```

- [ ] **Step 2: Write the failing CLI selection tests** (append to `test/distill/cli.test.ts`).

```typescript
// --- adapter selection (R5) ---
// Each test runs `distill --plan` (zero-spend) and asserts the chunk count
// reflects the adapter that parsed the fixture: a .jsonl source parsed by the
// claude-session adapter yields chunks; parsed by chat-transcript it yields 0
// (the JSONL lines match no chat-transcript line pattern).

it("--plan auto-detects claude-session for a .jsonl source", async () => {
  const file = join(tmpDir, "session.jsonl");
  writeFileSync(
    file,
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-31T03:47:39.817Z",
      message: { role: "user", content: "hello there this is a real turn" },
    }),
  );
  const out = await capture(() => runDistill(["--vault", vault, "--plan", file]));
  expect(out.code).toBe(0);
  expect(out.stdout).toMatch(/chunks:\s+[1-9]/); // parsed at least one message
});

it("--source-type chat-transcript on a .jsonl source parses 0 chat lines", async () => {
  const file = join(tmpDir, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "user", timestamp: "…", message: {} }));
  const out = await capture(() =>
    runDistill(["--vault", vault, "--plan", "--source-type", "chat-transcript", file]),
  );
  expect(out.code).toBe(0);
  expect(out.stdout).toMatch(/chunks:\s+0/);
});

it("unknown --source-type is a usage error (exit 2)", async () => {
  const file = join(tmpDir, "s.jsonl");
  writeFileSync(file, "{}");
  const out = await capture(() =>
    runDistill(["--vault", vault, "--plan", "--source-type", "bogus", file]),
  );
  expect(out.code).toBe(2);
  expect(out.stderr).toMatch(/source-type/);
});
```
> Match the file's existing harness (`capture`, `tmpDir`, `vault`, imports). If those helpers differ, adapt to the patterns already in `cli.test.ts` — do not invent new ones.

- [ ] **Step 3: Run to verify failure.**

Run: `npx vitest run test/distill/cli.test.ts -t "source-type"`
Expected: FAIL (flag unrecognized / wrong adapter).

- [ ] **Step 4: Implement selection in `cli.ts`.**

(a) Read the flag alongside the others (near L241):
```typescript
const sourceTypeRes = readString(argv, "--source-type");
if (sourceTypeRes === MISSING_FLAG_VALUE) {
  process.stderr.write(`daftari distill: --source-type requires a value\n\n${DISTILL_USAGE}`);
  return 2;
}
const sourceTypeFlag = sourceTypeRes;
if (sourceTypeFlag !== undefined && !(sourceTypeFlag in ADAPTER_REGISTRY)) {
  process.stderr.write(
    `daftari distill: unknown --source-type: ${sourceTypeFlag} ` +
      `(known: ${Object.keys(ADAPTER_REGISTRY).join(", ")})\n\n${DISTILL_USAGE}`,
  );
  return 2;
}
```

(b) Add `"--source-type"` to the `VALUE_FLAGS` set (L291-300).

(c) Replace the hardcoded adapter pick at L412-414:
```typescript
// Adapter selection (R5): explicit --source-type wins; else auto-detect by
// extension (.jsonl → claude-session), stdin/other → chat-transcript.
const sourceType =
  sourceTypeFlag ??
  (sourceArg !== "-" && sourceArg.toLowerCase().endsWith(".jsonl")
    ? "claude-session"
    : "chat-transcript");
const adapter: SourceAdapter = ADAPTER_REGISTRY[sourceType];
```

(d) Update `DISTILL_USAGE` (near L30-60) to document `--source-type <chat-transcript|claude-session>`.

- [ ] **Step 5: Run to verify pass.**

Run: `npx vitest run test/distill/cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + commit.**

```bash
npx biome check --write src/distill/index.ts src/distill/cli.ts test/distill/cli.test.ts
git add src/distill/index.ts src/distill/cli.ts test/distill/cli.test.ts
git commit -m "feat(distill): --source-type flag + .jsonl auto-detect, register claude-session (R5)"
```

---

## Task 3: `--sender` filter (R6)

**Files:**
- Modify: `src/distill/cli.ts` (read flag; filter `messages` post-parse, pre-chunk at L415-416)
- Test: `test/distill/cli.test.ts`

`--sender <user|assistant>` filters normalized messages to that sender before chunking. Absent → all senders (unchanged). Invalid value → usage error (exit 2). This filter is what makes a single-sender pass yield claims of known provenance.

- [ ] **Step 1: Write failing tests** (append to `test/distill/cli.test.ts`).

```typescript
// --- --sender filter (R6) ---
function twoSenderJsonl(): string {
  return [
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-31T03:47:00.000Z",
      message: { role: "user", content: "a user turn worth chunking here" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-31T03:47:10.000Z",
      message: { role: "assistant", content: "an assistant turn worth chunking here" },
    }),
  ].join("\n");
}

it("--sender user chunks only the user turn", async () => {
  const file = join(tmpDir, "s.jsonl");
  writeFileSync(file, twoSenderJsonl());
  const both = await capture(() => runDistill(["--vault", vault, "--plan", file]));
  const userOnly = await capture(() =>
    runDistill(["--vault", vault, "--plan", "--sender", "user", file]),
  );
  const chunks = (s: string) => Number(/chunks:\s+(\d+)/.exec(s)?.[1] ?? "-1");
  expect(chunks(userOnly.stdout)).toBeLessThan(chunks(both.stdout));
  expect(chunks(userOnly.stdout)).toBeGreaterThan(0);
});

it("invalid --sender value is a usage error (exit 2)", async () => {
  const file = join(tmpDir, "s.jsonl");
  writeFileSync(file, twoSenderJsonl());
  const out = await capture(() =>
    runDistill(["--vault", vault, "--plan", "--sender", "robot", file]),
  );
  expect(out.code).toBe(2);
  expect(out.stderr).toMatch(/sender/);
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run test/distill/cli.test.ts -t "sender"`
Expected: FAIL (`--sender` unknown flag).

- [ ] **Step 3: Implement in `cli.ts`.**

(a) Read + validate the flag (near the other reads, ~L241):
```typescript
const senderRes = readString(argv, "--sender");
if (senderRes === MISSING_FLAG_VALUE) {
  process.stderr.write(`daftari distill: --sender requires a value\n\n${DISTILL_USAGE}`);
  return 2;
}
const senderFlag = senderRes;
if (senderFlag !== undefined && senderFlag !== "user" && senderFlag !== "assistant") {
  process.stderr.write(
    `daftari distill: --sender must be 'user' or 'assistant'\n\n${DISTILL_USAGE}`,
  );
  return 2;
}
```

(b) Add `"--sender"` to `VALUE_FLAGS`.

(c) Filter after parse, before chunk (L415-416):
```typescript
let messages = adapter.parse(sourceContent);
if (senderFlag !== undefined) {
  messages = messages.filter((m) => m.sender === senderFlag); // R6
}
const chunks = chunkMessages(messages);
```

(d) Document `--sender <user|assistant>` in `DISTILL_USAGE`.

- [ ] **Step 4: Run to verify pass.**

Run: `npx vitest run test/distill/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit.**

```bash
npx biome check --write src/distill/cli.ts test/distill/cli.test.ts
git add src/distill/cli.ts test/distill/cli.test.ts
git commit -m "feat(distill): --sender filter for sender-partitioned provenance passes (R6)"
```

---

## Task 4: Overlap-hinter score → `proposedDiff.corroboration` (R7)

**Files:**
- Modify: `src/distill/propose.ts` (`OverlapSearchFn` return type, `makeOverlapHinter`, `buildRationale`, `proposeAllClaims`)
- Modify: `src/distill/state.ts` (type-only: `OverlapSearchFn` is re-exported/consumed; the call is unchanged)
- Test: `test/distill/propose.test.ts`, `test/distill/overlap-hint.test.ts`, `test/distill/idempotency.test.ts` (the return-type change breaks a stub at ~L340 — grep confirms; update + stage it)

Change `OverlapSearchFn` from `(statement) => Promise<string[]>` to `(statement) => Promise<{ paths: string[]; topScore: number }>`. `makeOverlapHinter` surfaces `result.value.hits[0]?.score ?? 0` (already min-normalized to `[0,1]` in `hybrid.ts`). `proposeAllClaims` stamps the score onto the staged proposal as `proposedDiff.corroboration ∈ [0,1]`, default `0` when there is no hinter, no neighbor, or a search error. Keep the rationale behavior identical (statement lead + optional "Possible overlaps:" line).

> **All existing stubs must update.** Every test that injects an `overlapSearch` stub currently returns `string[]`; each must now return `{ paths, topScore }`. Grep for them first: `grep -rn "overlapSearch\|OverlapSearchFn\|makeOverlapHinter" test/`.

- [ ] **Step 1: Write/adjust failing tests** in `test/distill/propose.test.ts`:

```typescript
it("stamps proposedDiff.corroboration from the hinter's top score", async () => {
  const hinter = async () => ({ paths: ["decisions/x.md"], topScore: 0.82 });
  const out = await proposeAllClaims(vault, [claim], ids, undefined, hinter);
  expect(out.errors).toEqual([]);
  const staged = await listStagedActions(vault, "pending");
  const mine = staged.value.find((a) => a.runId === ids.runId)!;
  expect((mine.proposedDiff as any).corroboration).toBeCloseTo(0.82);
  // rationale still leads with the statement and shows the overlap line
  expect(mine.rationale.split("\n", 1)[0]).toBe(claim.statement);
  expect(mine.rationale).toMatch(/Possible overlaps: decisions\/x\.md/);
});

it("corroboration defaults to 0 with no hinter", async () => {
  const out = await proposeAllClaims(vault, [claim], ids);
  expect(out.errors).toEqual([]);
  const staged = await listStagedActions(vault, "pending");
  const mine = staged.value.find((a) => a.runId === ids.runId)!;
  expect((mine.proposedDiff as any).corroboration).toBe(0);
});

it("a throwing hinter degrades to corroboration 0 and no overlap line", async () => {
  const hinter = async () => { throw new Error("index down"); };
  const out = await proposeAllClaims(vault, [claim], ids, undefined, hinter);
  expect(out.errors).toEqual([]);
  const staged = await listStagedActions(vault, "pending");
  const mine = staged.value.find((a) => a.runId === ids.runId)!;
  expect((mine.proposedDiff as any).corroboration).toBe(0);
  expect(mine.rationale).toBe(claim.statement);
});
```
And in `test/distill/overlap-hint.test.ts`, update the `makeOverlapHinter` assertions to expect `{ paths, topScore }` and assert `topScore` equals the top hit's fused score (add a hit with a known score to the fixture vault or stubbed `vaultSearch`).

- [ ] **Step 2: Run to verify failure.**

Run: `npx vitest run test/distill/propose.test.ts test/distill/overlap-hint.test.ts`
Expected: FAIL (return-shape mismatch; `corroboration` undefined).

- [ ] **Step 3: Implement in `propose.ts`.**

(a) New return type + hinter (L58-83):
```typescript
export interface OverlapHint {
  /** Vault-relative paths of the top-K likely-overlapping documents. */
  paths: string[];
  /** Fused search score of the top neighbor, min-normalized to [0,1]; 0 if none. */
  topScore: number;
}

export type OverlapSearchFn = (statement: string) => Promise<OverlapHint>;

export function makeOverlapHinter(vaultRoot: string, access?: AccessContext): OverlapSearchFn {
  return async (statement: string): Promise<OverlapHint> => {
    const result = await vaultSearch(
      vaultRoot,
      { query: statement, limit: OVERLAP_HINT_TOP_K },
      access,
    );
    if (!result.ok) return { paths: [], topScore: 0 };
    const hits = result.value.hits.slice(0, OVERLAP_HINT_TOP_K);
    return {
      paths: hits.map((h) => h.path),
      topScore: hits.length > 0 ? hits[0].score : 0,
    };
  };
}
```

(b) Replace `buildRationale` with a combined helper that returns both rationale and corroboration (L202-219):
```typescript
async function buildProposalMeta(
  statement: string,
  overlapSearch?: OverlapSearchFn,
): Promise<{ rationale: string; corroboration: number }> {
  if (!overlapSearch) return { rationale: statement, corroboration: 0 };
  let hint: OverlapHint;
  try {
    hint = await overlapSearch(statement);
  } catch {
    return { rationale: statement, corroboration: 0 }; // search failure never blocks staging
  }
  const corroboration = Number.isFinite(hint.topScore) ? hint.topScore : 0;
  if (!hint.paths || hint.paths.length === 0) return { rationale: statement, corroboration };
  const safePaths = hint.paths
    .slice(0, OVERLAP_HINT_TOP_K)
    .map((p) => p.replace(/[\r\n]+/g, " "));
  return {
    rationale: `${statement}\n\nPossible overlaps: ${safePaths.join(", ")}`,
    corroboration,
  };
}
```

(c) In `proposeAllClaims` (L302-311), consume it and stamp `corroboration`:
```typescript
const { rationale, corroboration } = await buildProposalMeta(claim.statement, overlapSearch);

const staged = await stageActionWithConflictCheck(vaultRoot, {
  actionType: "write",
  targetPath,
  proposedBy: DISTILL_AGENT,
  rationale,
  proposedDiff: { frontmatter, body, corroboration }, // R7: carrier key
  runId: ids.runId,
});
```

- [ ] **Step 4: Fix `state.ts` type flow.** `state.ts` imports `OverlapSearchFn` and passes it straight through (L39, L197, L267-273) — no logic change, but re-run its consumers to confirm the type still lines up. No edit expected beyond a possible re-export.

- [ ] **Step 5: Run to verify pass (whole distill dir — corroboration touches the shared carrier).**

Run: `npx vitest run test/distill/`
Expected: PASS. Fix any stub still returning `string[]`.

- [ ] **Step 6: Lint + commit.**

```bash
npx biome check --write src/distill/propose.ts src/distill/state.ts test/distill/
git add src/distill/propose.ts src/distill/state.ts test/distill/propose.test.ts test/distill/overlap-hint.test.ts test/distill/idempotency.test.ts
git commit -m "feat(distill): surface top overlap score, stamp proposedDiff.corroboration (R7)"
```

---

## Task 5: `--auto-safe` + `--corroboration-threshold` review gate (R8, R12)

**Files:**
- Modify: `src/utils/config.ts` (recognise + validate `corroboration_threshold`, add default)
- Modify: `src/distill/cli.ts` (`reviewRun` signature + gate; flag parsing; usage)
- Test: `test/utils/config*.test.ts` (or wherever distill-config validation is tested), `test/distill/review.test.ts`

`--auto-safe` on `distill --review <run>` ratifies only staged claims whose `proposedDiff.corroboration ≥ T`, leaving the rest queued. `T` comes from `--corroboration-threshold <float>`, defaulting to the `distill.corroboration_threshold` config value, itself defaulting to a conservative `DEFAULT_CORROBORATION_THRESHOLD`. Without `--auto-safe`, `--review` is unchanged (`--yes` ratifies all; dry-run default). `--auto-safe` implies "apply the qualifying subset" (no `--yes` needed), matching R9 step 4.

**Design decisions (locked here; confirm the number with Mihir post-first-run — spec Open Items):**
- `DEFAULT_CORROBORATION_THRESHOLD = 0.8` (conservative: queues more, auto-ratifies less). Tunable via flag + config.
- `corroboration_threshold` is a **float in `[0,1]`** — it needs its own validation branch (the existing distill numeric loop only accepts positive integers).
- `--auto-safe` + `--yes` together: `--yes` is the stronger "ratify all" and wins (ignore the threshold). Emit a stderr note so the intent is explicit.

- [ ] **Step 1: Config — failing test first** (in the distill-config validation test file):

```typescript
it("accepts distill.corroboration_threshold as a [0,1] float", () => {
  // build config yaml with distill.corroboration_threshold: 0.7 → expect ok, value 0.7
});
it("rejects corroboration_threshold outside [0,1]", () => {
  // 1.5 → err; -0.1 → err
});
it("defaults corroboration_threshold when the key is absent", () => {
  // distill block without the key → value === DEFAULT_CORROBORATION_THRESHOLD
});
```
> Mirror the existing distill-config test's construction helpers exactly.

- [ ] **Step 2: Implement config changes in `src/utils/config.ts`.**

- Add to `DistillConfig` (L187): `corroborationThreshold: number;`
- Add to `DISTILL_NUMERIC_DEFAULTS` (L203) or a sibling default constant:
  ```typescript
  export const DEFAULT_CORROBORATION_THRESHOLD = 0.8;
  ```
  and include `corroborationThreshold: DEFAULT_CORROBORATION_THRESHOLD` in the object spread used to seed `out`.
- Add `"corroboration_threshold"` to `RECOGNISED_DISTILL_KEYS` (L782).
- In `validateDistill` (after the integer loop, ~L821), add a float branch:
  ```typescript
  const ct = obj.corroboration_threshold;
  if (ct !== undefined) {
    if (typeof ct !== "number" || !Number.isFinite(ct) || ct < 0 || ct > 1) {
      return err(new Error("'distill.corroboration_threshold' must be a number in [0, 1]"));
    }
    out.corroborationThreshold = ct;
  }
  ```

- [ ] **Step 3: Run config tests.**

Run: `npx vitest run test/ -t "corroboration_threshold"`
Expected: PASS.

- [ ] **Step 4: Review-gate — failing test first** (`test/distill/review.test.ts`).

Stage two proposals in one run via `proposeAllClaims` with hinters of known score — one at `0.9` (corroborated), one at `0.1` (novel) — then:
```typescript
it("--auto-safe ratifies only corroboration ≥ threshold, leaves the rest queued", async () => {
  // stage run R with claim-hi (corroboration 0.9) and claim-lo (0.1)
  const out = await capture(() =>
    runDistill(["--vault", vault, "--review", runId, "--auto-safe",
      "--corroboration-threshold", "0.8"]),
  );
  expect(out.code).toBe(0);
  const pending = await listStagedActions(vault, "pending");
  const stillPending = pending.value.filter((a) => a.runId === runId).map((a) => a.targetPath);
  expect(stillPending).toContain(loPath);   // novel stays queued
  expect(stillPending).not.toContain(hiPath); // corroborated ratified & gone
});

it("--review --yes still ratifies all regardless of corroboration", async () => {
  // stage same run; --review runId --yes → both gone from pending
});
```

- [ ] **Step 5: Implement the gate in `cli.ts`.**

(a) Add a `parseCorroboration` helper next to `parseDistillRef` (~L569):
```typescript
function parseCorroboration(proposedDiff: unknown): number {
  if (typeof proposedDiff !== "object" || proposedDiff === null) return 0;
  const c = (proposedDiff as Record<string, unknown>).corroboration;
  return typeof c === "number" && Number.isFinite(c) ? c : 0;
}
```

(b) In `runDistill`, in the `--review` branch (L217-231): read `--auto-safe` and `--corroboration-threshold`, load config for the default, and pass both into `reviewRun`:
```typescript
const autoSafe = argv.includes("--auto-safe");
const ctRes = readString(argv, "--corroboration-threshold");
if (ctRes === MISSING_FLAG_VALUE) {
  process.stderr.write(`daftari distill: --corroboration-threshold requires a value\n\n${DISTILL_USAGE}`);
  return 2;
}
let threshold = DEFAULT_CORROBORATION_THRESHOLD;
const cfgForThreshold = resolveDistillConfig(vaultRoot);
if (cfgForThreshold.ok) threshold = cfgForThreshold.value.corroborationThreshold;
if (ctRes !== undefined) {
  const t = Number.parseFloat(ctRes);
  if (!Number.isFinite(t) || t < 0 || t > 1) {
    process.stderr.write(`daftari distill: --corroboration-threshold must be a number in [0,1]\n\n${DISTILL_USAGE}`);
    return 2;
  }
  threshold = t;
}
const applied = argv.includes("--yes") || autoSafe; // auto-safe implies apply-subset
return await reviewRun(vaultRoot, reviewRes, principal, applied, autoSafe, threshold);
```
Add `"--corroboration-threshold"` to `VALUE_FLAGS` and treat `--auto-safe` as a boolean flag in the positional skip list (L304-311).

(c) Extend `reviewRun` (L596) with `autoSafe: boolean, threshold: number` and gate the matched set:
```typescript
async function reviewRun(
  vaultRoot: string,
  runId: string,
  principal: string,
  applied: boolean,
  autoSafe = false,
  threshold = DEFAULT_CORROBORATION_THRESHOLD,
): Promise<number> {
  // …existing list + run_id filter → `matched`…

  // R8: when --auto-safe (and not the stronger --yes), ratify only the
  // corroborated subset; the remainder stays queued for a human.
  const yesAll = applied && !autoSafe; // plain --yes path ratifies everything
  const toRatify =
    autoSafe && !yesAll
      ? matched.filter((a) => parseCorroboration(a.proposedDiff) >= threshold)
      : matched;

  // dry-run listing uses `matched`; the ratify loop iterates `toRatify`.
  // print a "queued (below threshold): N" line for matched.length - toRatify.length
  // …
}
```
Iterate `toRatify` in the ratify loop; keep the dry-run branch keyed on `!applied`. Emit counts: `approved`, `queued (below threshold)`, `failed`. If `--yes` and `--auto-safe` are both present, write a stderr note that `--yes` wins.

(d) Document `--auto-safe` and `--corroboration-threshold <T>` in `DISTILL_USAGE`. Import `DEFAULT_CORROBORATION_THRESHOLD` from config.

- [ ] **Step 6: Run to verify pass.**

Run: `npx vitest run test/distill/review.test.ts test/distill/cli.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint + commit.**

```bash
npx biome check --write src/utils/config.ts src/distill/cli.ts test/
git add src/utils/config.ts src/distill/cli.ts test/distill/review.test.ts
git commit -m "feat(distill): --auto-safe corroboration gate + corroboration_threshold config (R8, R12)"
```

---

## Task 6: End-to-end integration test (R9)

**Files:**
- Create: `test/distill/session-e2e.test.ts`

Exercise the full R9 five-step flow on a temp vault with a stubbed LLM extraction (mock `extractClaims` or drive `proposeAllClaims` + `runDistill --review` directly, following `review.test.ts`'s pattern). The value here is the **gate wiring**, not the LLM.

- [ ] **Step 1: Write the e2e test.**

Fixture: a small `session.jsonl` with one user turn and two assistant turns (one that will corroborate an existing vault belief, one novel). Seed the temp vault (via `makeTempVault`) with a doc the "corroborated" assistant claim overlaps. Then:
1. `distill session.jsonl --source-type claude-session --sender user --source-id s-user --propose`
2. `distill session.jsonl --source-type claude-session --sender assistant --source-id s-assistant --propose`
3. `distill --review <user-run> --yes`
4. `distill --review <asst-run> --auto-safe --corroboration-threshold 0.8`

Assert:
- all user-pass claims landed (`--yes`);
- the corroborated assistant claim landed (corroboration ≥ 0.8);
- the novel assistant claim is **still pending** after step 4;
- teardown is clean (`cleanupVault`).

> Getting distinct run-ids: capture each `--propose` run's `run-id:` from stdout (the summary prints it at cli.ts L518), or stage via `proposeAllClaims` with explicit run-ids as `review.test.ts` does. Prefer the latter for determinism if the real LLM path is awkward to stub in-process.

- [ ] **Step 2: Run to verify it fails, then passes as the wiring lands.**

Run: `npx vitest run test/distill/session-e2e.test.ts`
Expected: PASS once T1–T5 are in.

- [ ] **Step 3: Full suite — this touches the shared carrier + config + CLI.**

Run: `npm test`
Expected: PASS (LESSON from a28: any core-frontmatter/serializer/config change → run the FULL suite, not just the unit dir).

- [ ] **Step 4: Commit.**

```bash
git add test/distill/session-e2e.test.ts
git commit -m "test(distill): end-to-end sender-partitioned + corroboration-gate flow (R9)"
```

---

## Task 7: Wire the sleep job (R9, R10) — mavaali install, NOT this repo

**Files:**
- Modify: `~/scripts/mavaali-sleep.sh` (mavaali install)

**Prerequisites (in order):**
1. Merge the feature branch (daftari `main` is CI-gated: self-merge once e2e / regression / build-20 / build-22 are green).
2. Rebuild + install the CLI globally: `cd /Users/mihirwagle/projects/daftari && npm run build && npm i -g .` (or the repo's documented install path). Verify: `daftari distill --help` shows `--source-type`, `--sender`, `--auto-safe`.

**Then** replace the hand-rolled extraction block in `mavaali-sleep.sh` with the R9 flow, per selected session (R10):

- [ ] **Step 1: Session selection (R10).** Enumerate **today's** interactive `*.jsonl` under `~/.claude/projects/-Users-mihirwagle-projects-claude-home-base-workspace/`, **excluding** scheduled-job sessions (sleep/judge/reflect/search-index/trust-battery/linear-sync/diary-digest). Those carry no new human knowledge. (Distinguish interactive from scheduled by the session's originating program/prompt — inspect a sample to pick a reliable discriminator; if none exists in-file, maintain an exclude-list of the known scheduled session ids.)

- [ ] **Step 2: Per session, run the four distill commands** (R9), capturing run-ids:
```bash
daftari distill "$s" --source-type claude-session --sender user \
  --source-id "${base}-user" --propose
daftari distill "$s" --source-type claude-session --sender assistant \
  --source-id "${base}-assistant" --propose
daftari distill --review "$USER_RUN" --yes
daftari distill --review "$ASST_RUN" --auto-safe --corroboration-threshold "$T"
```
Parse `run-id:` from each `--propose` summary to feed the matching `--review`.

- [ ] **Step 3: DM Mihir the roll-up** (R9 step 5): auto-ratified count, queued count, and the exact `daftari distill --review <asst-run>` command to clear the remainder. Use the launchd Slack-DM pattern (resolve `SLACK_BOT_TOKEN` via `op run`, per memory `launchd-slack-dm-token-pattern`) — do **not** call `bot.py --send` bare.

- [ ] **Step 4: Idempotency note (R11).** Nothing to build — inherited. The two source-ids (`-user`/`-assistant`) keep the passes independent; a re-distill of a grown session re-stages only new chunks via `content_hash` + claim-key upsert.

- [ ] **Step 5: Verify with a dry manual run** on one real session before letting launchd fire. Confirm claims land in `mavaali-vault`, the queued remainder is non-empty and reviewable, and the DM arrives. Update the bead + close.

> This task is shell wiring + manual verification, not TDD. Do not merge it into the daftari repo — it lives in the mavaali install. Keep the interim hand-rolled path until Step 5 passes, then remove it.

---

## Non-goals — asserted by omission (R13–R15)

No `extract.ts` per-claim multi-source provenance (R13), no image/attachment ingestion (R14), no auto-clearing of the human review queue (R15). If a task tempts you toward any of these, stop — they are explicitly deferred.

---

## Plan Review Loop

After this plan is written, dispatch a single `plan-document-reviewer` subagent with: this plan's path + the spec path (`docs/superpowers/specs/2026-08-14-distill-claude-session-adapter-design.md`). Fix issues, re-dispatch for the whole plan, ≤3 iterations before surfacing to Mihir.
