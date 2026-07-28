// Config parsing for the embeddings.provider block (issue #38 PR 4).
//
// The vault owner picks a provider in .daftari/config.yaml; the loader
// validates the choice and (for openai-3-small) the OPENAI_API_KEY env var.
// A missing or absent block defaults to local-minilm. Anything else is a
// hard config error — the trust model is "vault owner configures the
// server", so silent fallbacks on typos would be worse than refusing to start.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — embeddings.provider", () => {
  let dir: string;
  let originalKey: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-embeddings-"));
    originalKey = process.env.OPENAI_API_KEY;
    // Default to no key — the openai provider tests opt back in.
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  it("defaults to local-minilm when no config file exists", () => {
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingProvider).toBe("local-minilm");
    expect(result.value.embeddingDim).toBeNull();
    expect(result.value.embeddingQuantize).toBe("none");
  });

  it("defaults to local-minilm when the embeddings block is omitted", () => {
    writeConfig("auto_commit: true\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingProvider).toBe("local-minilm");
  });

  it("defaults to local-minilm when the block is present but provider is omitted", () => {
    writeConfig("embeddings: {}\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingProvider).toBe("local-minilm");
  });

  it("accepts provider: local-minilm explicitly", () => {
    writeConfig("embeddings:\n  provider: local-minilm\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingProvider).toBe("local-minilm");
  });

  it("accepts provider: openai-3-small when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    writeConfig("embeddings:\n  provider: openai-3-small\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingProvider).toBe("openai-3-small");
  });

  it("fails loud on provider: openai-3-small with no OPENAI_API_KEY in env", () => {
    // Belt and suspenders — explicit just in case the beforeEach delete missed.
    delete process.env.OPENAI_API_KEY;
    writeConfig("embeddings:\n  provider: openai-3-small\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/OPENAI_API_KEY/);
  });

  it("rejects an unknown provider id with a helpful message", () => {
    writeConfig("embeddings:\n  provider: cohere-mighty-3\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/unknown embeddings\.provider/);
    expect(result.error.message).toMatch(/local-minilm/);
    expect(result.error.message).toMatch(/openai-3-small/);
  });

  it("rejects non-string provider value", () => {
    writeConfig("embeddings:\n  provider: 42\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/must be a string/);
  });

  it("rejects an embeddings block that is not a mapping", () => {
    writeConfig("embeddings: not-a-mapping\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'embeddings' must be a mapping/);
  });

  it("rejects an embeddings block that is a list", () => {
    writeConfig("embeddings:\n  - local-minilm\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'embeddings' must be a mapping/);
  });
});

// New providers + dim/quantize (2026-07-26 embedding-refresh-quantization
// spec, Phase 2a).
describe("loadConfig — embeddings.provider (new local providers)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-embeddings2-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  it("accepts provider: local-embeddinggemma, defaulting dim to 512 and quantize to int8", () => {
    writeConfig("embeddings:\n  provider: local-embeddinggemma\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingProvider).toBe("local-embeddinggemma");
    expect(result.value.embeddingDim).toBe(512);
    expect(result.value.embeddingQuantize).toBe("int8");
  });

  it("accepts provider: local-qwen3-0.6b, defaulting dim to 512 and quantize to int8", () => {
    writeConfig("embeddings:\n  provider: local-qwen3-0.6b\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingProvider).toBe("local-qwen3-0.6b");
    expect(result.value.embeddingDim).toBe(512);
    expect(result.value.embeddingQuantize).toBe("int8");
  });

  it("accepts an explicit dim: 768 for local-embeddinggemma", () => {
    writeConfig("embeddings:\n  provider: local-embeddinggemma\n  dim: 768\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingDim).toBe(768);
  });

  it("rejects dim: 384 for local-embeddinggemma (not a trained Matryoshka point)", () => {
    writeConfig("embeddings:\n  provider: local-embeddinggemma\n  dim: 384\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'embeddings\.dim' 384 is not valid/);
  });

  it("rejects any dim for local-minilm (fixed-dim provider)", () => {
    writeConfig("embeddings:\n  provider: local-minilm\n  dim: 384\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'embeddings\.dim' is not accepted/);
  });

  it("rejects a non-integer or non-positive dim", () => {
    writeConfig("embeddings:\n  provider: local-embeddinggemma\n  dim: -5\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'embeddings\.dim' must be a positive integer/);
  });

  it("accepts quantize: none for local-embeddinggemma, overriding the int8 default", () => {
    writeConfig("embeddings:\n  provider: local-embeddinggemma\n  quantize: none\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingQuantize).toBe("none");
  });

  it("accepts quantize: int8 for local-minilm (accepted for any provider)", () => {
    writeConfig("embeddings:\n  provider: local-minilm\n  quantize: int8\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingProvider).toBe("local-minilm");
    expect(result.value.embeddingQuantize).toBe("int8");
  });

  it("local-minilm still defaults to quantize: none", () => {
    writeConfig("embeddings:\n  provider: local-minilm\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.embeddingQuantize).toBe("none");
  });

  it("rejects an unknown quantize value", () => {
    writeConfig("embeddings:\n  provider: local-embeddinggemma\n  quantize: fp16\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'embeddings\.quantize' must be one of/);
  });

  it("rejects an unrecognised key under embeddings", () => {
    writeConfig("embeddings:\n  provider: local-minilm\n  precision: high\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'embeddings\.precision' is not a recognised/);
  });

  it("the unknown-provider error message lists the new provider ids too", () => {
    writeConfig("embeddings:\n  provider: cohere-mighty-3\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/local-embeddinggemma/);
    expect(result.error.message).toMatch(/local-qwen3-0\.6b/);
  });
});
