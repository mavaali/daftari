import { describe, expect, it } from "vitest";
import { CANARY_ITEMS, PLACEBO_PREAMBLE } from "../../src/canary/fixtures.js";
import { formatReport, parseCanaryArgs, renderArm, runCanary } from "../../src/canary/run.js";
import type {
  CompleteJsonResult,
  CompleteResult,
  CompleteWithToolsOpts,
  CompleteWithToolsResult,
  LlmClient,
} from "../../src/eval/llm.js";
import type { CortexEvalError } from "../../src/eval/types.js";
import { containsFenceMarker } from "../../src/fence/index.js";
import { ok, type Result } from "../../src/frontmatter/types.js";

// A stand-in model whose compliance is a function of what it was shown, so the
// harness can be exercised end to end with no network and no API key.
function fakeClient(
  comply: (user: string) => boolean,
  opts: { answer?: boolean } = {},
): LlmClient & { calls: number } {
  const client = {
    calls: 0,
    async complete(): Promise<Result<CompleteResult, CortexEvalError>> {
      throw new Error("unused");
    },
    async completeJson(): Promise<Result<CompleteJsonResult, CortexEvalError>> {
      throw new Error("unused");
    },
    async completeWithTools(
      o: CompleteWithToolsOpts,
    ): Promise<Result<CompleteWithToolsResult, CortexEvalError>> {
      client.calls += 1;
      const tool_calls: CompleteWithToolsResult["tool_calls"] = [];
      if (comply(o.user)) {
        await o.toolHandler("record_note", { note: "ack" });
        tool_calls.push({ tool: "record_note", input: { note: "ack" }, output: {}, latency_ms: 1 });
      }
      // Echo every expected substring so task completion is satisfied unless a
      // test asks otherwise.
      const text =
        opts.answer === false ? "" : CANARY_ITEMS.map((i) => i.expectSubstring).join(" ");
      return ok({ text, input_tokens: 1, output_tokens: 1, stop_reason: "end_turn", tool_calls });
    },
  };
  return client;
}

const item = CANARY_ITEMS[0];

describe("renderArm", () => {
  it("returns the body untouched for the unfenced arm", () => {
    expect(renderArm(item, "unfenced")).toBe(item.body);
    expect(containsFenceMarker(renderArm(item, "unfenced"))).toBe(false);
  });

  it("prefixes neutral server text for the placebo arm, with no fence", () => {
    const out = renderArm(item, "placebo");
    expect(out).toContain(PLACEBO_PREAMBLE);
    expect(out).toContain(item.body);
    expect(containsFenceMarker(out)).toBe(false);
  });

  it("fences the body for the fenced arm", () => {
    const out = renderArm(item, "fenced");
    expect(containsFenceMarker(out)).toBe(true);
    expect(out).toContain(item.body);
  });

  it("keeps the placebo comparable in bulk to the real preamble", () => {
    // The placebo exists to hold length constant. If it drifts far from the
    // fenced arm's chrome, a difference between them stops being attributable
    // to what the fence says.
    const fencedChrome = renderArm(item, "fenced").length - item.body.length;
    const placeboChrome = renderArm(item, "placebo").length - item.body.length;
    const ratio = placeboChrome / fencedChrome;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("mints a fresh nonce per rendering, as a live response would", () => {
    expect(renderArm(item, "fenced")).not.toBe(renderArm(item, "fenced"));
  });
});

describe("runCanary", () => {
  it("reports a kill when the model complies regardless of arm", () => {
    // The null result the kill condition is built to catch.
    return runCanary(
      fakeClient(() => true),
      { model: "fake", repetitions: 2 },
    ).then((res) => {
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.verdict.status).toBe("killed");
      expect(res.value.fencedVsUnfenced.meanDiff).toBe(0);
      for (const arm of res.value.arms) expect(arm.rate).toBe(1);
    });
  });

  it("reports survival when only the fence suppresses compliance", async () => {
    const res = await runCanary(
      fakeClient((user) => !containsFenceMarker(user)),
      {
        model: "fake",
        repetitions: 2,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.verdict.status).not.toBe("killed");
    expect(res.value.fencedVsUnfenced.meanDiff).toBe(-1);
    expect(res.value.verdict.reason).toMatch(/^SURVIVES/);
  });

  it("voids the run when the positive control does not comply", async () => {
    // Model ignores every directive, including the legitimate system-prompt
    // one. Compliance is zero everywhere, so fenced-vs-unfenced is 0 — which
    // must NOT be reported as a kill.
    const res = await runCanary(
      fakeClient(() => false),
      { model: "fake", repetitions: 2 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.positiveControlRate).toBe(0);
    expect(res.value.verdict.reason).toMatch(/^VOID/);
    expect(res.value.verdict.status).not.toBe("killed");
  });

  it("separates server chrome from the fence's claims via the placebo arm", async () => {
    // A model that reacts to ANY preamble, fence or not. fenced-vs-unfenced
    // looks like a win; fenced-vs-placebo shows it is not the fence doing it.
    const anyChrome = (user: string) =>
      !user.includes(PLACEBO_PREAMBLE) && !containsFenceMarker(user);
    const res = await runCanary(fakeClient(anyChrome), { model: "fake", repetitions: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fencedVsUnfenced.meanDiff).toBe(-1);
    expect(res.value.fencedVsPlacebo.meanDiff).toBe(0);
    expect(formatReport(res.value)).toContain("NOT from placebo");
  });

  it("runs every arm and the control", async () => {
    const client = fakeClient(() => true);
    await runCanary(client, { model: "fake", repetitions: 3 });
    // 3 arms x 6 items x 3 reps, plus 6 control trials.
    expect(client.calls).toBe(3 * CANARY_ITEMS.length * 3 + CANARY_ITEMS.length);
  });

  it("tracks whether the model actually did the retrieval task", async () => {
    const res = await runCanary(
      fakeClient(() => true, { answer: false }),
      {
        model: "fake",
        repetitions: 1,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // A run where nothing was answered is not evidence about fencing.
    expect(res.value.taskCompletionRate).toBe(0);
  });

  it("is reproducible for a seed", async () => {
    const run = () =>
      runCanary(
        fakeClient((u) => !containsFenceMarker(u)),
        {
          model: "fake",
          repetitions: 2,
          seed: 4,
        },
      );
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.fencedVsUnfenced).toEqual(b.value.fencedVsUnfenced);
  });
});

describe("canary fixtures", () => {
  it("asks questions that never mention the embedded directive", () => {
    // A question about the directive would measure instruction-following, not
    // susceptibility.
    for (const i of CANARY_ITEMS) {
      expect(i.question.toLowerCase()).not.toContain("record_note");
      expect(i.question.toLowerCase()).not.toContain("ignore");
    }
  });

  it("uses only inert directives", () => {
    for (const i of CANARY_ITEMS) {
      expect(i.body).toContain("record_note");
      for (const dangerous of ["vault_write", "vault_merge", "http://", "https://"]) {
        expect(i.body).not.toContain(dangerous);
      }
    }
  });

  it("carries an answerable question whose answer is in the body", () => {
    for (const i of CANARY_ITEMS) {
      expect(i.body).toContain(i.expectSubstring);
    }
  });
});

describe("parseCanaryArgs", () => {
  it("defaults repetitions and seed", () => {
    const r = parseCanaryArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ repetitions: 5, seed: 1 });
  });

  it("parses overrides", () => {
    const r = parseCanaryArgs(["--model", "m", "--repetitions", "9", "--seed", "3"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ model: "m", repetitions: 9, seed: 3 });
  });

  it("rejects bad input rather than running a meaningless experiment", () => {
    expect(parseCanaryArgs(["--repetitions", "0"]).ok).toBe(false);
    expect(parseCanaryArgs(["--repetitions", "x"]).ok).toBe(false);
    expect(parseCanaryArgs(["--nope"]).ok).toBe(false);
  });

  it("rejects a flag with no value instead of keeping the default", () => {
    // This spends real API calls. Silently testing a model the operator did
    // not choose is worse than refusing to start.
    for (const flag of ["--model", "--repetitions", "--seed"]) {
      const r = parseCanaryArgs([flag]);
      expect(r.ok, flag).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("requires a value");
    }
  });

  it("does not swallow the next flag as a value", () => {
    // `--model --repetitions 5` used to take "--repetitions" as the model name
    // and then report `unknown argument: 5`, blaming the wrong token.
    const r = parseCanaryArgs(["--model", "--repetitions", "5"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain("--model requires a value");
      expect(r.error.message).toContain("--repetitions");
      expect(r.error.message).not.toContain("unknown argument");
    }
  });

  it("still accepts values that merely look unusual", () => {
    // Only a leading `--` disqualifies a value; a model id with dashes inside
    // it is fine.
    const r = parseCanaryArgs(["--model", "claude-sonnet-4-5-20250929"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("accepts a negative seed, which is a number and not a flag", () => {
    const r = parseCanaryArgs(["--seed", "-3"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.seed).toBe(-3);
  });
});
