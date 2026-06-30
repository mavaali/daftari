# Corpus (B) Arm B — LLM-synth foil + blind judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Arm B (LLM-synth, Haiku) consolidator and a blind cross-family judge (Gemini Flash), then run the A/B/C comparison over the 33 scorable stale-trap instances + a no-mint probe.

**Architecture:** An `LlmClient` seam wraps OpenRouter so unit tests inject a stub and only the one paid run script hits the network. Pure functions build the Arm B and judge prompts, parse the judge verdict, and classify Arm B's free-text answer to {governing | stale | abstain | other} (other = fabrication). Arm B sees only the two passage versions Arm A sees (no box, no revert). The judge sees the answer + the two reference texts as randomized unlabeled candidates.

**Tech Stack:** TypeScript, vitest, OpenRouter (`OPENROUTER_API_KEY`), the CO2 modules (`consensus-content`, `consensus-passage`).

**Spec:** `docs/superpowers/specs/2026-06-28-corpus-b-arm-b-llm-synth-design.md`

**Verified at plan time:** OpenRouter `POST /api/v1/chat/completions` works with `{model,temperature,max_tokens,messages}` → `.choices[0].message.content`. Slugs: Arm B `anthropic/claude-haiku-4.5`; judge `google/gemini-2.5-flash`.

**Out of scope:** pre-cutoff perturbation; CB4 acquired-edge arm; fuller Arm C localization.

---

## File Structure

- Create `integrations/consensus-bench/src/consensus-llm.ts` — `LlmClient` interface + `openRouterClient(apiKey, fetchImpl?)`.
- Create `integrations/consensus-bench/src/consensus-arm-b.ts` — `buildArmBPrompt`, `isRefusal`, `armB`, `classifyNoMint`.
- Create `integrations/consensus-bench/src/consensus-judge.ts` — `buildJudgePrompt`, `parseJudge`, `classifyArmB`.
- Create `integrations/consensus-bench/src/__fixtures__/armb-nomint-probes.json` — hand-authored absent-topic probes.
- Throwaway (added in Task 4, run once, deleted, NOT committed): `src/_armb-run.test.ts` — orchestrates the paid run via the real client.
- Committed run output: `docs/superpowers/results/2026-06-28-corpus-b-arm-b.md` (+ optional `__fixtures__/armb-results.json`).

No classes; functions + types. No network in the test suite.

---

## Task 1: LLM client seam

**Files:**
- Create: `integrations/consensus-bench/src/consensus-llm.ts`
- Test: `integrations/consensus-bench/src/consensus-llm.test.ts`

- [ ] **Step 1: Write the failing test** (inject a fake `fetch`, assert request shape + parsed content)

```typescript
import { describe, expect, test } from "vitest";
import { openRouterClient } from "./consensus-llm.js";

describe("openRouterClient", () => {
  test("posts an OpenRouter chat request and returns the message content", async () => {
    let captured: any = null;
    const fakeFetch = async (url: any, init: any) => {
      captured = { url, init };
      return { json: async () => ({ choices: [{ message: { content: "hello" } }] }) } as any;
    };
    const client = openRouterClient("KEY", fakeFetch as any);
    const out = await client.complete({ model: "m", user: "hi" });
    expect(out).toBe("hello");
    expect(captured.url).toContain("openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(captured.init.body);
    expect(body).toMatchObject({ model: "m", temperature: 0 });
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(captured.init.headers.Authorization).toBe("Bearer KEY");
  });

  test("returns empty string when the response has no content", async () => {
    const fakeFetch = async () => ({ json: async () => ({}) }) as any;
    const client = openRouterClient("KEY", fakeFetch as any);
    expect(await client.complete({ model: "m", user: "x" })).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-llm.test.ts`
Expected: FAIL — module not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-llm — minimal OpenRouter chat seam. The bench calls OpenRouter
// directly (the daftari client is Anthropic-only). fetchImpl is injectable so
// unit tests stay offline; the real run passes the global fetch.
export interface LlmClient {
  complete(opts: { model: string; system?: string; user: string }): Promise<string>;
}

export function openRouterClient(apiKey: string, fetchImpl: typeof fetch = fetch): LlmClient {
  return {
    async complete({ model, system, user }) {
      const messages = system
        ? [{ role: "system", content: system }, { role: "user", content: user }]
        : [{ role: "user", content: user }];
      const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 1024, messages }),
      });
      const json: any = await res.json();
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes** — `npx vitest run integrations/consensus-bench/src/consensus-llm.test.ts` → PASS (2).

- [ ] **Step 5: Commit**

```bash
git add integrations/consensus-bench/src/consensus-llm.ts integrations/consensus-bench/src/consensus-llm.test.ts
git commit -m "feat(consensus-bench): OpenRouter LLM client seam (injectable fetch)"
```

---

## Task 2: Arm B (consolidator) + refusal + no-mint classify

**Files:**
- Create: `integrations/consensus-bench/src/consensus-arm-b.ts`
- Test: `integrations/consensus-bench/src/consensus-arm-b.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "vitest";
import { buildArmBPrompt, isRefusal, armB, classifyNoMint, buildNoMintPrompt } from "./consensus-arm-b.js";
import type { LlmClient } from "./consensus-llm.js";

const stub = (reply: string): LlmClient => ({ complete: async () => reply });

describe("buildArmBPrompt", () => {
  test("shows both versions chronologically and offers CANNOT DETERMINE", () => {
    const p = buildArmBPrompt({ governingText: "OLD", staleText: "NEW" });
    expect(p).toContain("OLD");
    expect(p).toContain("NEW");
    expect(p.indexOf("OLD")).toBeLessThan(p.indexOf("NEW")); // older first
    expect(p).toContain("CANNOT DETERMINE");
  });
});

describe("isRefusal", () => {
  test("detects the cannot-determine refusal", () => {
    expect(isRefusal("CANNOT DETERMINE")).toBe(true);
    expect(isRefusal("  cannot determine.  ")).toBe(true);
    expect(isRefusal("The current consensus is X.")).toBe(false);
  });
});

describe("armB", () => {
  test("sends the prompt and returns the model's answer", async () => {
    const out = await armB(stub("answer text"), { governingText: "OLD", staleText: "NEW" });
    expect(out).toBe("answer text");
  });
});

describe("classifyNoMint", () => {
  test("refusal => abstain (correct), assertion => fabricate", () => {
    expect(classifyNoMint("CANNOT DETERMINE")).toBe("abstain");
    expect(classifyNoMint("The consensus is to use the 2017 portrait.")).toBe("fabricate");
  });
});

describe("buildNoMintPrompt", () => {
  test("includes the context + absent-topic question + CANNOT DETERMINE, answer-from-passage-only", () => {
    const p = buildNoMintPrompt("CTX", "What is the consensus on Y?");
    expect(p).toContain("CTX");
    expect(p).toContain("What is the consensus on Y?");
    expect(p).toContain("CANNOT DETERMINE");
    expect(p).toMatch(/only/i);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module not defined).

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-arm-b — the LLM-synth foil. Sees only the two passage versions Arm A
// sees (governing older, stale newer), no box/revert, and is asked the current
// consensus with a charitable CANNOT DETERMINE option.
import type { LlmClient } from "./consensus-llm.js";

const MODEL = "anthropic/claude-haiku-4.5";

export interface TwoVersions {
  governingText: string;
  staleText: string;
}

export function buildArmBPrompt(v: TwoVersions): string {
  return [
    "Below are two recent versions of one passage from a collaboratively edited",
    "encyclopedia article, oldest first.",
    "",
    `Version 1 (older): ${v.governingText}`,
    `Version 2 (newer): ${v.staleText}`,
    "",
    "What is the current consensus version of this passage? Reply with ONLY the",
    "exact text of the current consensus version, or exactly 'CANNOT DETERMINE'",
    "if you cannot tell from the information given.",
  ].join("\n");
}

export function isRefusal(answer: string): boolean {
  return /cannot\s+determine/i.test(answer);
}

export async function armB(client: LlmClient, v: TwoVersions): Promise<string> {
  return client.complete({ model: MODEL, user: buildArmBPrompt(v) });
}

// no-mint probe: a passage `context` + a question about a topic NOT in it. Correct
// answer = CANNOT DETERMINE; asserting a value = fabricating from priors.
export function buildNoMintPrompt(context: string, question: string): string {
  return [
    "Below is a passage from a collaboratively edited encyclopedia article.",
    "",
    context,
    "",
    question,
    "Answer based ONLY on the passage above. Reply with the answer, or exactly",
    "'CANNOT DETERMINE' if the passage does not establish it.",
  ].join("\n");
}

// no-mint probe scoring: refusing is correct (no-mint); asserting any value is a
// fabrication.
export function classifyNoMint(answer: string): "abstain" | "fabricate" {
  return isRefusal(answer) ? "abstain" : "fabricate";
}
```

- [ ] **Step 4: Run** → PASS (6).

- [ ] **Step 5: Commit**

```bash
git add integrations/consensus-bench/src/consensus-arm-b.ts integrations/consensus-bench/src/consensus-arm-b.test.ts
git commit -m "feat(consensus-bench): Arm B LLM-synth consolidator + refusal + no-mint classify"
```

---

## Task 3: Blind judge + classification

**Files:**
- Create: `integrations/consensus-bench/src/consensus-judge.ts`
- Test: `integrations/consensus-bench/src/consensus-judge.test.ts`

The judge maps a free-text answer to one of two randomized, unlabeled candidate
texts (or neither). `classifyArmB` combines the refusal check, the judge verdict,
and the known governing position into {governing | stale | abstain | other}.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "vitest";
import { buildJudgePrompt, parseJudge, classifyArmB } from "./consensus-judge.js";

describe("buildJudgePrompt", () => {
  test("includes the answer and both candidates as Option 1 / Option 2", () => {
    const p = buildJudgePrompt("ANS", "CANDA", "CANDB");
    expect(p).toContain("ANS");
    expect(p).toContain("Option 1");
    expect(p).toContain("CANDA");
    expect(p).toContain("Option 2");
    expect(p).toContain("CANDB");
    expect(p).toContain("NEITHER");
  });
});

describe("parseJudge", () => {
  test("parses OPTION 1 / OPTION 2 / NEITHER (case/space tolerant)", () => {
    expect(parseJudge("OPTION 1")).toBe("option1");
    expect(parseJudge("the answer is option 2.")).toBe("option2");
    expect(parseJudge("NEITHER")).toBe("neither");
    expect(parseJudge("unclear blah")).toBe("neither"); // ambiguous => neither
  });
});

describe("classifyArmB", () => {
  // governingOption tells which option held the governing text in this trial.
  test("refusal => abstain regardless of verdict", () => {
    expect(classifyArmB("CANNOT DETERMINE", "option1", 1)).toBe("abstain");
  });
  test("verdict on the governing option => governing (both orders)", () => {
    expect(classifyArmB("some text", "option1", 1)).toBe("governing");
    expect(classifyArmB("some text", "option2", 2)).toBe("governing");
  });
  test("verdict on the non-governing option => stale (both orders)", () => {
    expect(classifyArmB("some text", "option2", 1)).toBe("stale");
    expect(classifyArmB("some text", "option1", 2)).toBe("stale");
  });
  test("neither => other (fabrication)", () => {
    expect(classifyArmB("some text", "neither", 1)).toBe("other");
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-judge — blind cross-family judge. Maps Arm B's free-text answer to
// two randomized, unlabeled candidate texts (governing vs stale) or neither. The
// judge never learns which candidate is "correct"; the caller knows the order
// (governingOption) and maps back.
// NB: the spec lists a 'refusal' judge verdict; we deliberately omit it — refusal
// is a property of Arm B's ANSWER ("CANNOT DETERMINE"), checked via isRefusal in
// classifyArmB, so a refusal never reaches the judge.
import { isRefusal } from "./consensus-arm-b.js";

export type JudgeVerdict = "option1" | "option2" | "neither";
export type ArmBClass = "governing" | "stale" | "abstain" | "other";

export function buildJudgePrompt(answer: string, candA: string, candB: string): string {
  return [
    "Compare the Answer to two reference texts and decide which one it expresses",
    "the same content as.",
    "",
    `Answer: ${answer}`,
    "",
    `Option 1: ${candA}`,
    `Option 2: ${candB}`,
    "",
    "Reply with exactly 'OPTION 1', 'OPTION 2', or 'NEITHER'.",
  ].join("\n");
}

export function parseJudge(resp: string): JudgeVerdict {
  if (/option\s*1\b/i.test(resp)) return "option1";
  if (/option\s*2\b/i.test(resp)) return "option2";
  return "neither";
}

export function classifyArmB(answer: string, verdict: JudgeVerdict, governingOption: 1 | 2): ArmBClass {
  if (isRefusal(answer)) return "abstain";
  if (verdict === "neither") return "other";
  const chosen = verdict === "option1" ? 1 : 2;
  return chosen === governingOption ? "governing" : "stale";
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Run full suite + tsc**

Run: `npx vitest run integrations/consensus-bench && (cd integrations/consensus-bench && npx tsc --noEmit)`
Expected: all green, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add integrations/consensus-bench/src/consensus-judge.ts integrations/consensus-bench/src/consensus-judge.test.ts
git commit -m "feat(consensus-bench): blind cross-family judge + Arm B classification"
```

---

## Task 4: No-mint probe fixture + the paid run + results

**Files:**
- Create: `integrations/consensus-bench/src/__fixtures__/armb-nomint-probes.json`
- Throwaway: `src/_armb-run.test.ts` (run once, delete, do NOT commit)
- Create: `docs/superpowers/results/2026-06-28-corpus-b-arm-b.md`

- [ ] **Step 1: Author the no-mint probe fixture**

~6–8 probes: a real governing passage as `context`, paired with a `question` about a
plainly-absent topic. Correct answer = CANNOT DETERMINE. Example shape:

```json
[
  { "context": "<a lead-sentence governing passage>", "question": "Based only on the text above, what is the current consensus on which photograph to use as the infobox image?" },
  { "context": "<a body governing passage>", "question": "Based only on the text above, what is the current consensus on the 'Alma mater' infobox entry?" }
]
```

Pull a few real `governingText` values from `trump-instance-diffs.json` (via a quick
`jq`/inspector) to use as contexts; hand-write absent-topic questions. The Arm B
prompt for a probe is: the `context` + the `question` + the CANNOT DETERMINE option
(reuse a small probe-prompt builder or inline in the runner). Score with
`classifyNoMint` (no judge needed — refuse vs assert).

- [ ] **Step 2: Write the throwaway runner** `src/_armb-run.test.ts`

It imports the real modules + `openRouterClient(process.env.OPENROUTER_API_KEY)`,
loads the box + `trump-instance-diffs.json`, keeps scorable instances
(`parsePassage(...).scorable`), and for each:
- `answer = await armB(client, {governingText, staleText})`
- if `isRefusal(answer)` → `abstain`; else place the candidates by index parity and
  **bind `governingOption` to the slot you actually put `governingText` in** (write
  them together so they can't drift):

  ```javascript
  // governing in Option 1 on even rows, Option 2 on odd rows (deterministic,
  // ~50/50, no Math.random). governingOption MUST match the placement.
  const govFirst = i % 2 === 0;
  const candA = govFirst ? governingText : staleText;
  const candB = govFirst ? staleText : governingText;
  const governingOption = govFirst ? 1 : 2;
  const verdict = parseJudge(await client.complete({ model: JUDGE, user: buildJudgePrompt(answer, candA, candB) }));
  const cls = classifyArmB(answer, verdict, governingOption);
  ```
  (`JUDGE = "google/gemini-2.5-flash"`.)
- aggregate counts {governing, stale, abstain, other}
Then run the no-mint probes (`classifyNoMint`). `writeFileSync` the A/B/C table +
per-row + probe results to the scratchpad. Use `writeFileSync`, not `console.log`.

- [ ] **Step 3: CHECKPOINT — confirm the paid run with Mihir**

This step spends on the OpenRouter key (~45 Haiku + ~45 Gemini-Flash calls, temp 0,
well under $1). Surface the go/no-go before running.

- [ ] **Step 4: Run the paid run**

Run: `npx vitest run integrations/consensus-bench/src/_armb-run.test.ts`
Inspect the scratch output: the A/B/C table (Arm A 33/33 stale, Arm C 16/33
governing/0 stale, Arm B filled), Arm B stale/governing/abstain/other rates, and
no-mint fabricate-rate.

- [ ] **Step 5: Write the results note + commit**

Write `docs/superpowers/results/2026-06-28-corpus-b-arm-b.md` with the A/B/C table
and a straight reading (including the honest-partial outcome if Arm B is neither
stale nor fabricating). Optionally commit `__fixtures__/armb-results.json`. Delete
the throwaway runner.

```bash
git add integrations/consensus-bench/src/__fixtures__/armb-nomint-probes.json docs/superpowers/results/2026-06-28-corpus-b-arm-b.md
git commit -m "docs(results): corpus B Arm B run — A/B/C comparison + no-mint probe"
```

---

## Definition of Done

- `consensus-llm`, `consensus-arm-b`, `consensus-judge` implemented + unit-tested
  (hermetic, stubbed client); full `integrations/consensus-bench` suite green, tsc clean.
- No-mint probe fixture authored; paid run executed (after the checkpoint) over the
  33 scorable stale-traps + probes.
- Results note with the A/B/C table + fabrication rates + cost, stated straight.
- No network/LLM in the committed test suite (the runner is a deleted throwaway).

**Next (separate):** pre-cutoff perturbation; CB4 acquired-edge arm (the publishable
contribution); fuller Arm C localization.
