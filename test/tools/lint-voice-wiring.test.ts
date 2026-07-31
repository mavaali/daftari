import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderLedgerKeeper } from "../../src/curation/lint-voice.js";
import {
  lintContentSummary,
  summarizeLint,
  type VaultLintResult,
  vaultLint,
} from "../../src/tools/curation.js";
import { clearConfigCache, configPath } from "../../src/utils/config.js";

const LINT_VAULT = resolve("test/fixtures/lint-vault");

// A small VaultLintResult with one finding, enough to distinguish the voices.
function fixture(): VaultLintResult {
  return {
    generatedAt: "2026-07-30T00:00:00.000Z",
    filter: null,
    checks: { orphanFiles: [{ path: "notes/lonely.md", detail: "no inbound links" }] },
    totalFindings: 1,
    tensionHealth: {
      total: 0,
      resolvedLifetime: 0,
      stableAcknowledged: 0,
      aging: { fresh: 0, aging: 0, stale: 0 },
      clusters: { count: 0, large: 0, aged: 0 },
      blastRadiusOfStaleTensions: 0,
    },
    stagedActions: [],
    shadowActions: { total: 0, gated: 0 },
    coverageEquity: { backstopOverdue: { count: 0 } },
    reviewThroughput: { lifetime: { expired: 0 } },
  } as unknown as VaultLintResult;
}

describe("lintContentSummary — voice selection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-lint-voice-"));
    clearConfigCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearConfigCache();
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  it("uses the plain summary when no config exists", () => {
    const value = fixture();
    expect(lintContentSummary(value, dir)).toBe(summarizeLint(value));
  });

  it("uses the plain summary when lint_voice: plain", () => {
    writeConfig("version: 1\nlint_voice: plain\n");
    const value = fixture();
    expect(lintContentSummary(value, dir)).toBe(summarizeLint(value));
  });

  it("uses the ledger-keeper voice when lint_voice: ledger_keeper", () => {
    writeConfig("version: 1\nlint_voice: ledger_keeper\n");
    const value = fixture();
    expect(lintContentSummary(value, dir)).toBe(renderLedgerKeeper(value));
  });

  it("the two voices produce different content for the same value", () => {
    const value = fixture();
    expect(renderLedgerKeeper(value)).not.toBe(summarizeLint(value));
  });

  it("falls back to plain when config is malformed", () => {
    // An unknown lint_voice makes loadConfig error; the summary must not throw.
    writeConfig("version: 1\nlint_voice: fez\n");
    const value = fixture();
    expect(lintContentSummary(value, dir)).toBe(summarizeLint(value));
  });

  it("surfaces the same documents under both voices (real vault)", async () => {
    const result = await vaultLint(LINT_VAULT, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value;
    const plain = summarizeLint(value);
    const ledger = renderLedgerKeeper(value);
    // Every finding path appears in the plain content iff it appears in the
    // ledger content — the voice re-words, it never adds or drops a document.
    const paths = new Set<string>();
    for (const findings of Object.values(value.checks)) {
      for (const f of findings ?? []) paths.add(f.path);
    }
    expect(paths.size).toBeGreaterThan(0);
    for (const p of paths) {
      expect(ledger.includes(p)).toBe(plain.includes(p));
    }
  });
});
