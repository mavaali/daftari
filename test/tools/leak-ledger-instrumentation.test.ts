// Integration coverage for U2's two capture sites: vault_read (read.ts) and
// vault_search/vault_search_related (search.ts) both append to the
// cross-vault leak ledger IF AND ONLY IF the caller passed a run_id AND the
// gate is active (leak_gate.mode !== "off" — FIX 3), and stamp the
// visibility of the vault that served the read. Full module behavior
// (scanning, correlation, corrupt lines) is covered by
// test/curation/leak-ledger.test.ts; this file only proves the two tools
// wire into it correctly.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateReadsForRun, readLeakLedger } from "../../src/curation/leak-ledger.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultReindex, vaultSearch } from "../../src/tools/search.js";
import { configPath } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("leak-ledger instrumentation", () => {
  let vault: string;
  let ledgerDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    vault = makeTempVault();
    ledgerDir = mkdtempSync(join(tmpdir(), "daftari-leak-ledger-dst-"));
    ledgerPath = join(ledgerDir, "leak-ledger.jsonl");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    // mode: refuse — an explicit opt-in. Since FIX 3, appending is gated on
    // the gate being active (mode !== "off"); leaving mode unset here would
    // silently stop testing the append path at all.
    writeFileSync(
      configPath(vault),
      `visibility: private\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: refuse\n`,
    );
  });

  afterEach(() => {
    cleanupVault(vault);
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  it("vault_read with a run_id appends a leak-ledger entry stamped with this vault's visibility", async () => {
    const result = await vaultRead(
      vault,
      "competitive-intel/aurora-pipelines-vs-helios-connect.md",
      undefined,
      "run-leak-1",
    );
    expect(result.ok).toBe(true);

    const scan = await privateReadsForRun(ledgerPath, "run-leak-1");
    expect(scan.count).toBeGreaterThanOrEqual(1);

    const log = await readLeakLedger(ledgerPath);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    const entry = log.value.find((e) => e.run_id === "run-leak-1");
    expect(entry?.visibility).toBe("private");
    expect(entry?.tool).toBe("vault_read");
  });

  it("vault_read with NO run_id appends nothing to the leak ledger", async () => {
    const result = await vaultRead(
      vault,
      "competitive-intel/aurora-pipelines-vs-helios-connect.md",
    );
    expect(result.ok).toBe(true);

    const log = await readLeakLedger(ledgerPath);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value.length).toBe(0);
  });

  it("vault_search with a run_id appends leak-ledger entries for served hits", async () => {
    const reindexed = await vaultReindex(vault);
    expect(reindexed.ok).toBe(true);

    const result = await vaultSearch(vault, {
      query: "Helios compute credit consumption pricing",
      run_id: "run-leak-search",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.length).toBeGreaterThan(0);

    const scan = await privateReadsForRun(ledgerPath, "run-leak-search");
    expect(scan.count).toBeGreaterThanOrEqual(1);
  });

  it("vault_search with NO run_id appends nothing to the leak ledger", async () => {
    const reindexed = await vaultReindex(vault);
    expect(reindexed.ok).toBe(true);

    const result = await vaultSearch(vault, { query: "Helios compute credit consumption pricing" });
    expect(result.ok).toBe(true);

    const log = await readLeakLedger(ledgerPath);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value.length).toBe(0);
  });

  it("FIX 3: vault_read with a run_id appends NOTHING when leak_gate.mode is off", async () => {
    writeFileSync(
      configPath(vault),
      `visibility: private\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: off\n`,
    );
    const result = await vaultRead(
      vault,
      "competitive-intel/aurora-pipelines-vs-helios-connect.md",
      undefined,
      "run-leak-off",
    );
    expect(result.ok).toBe(true);

    const log = await readLeakLedger(ledgerPath);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value.length).toBe(0);
  });

  it("FIX 3: vault_search with a run_id appends NOTHING when leak_gate.mode is off", async () => {
    writeFileSync(
      configPath(vault),
      `visibility: private\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: off\n`,
    );
    const reindexed = await vaultReindex(vault);
    expect(reindexed.ok).toBe(true);

    const result = await vaultSearch(vault, {
      query: "Helios compute credit consumption pricing",
      run_id: "run-leak-search-off",
    });
    expect(result.ok).toBe(true);

    const log = await readLeakLedger(ledgerPath);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value.length).toBe(0);
  });
});
