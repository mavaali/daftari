import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "../../src/frontmatter/types.js";
import {
  createIntegrationDistill,
  prepareIntegrationDistill,
} from "../../src/integrations/distill.js";

describe("integration distillation", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-distill-"));
  });

  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  it("feeds normalized text through bounded extraction and staged distill upsert", async () => {
    const extract = vi.fn(async () => ({
      claims: [
        {
          claim_key: "anchor:claim-1",
          statement: "The connector stages claims.",
          proposed_frontmatter: { title: "The connector stages claims." },
        },
      ],
      budget_exhausted: false,
      llmCalls: 1,
      chunkErrors: [],
    }));
    const upsert = vi.fn(async () =>
      ok({
        noop: false,
        skipped: [],
        updated: [],
        created: ["anchor:claim-1"],
        propose: null,
        stateWritten: true,
      }),
    );
    const distill = createIntegrationDistill(vault, {
      resolve: () =>
        ok({
          client: {
            complete: vi.fn(),
            completeJson: vi.fn(),
            completeWithTools: vi.fn(),
          },
          config: {
            model: "test-model",
            maxLlmCalls: 2,
            maxClaims: 3,
            maxVerbatimChars: 100,
            inCallInputCap: 64,
            corroborationThreshold: 0.8,
          },
          transport: "anthropic",
        }),
      extract,
      upsert,
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      runNonce: () => "nonce",
    });

    const result = await distill({
      providerSourceId: "google:doc-1",
      revision: "revision-7",
      text: "A".repeat(150),
    });

    expect(result.ok).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]?.[0].length).toBeGreaterThan(1);
    expect(extract.mock.calls[0]?.[0].every((chunk) => chunk.text.length <= 64)).toBe(true);
    expect(extract.mock.calls[0]?.[0].map((chunk) => chunk.messages[0]?.text ?? "").join("")).toBe(
      "A".repeat(150),
    );
    expect(extract.mock.calls[0]?.[2]).toEqual({
      model: "test-model",
      maxClaims: 3,
      inCallInputCap: 64,
    });
    expect(upsert).toHaveBeenCalledWith(
      vault,
      expect.objectContaining({
        sourceId: "google:doc-1",
        sourceContent: "A".repeat(150),
        runId: expect.stringContaining("revision-7"),
      }),
    );
  });

  it("does not advance the source when extraction is partial", async () => {
    const upsert = vi.fn();
    const distill = createIntegrationDistill(vault, {
      resolve: () =>
        ok({
          client: { complete: vi.fn(), completeJson: vi.fn(), completeWithTools: vi.fn() },
          config: {
            model: "test-model",
            maxLlmCalls: 1,
            maxClaims: 3,
            maxVerbatimChars: 100,
            inCallInputCap: 16,
            corroborationThreshold: 0.8,
          },
          transport: "anthropic",
        }),
      extract: async () => ({
        claims: [],
        budget_exhausted: true,
        llmCalls: 1,
        chunkErrors: [{ anchor: "chunk", error: "partial" }],
      }),
      upsert,
    });

    expect(
      (await distill({ providerSourceId: "notion:page-1", revision: "2", text: "long text" })).ok,
    ).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("does not report success when proposal staging has errors", async () => {
    const distill = createIntegrationDistill(vault, {
      resolve: () =>
        ok({
          client: { complete: vi.fn(), completeJson: vi.fn(), completeWithTools: vi.fn() },
          config: {
            model: "test-model",
            maxLlmCalls: 1,
            maxClaims: 3,
            maxVerbatimChars: 100,
            inCallInputCap: 64,
            corroborationThreshold: 0.8,
          },
          transport: "anthropic",
        }),
      extract: async () => ({ claims: [], budget_exhausted: false, llmCalls: 1, chunkErrors: [] }),
      upsert: async () =>
        ok({
          noop: false,
          skipped: [],
          updated: [],
          created: [],
          propose: {
            proposed: 0,
            results: [],
            errors: [{ claim_key: "claim", error: "stage failed" }],
          },
          stateWritten: true,
        }),
    });

    expect(
      (await distill({ providerSourceId: "google:doc-1", revision: "2", text: "text" })).ok,
    ).toBe(false);
  });

  it("rejects exact-source model output before staging without echoing source text", async () => {
    const source = "private exact provider document text";
    const upsert = vi.fn();
    const distill = createIntegrationDistill(vault, {
      resolve: () =>
        ok({
          client: { complete: vi.fn(), completeJson: vi.fn(), completeWithTools: vi.fn() },
          config: {
            model: "test-model",
            maxLlmCalls: 1,
            maxClaims: 3,
            maxVerbatimChars: 100,
            inCallInputCap: 128,
            corroborationThreshold: 0.8,
          },
          transport: "anthropic",
        }),
      extract: async () => ({
        claims: [
          {
            claim_key: "claim-1",
            statement: source,
            proposed_frontmatter: { title: "Unsafe output" },
          },
        ],
        budget_exhausted: false,
        llmCalls: 1,
        chunkErrors: [],
      }),
      upsert,
    });

    const result = await distill({ providerSourceId: "google:doc-1", revision: "1", text: source });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(source);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects model output that wraps the full source before staging", async () => {
    const source = "private provider document text that must not survive extraction";
    const upsert = vi.fn();
    const distill = createIntegrationDistill(vault, {
      resolve: () =>
        ok({
          client: { complete: vi.fn(), completeJson: vi.fn(), completeWithTools: vi.fn() },
          config: {
            model: "test-model",
            maxLlmCalls: 1,
            maxClaims: 3,
            maxVerbatimChars: 10,
            inCallInputCap: 128,
            corroborationThreshold: 0.8,
          },
          transport: "anthropic",
        }),
      extract: async () => ({
        claims: [
          {
            claim_key: "claim-1",
            statement: `The document says: ${source}`,
            proposed_frontmatter: { title: "Unsafe wrapped output" },
          },
        ],
        budget_exhausted: false,
        llmCalls: 1,
        chunkErrors: [],
      }),
      upsert,
    });

    const result = await distill({ providerSourceId: "google:doc-1", revision: "1", text: source });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain(source);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects an over-limit source excerpt wrapped in model prose", async () => {
    const source = "prefix SECRET-COPIED-PASSAGE suffix";
    const upsert = vi.fn();
    const distill = createIntegrationDistill(vault, {
      resolve: () =>
        ok({
          client: { complete: vi.fn(), completeJson: vi.fn(), completeWithTools: vi.fn() },
          config: {
            model: "test-model",
            maxLlmCalls: 1,
            maxClaims: 3,
            maxVerbatimChars: 8,
            inCallInputCap: 128,
            corroborationThreshold: 0.8,
          },
          transport: "anthropic",
        }),
      extract: async () => ({
        claims: [
          {
            claim_key: "claim-1",
            statement: "The relevant excerpt is SECRET-COPIED-PASSAGE.",
            proposed_frontmatter: { title: "Unsafe excerpt" },
          },
        ],
        budget_exhausted: false,
        llmCalls: 1,
        chunkErrors: [],
      }),
      upsert,
    });

    const result = await distill({ providerSourceId: "google:doc-1", revision: "1", text: source });
    expect(result.ok).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("prepares and resolves the distill dependency before it can be invoked", async () => {
    const resolve = vi.fn(() =>
      ok({
        client: { complete: vi.fn(), completeJson: vi.fn(), completeWithTools: vi.fn() },
        config: {
          model: "test-model",
          maxLlmCalls: 1,
          maxClaims: 3,
          maxVerbatimChars: 100,
          inCallInputCap: 128,
          corroborationThreshold: 0.8,
        },
        transport: "anthropic" as const,
      }),
    );
    const prepared = prepareIntegrationDistill(vault, {
      resolve,
      extract: async () => ({ claims: [], budget_exhausted: false, llmCalls: 0, chunkErrors: [] }),
      upsert: async () =>
        ok({
          noop: false,
          skipped: [],
          updated: [],
          created: [],
          propose: null,
          stateWritten: true,
        }),
    });

    expect(prepared.ok).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    if (!prepared.ok) return;
    await prepared.value({ providerSourceId: "google:doc-1", revision: "1", text: "safe" });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
