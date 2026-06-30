import { describe, expect, test } from "vitest";
import { buildContradictionPrompt, parseContradiction, acquireContradiction } from "./consensus-cb5-contradiction.js";
import type { LlmClient } from "./consensus-llm.js";

const stub = (reply: string): LlmClient => ({ complete: async () => reply });

describe("buildContradictionPrompt", () => {
  test("presents both passages and asks a symmetric YES_CONFLICT/NO_CONFLICT question", () => {
    const p = buildContradictionPrompt("TA", "TB");
    expect(p).toContain("TA");
    expect(p).toContain("TB");
    expect(p).toContain("YES_CONFLICT");
    expect(p).toContain("NO_CONFLICT");
  });

  test("never asks for direction (locks the structural no-mint property)", () => {
    const p = buildContradictionPrompt("TA", "TB").toLowerCase();
    expect(p).not.toContain("supersede");
    expect(p).not.toContain("which");
    expect(p).not.toContain("current consensus is");
  });
});

describe("parseContradiction", () => {
  test("parses YES_CONFLICT / NO_CONFLICT (tolerant)", () => {
    expect(parseContradiction("YES_CONFLICT")).toBe("yes");
    expect(parseContradiction("answer: no_conflict — different topics")).toBe("no");
  });

  test("defaults ambiguous/unparseable to no (conservative: no false conflict)", () => {
    expect(parseContradiction("unclear")).toBe("no");
    expect(parseContradiction("")).toBe("no");
  });

  test("prefers an explicit YES when both tokens somehow appear", () => {
    // A reply that names the YES label is treated as a conflict flag.
    expect(parseContradiction("not NO_CONFLICT; this is YES_CONFLICT")).toBe("yes");
  });
});

describe("acquireContradiction", () => {
  test("returns the parsed verdict via the injected client", async () => {
    expect(await acquireContradiction(stub("YES_CONFLICT"), "x", "y")).toBe("yes");
    expect(await acquireContradiction(stub("NO_CONFLICT"), "x", "y")).toBe("no");
  });
});
