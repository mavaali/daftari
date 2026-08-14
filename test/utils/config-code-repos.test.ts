// Config parsing for the code_repos + jit_anchors blocks (JIT anchor pins, U2).
//
// code_repos maps a describes `repo:` prefix to a local code checkout so the
// read-time pin check can resolve it; jit_anchors is the kill-switch (default
// true). Paths are ~/relative/absolute-expanded but existence is deliberately
// NOT checked at load — a synced vault may reach a machine without the checkout,
// where the read path silently degrades to no anchors.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — code_repos + jit_anchors", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-code-repos-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  it("defaults to empty code_repos and jit_anchors true when no config exists", () => {
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.codeRepos).toEqual({});
    expect(result.value.jitAnchors).toBe(true);
  });

  it("defaults when the blocks are omitted", () => {
    writeConfig("auto_commit: true\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.codeRepos).toEqual({});
    expect(result.value.jitAnchors).toBe(true);
  });

  it("resolves a relative code_repos path against the vault root", () => {
    writeConfig("code_repos:\n  api: ../code/api\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isAbsolute(result.value.codeRepos.api as string)).toBe(true);
    expect(result.value.codeRepos.api).toMatch(/[/\\]code[/\\]api$/);
  });

  it("expands ~ in a code_repos path", () => {
    writeConfig("code_repos:\n  api: ~/code/api\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.codeRepos.api).toBe(join(homedir(), "code/api"));
  });

  it("passes an absolute code_repos path through", () => {
    writeConfig("code_repos:\n  api: /srv/code/api\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.codeRepos.api).toBe("/srv/code/api");
  });

  it("loads a configured path that does not exist on disk (existence not checked)", () => {
    writeConfig("code_repos:\n  ghost: ../nowhere/does-not-exist\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true); // must NOT fail — synced-vault reality
  });

  it("accepts jit_anchors: false", () => {
    writeConfig("jit_anchors: false\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.jitAnchors).toBe(false);
  });

  it("rejects a code_repos block that is a list", () => {
    writeConfig("code_repos:\n  - ../code/api\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'code_repos' must be a mapping/);
  });

  it("rejects a non-string code_repos value, naming the key", () => {
    writeConfig("code_repos:\n  api: 5\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/code_repos\['api'\]/);
  });

  it("rejects a non-boolean jit_anchors", () => {
    writeConfig('jit_anchors: "yes"\n');
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'jit_anchors' must be true or false/);
  });

  // auto_repin (U7): kill-switch for the sleep-cycle auto-repin proposer.
  it("defaults auto_repin to true when no config exists", () => {
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.autoRepin).toBe(true);
  });

  it("defaults auto_repin to true when the key is omitted", () => {
    writeConfig("auto_commit: true\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.autoRepin).toBe(true);
  });

  it("accepts auto_repin: false", () => {
    writeConfig("auto_repin: false\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.autoRepin).toBe(false);
  });

  it("rejects a non-boolean auto_repin", () => {
    writeConfig('auto_repin: "yes"\n');
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/'auto_repin' must be true or false/);
  });
});
