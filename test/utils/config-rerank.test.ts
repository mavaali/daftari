// Config parsing for the rerank.provider block (spec 2026-07-26-contextual-
// chunking-reranker-design.md Decision 5).
//
// The vault owner opts a reranker in via .daftari/config.yaml; the loader
// validates the choice. A missing or absent block defaults to "none" — the
// default install stays light, unlike embeddings (no OPENAI_API_KEY-style
// env check here: local-bge-m3 is a fully local model). Anything else is a
// hard config error — same trust model as embeddings.provider: a typo that
// meant to enable reranking must never silently no-op.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — rerank.provider", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-rerank-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  it("defaults to none when no config file exists", () => {
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rerankProvider).toBe("none");
  });

  it("defaults to none when the rerank block is omitted", () => {
    writeConfig("auto_commit: true\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rerankProvider).toBe("none");
  });

  it("defaults to none when the block is present but provider is omitted", () => {
    writeConfig("rerank: {}\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rerankProvider).toBe("none");
  });

  it("accepts provider: none explicitly", () => {
    writeConfig("rerank:\n  provider: none\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rerankProvider).toBe("none");
  });

  it("accepts provider: local-bge-m3", () => {
    writeConfig("rerank:\n  provider: local-bge-m3\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rerankProvider).toBe("local-bge-m3");
  });

  it("rejects an unknown provider id with a helpful message", () => {
    writeConfig("rerank:\n  provider: cohere-rerank-3\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/unknown rerank\.provider/);
    expect(result.error.message).toMatch(/none/);
    expect(result.error.message).toMatch(/local-bge-m3/);
  });

  it("rejects non-string provider value", () => {
    writeConfig("rerank:\n  provider: 42\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/must be a string/);
  });

  it("rejects a rerank block that is not a mapping", () => {
    writeConfig("rerank: not-a-mapping\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'rerank' must be a mapping/);
  });

  it("rejects a rerank block that is a list", () => {
    writeConfig("rerank:\n  - local-bge-m3\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'rerank' must be a mapping/);
  });
});
