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
