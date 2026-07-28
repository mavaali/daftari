import { describe, expect, it } from "vitest";
import {
  allRegisteredTools,
  CORE_TOOLS,
  formatSuccessResult,
  registeredToolNames,
  resolveToolExposure,
  STANDARD_TOOLS,
} from "../src/server.js";
import type { ToolDefinition } from "../src/tools/read.js";
import type { ToolsConfig } from "../src/utils/config.js";
import { compileToolSchema } from "./helpers/output-schema.js";

function exposure(overrides: Partial<ToolsConfig>): ReturnType<typeof resolveToolExposure> {
  return resolveToolExposure({ tier: "full", include: [], exclude: [], ...overrides });
}

describe("tool exposure tiers (#103/#104)", () => {
  it("every tier-listed tool is a registered tool — no stale names survive a rename", () => {
    const registered = new Set(registeredToolNames());
    for (const name of STANDARD_TOOLS) {
      expect(registered.has(name), `${name} is tier-listed but not registered`).toBe(true);
    }
  });

  it("tiers nest: core ⊂ standard ⊂ full", () => {
    const standard = new Set(STANDARD_TOOLS);
    for (const name of CORE_TOOLS) expect(standard.has(name)).toBe(true);
    expect(CORE_TOOLS.length).toBeLessThan(STANDARD_TOOLS.length);
    expect(STANDARD_TOOLS.length).toBeLessThan(registeredToolNames().length);
  });

  it("full exposes the whole registry, including tools added after the tier lists", () => {
    const { exposed, unknown } = exposure({ tier: "full" });
    expect([...exposed].sort()).toEqual([...registeredToolNames()].sort());
    expect(unknown).toEqual([]);
  });

  it("core exposes exactly the search-before-derive loop", () => {
    const { exposed } = exposure({ tier: "core" });
    expect([...exposed].sort()).toEqual([...CORE_TOOLS].sort());
  });

  it("standard exposes the document lifecycle on top of core", () => {
    const { exposed } = exposure({ tier: "standard" });
    expect([...exposed].sort()).toEqual([...STANDARD_TOOLS].sort());
    expect(exposed.has("vault_tension_log")).toBe(false);
    expect(exposed.has("vault_themes")).toBe(false);
  });

  it("include adds beyond the tier and exclude removes from it — exclude wins (#104)", () => {
    const { exposed } = exposure({
      tier: "core",
      include: ["vault_tension_log"],
      exclude: ["vault_status", "vault_tension_log"],
    });
    expect(exposed.has("vault_tension_log")).toBe(false); // included, then excluded
    expect(exposed.has("vault_status")).toBe(false); // excluded from core
    expect(exposed.has("vault_search")).toBe(true); // untouched core member
  });

  it("unknown names in include/exclude are reported once each, never fatal", () => {
    const { exposed, unknown } = exposure({
      tier: "core",
      // vault_future_tool appears in BOTH lists — one warning, not two.
      include: ["vault_future_tool"],
      exclude: ["vault_also_future", "vault_future_tool"],
    });
    expect(unknown.sort()).toEqual(["vault_also_future", "vault_future_tool"]);
    expect(exposed.size).toBe(CORE_TOOLS.length);
  });
});

// spec 2026-07-26, Decision 3 / jugalbandi challenge C6: every registered
// tool's outputSchema must compile under STRICT JSON Schema 2020-12 — a
// misspelled keyword must fail this test, not silently validate everything.
describe("outputSchema — registry-wide strict compile (Decision 3, C6)", () => {
  it("every registered tool's outputSchema compiles under strict 2020-12", () => {
    for (const tool of allRegisteredTools()) {
      expect(
        () => compileToolSchema(tool),
        `${tool.name}'s outputSchema failed strict compilation`,
      ).not.toThrow();
    }
  });

  it("outputSchema is present on every registered tool (Decision 3: required, not optional)", () => {
    for (const tool of allRegisteredTools()) {
      expect(tool.outputSchema, `${tool.name} has no outputSchema`).toBeTruthy();
    }
  });
});

// spec 2026-07-26, Decision 3, PR 1 gap closure. formatSuccessResult is the
// CallTool bridge's presentation step, extracted so it can be driven
// directly against hand-built stub tools — including ones a real registered
// tool can never be (no summarize; a throwing summarize) — without a live
// Server/transport.
describe("formatSuccessResult — CallTool bridge presentation (Decision 3, C5)", () => {
  const stubTool = (overrides: Partial<ToolDefinition>): ToolDefinition => ({
    name: "stub_tool",
    description: "test stub",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    handler: async () => ({ ok: true, value: { n: 1 } }),
    ...overrides,
  });

  it("a tool with no summarize falls back to pretty-printed JSON (back-compat pin)", () => {
    const tool = stubTool({});
    const value = { n: 1, label: "x" };
    const out = formatSuccessResult(tool, value);
    expect(out.content[0]).toEqual({ type: "text", text: JSON.stringify(value, null, 2) });
    expect(out.structuredContent).toBe(value);
  });

  it("a tool with summarize ships the summary text instead of JSON", () => {
    const tool = stubTool({ summarize: (v) => `summary of ${(v as { n: number }).n}` });
    const out = formatSuccessResult(tool, { n: 42 });
    expect(out.content[0]).toEqual({ type: "text", text: "summary of 42" });
  });

  it("a throwing summarize still returns the JSON fallback, never an error", () => {
    const tool = stubTool({
      summarize: () => {
        throw new Error("boom");
      },
    });
    const value = { n: 7 };
    const out = formatSuccessResult(tool, value);
    expect(out.content[0]).toEqual({ type: "text", text: JSON.stringify(value, null, 2) });
    // formatSuccessResult never sets isError — the caller (CallTool handler)
    // decides that, and a presentation failure must never make it decide
    // "error" over a successful handler result.
    expect((out as { isError?: boolean }).isError).toBeUndefined();
  });

  it("a throwing docLinks still returns the summary, with no resource_link entries", () => {
    const tool = stubTool({
      summarize: () => "ok",
      docLinks: () => {
        throw new Error("boom");
      },
    });
    const out = formatSuccessResult(tool, { n: 1 });
    expect(out.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("docLinks round-trip through docUri as resource_link entries", () => {
    const tool = stubTool({
      summarize: () => "ok",
      docLinks: () => ["a/b.md", "c.md"],
    });
    const out = formatSuccessResult(tool, { n: 1 });
    const links = out.content.slice(1);
    expect(links).toEqual([
      {
        type: "resource_link",
        uri: "daftari://doc/a/b.md",
        name: "a/b.md",
        mimeType: "text/markdown",
      },
      { type: "resource_link", uri: "daftari://doc/c.md", name: "c.md", mimeType: "text/markdown" },
    ]);
  });

  it("docLinks entries are filtered to non-empty strings before becoming links", () => {
    const tool = stubTool({
      summarize: () => "ok",
      // biome-ignore lint/suspicious/noExplicitAny: exercising a malformed docLinks return
      docLinks: () => ["", "real.md", null as any, undefined as any],
    });
    const out = formatSuccessResult(tool, { n: 1 });
    expect(out.content).toHaveLength(2); // text + one real link
    expect(out.content[1]).toMatchObject({ uri: "daftari://doc/real.md" });
  });

  it("wireValue projects structuredContent while summarize/docLinks still see the full value", () => {
    const seenBySummarize: unknown[] = [];
    const tool = stubTool({
      summarize: (v) => {
        seenBySummarize.push(v);
        return "ok";
      },
      wireValue: (v) => {
        const { secret: _secret, ...rest } = v as { secret: string; n: number };
        return rest;
      },
    });
    const value = { n: 1, secret: "full-value" };
    const out = formatSuccessResult(tool, value);
    expect(out.structuredContent).toEqual({ n: 1 });
    expect(seenBySummarize).toEqual([value]);
  });

  it("no wireValue ships the value verbatim on structuredContent", () => {
    const tool = stubTool({ summarize: () => "ok" });
    const value = { n: 1 };
    const out = formatSuccessResult(tool, value);
    expect(out.structuredContent).toBe(value);
  });
});

// vault_read (C11): the body ships exactly once, on the `content` channel —
// never doubled onto structuredContent.
describe("vault_read wire projection (Decision 3, C11)", () => {
  it("structuredContent carries no `content` field, while content[0].text carries it verbatim", () => {
    const tool = allRegisteredTools().find((t) => t.name === "vault_read");
    expect(tool).toBeTruthy();
    const value = {
      path: "a.md",
      content: "the body text",
      frontmatter: { title: "t", status: "draft", confidence: "low", collection: "c" },
      raw: {},
      validation: { valid: true, issues: [] },
      hasFrontmatter: true,
      decay: null,
      validity: null,
      upstream_staleness: null,
      structural: null,
      version: "deadbeef",
    };
    const out = formatSuccessResult(tool as ToolDefinition, value);
    expect(out.structuredContent).not.toHaveProperty("content");
    expect(out.structuredContent).toMatchObject({ path: "a.md", version: "deadbeef" });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain("the body text");
  });
});
