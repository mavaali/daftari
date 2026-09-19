import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultLeakLedgerPath,
  leakLedgerPath,
  privateReadsForRun,
  readLeakLedger,
  recordLeakLedgerEntries,
  recordLeakLedgerEntry,
  sourceVaultId,
} from "../../src/curation/leak-ledger.js";

describe("leak ledger (U2)", () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-leak-ledger-"));
    ledgerPath = join(dir, "leak-ledger.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("correlates a private read across two different serving vault roots for the same run", async () => {
    // Process A serves vault-private, appends a private read for run R.
    const append = await recordLeakLedgerEntry(ledgerPath, {
      tool: "vault_read",
      run_id: "run-R",
      principal: "agent:alpha",
      visibility: "private",
      source_vault: "/vaults/private-owner",
    });
    expect(append.ok).toBe(true);

    // Process B (a different vaultRoot entirely — the shared-canonical
    // process) scans the SAME OS-level ledger and must see it. This is
    // exactly what the per-vault read log cannot do.
    const scan = await privateReadsForRun(ledgerPath, "run-R");
    expect(scan.count).toBeGreaterThanOrEqual(1);
    expect(scan.principals).toContain("agent:alpha");
  });

  it("reports zero when a run only read shared-visibility sources", async () => {
    await recordLeakLedgerEntry(ledgerPath, {
      tool: "vault_read",
      run_id: "run-S",
      visibility: "shared",
      source_vault: "/vaults/shared-canonical",
    });

    const scan = await privateReadsForRun(ledgerPath, "run-S");
    expect(scan.count).toBe(0);
    expect(scan.principals).toEqual([]);
  });

  it("reports zero for a run with no entries at all", async () => {
    const scan = await privateReadsForRun(ledgerPath, "run-unknown");
    expect(scan.count).toBe(0);
    expect(scan.principals).toEqual([]);
  });

  it("skips a corrupt line but still counts the valid entries around it", async () => {
    await recordLeakLedgerEntry(ledgerPath, {
      tool: "vault_read",
      run_id: "run-C",
      principal: "agent:first",
      visibility: "private",
      source_vault: "/vaults/private-owner",
    });
    appendFileSync(ledgerPath, "not-json-at-all\n");
    await recordLeakLedgerEntry(ledgerPath, {
      tool: "vault_read",
      run_id: "run-C",
      principal: "agent:second",
      visibility: "private",
      source_vault: "/vaults/private-owner",
    });

    const log = await readLeakLedger(ledgerPath);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value.map((e) => e.principal)).toEqual(["agent:first", "agent:second"]);

    const scan = await privateReadsForRun(ledgerPath, "run-C");
    expect(scan.count).toBe(2);
  });

  it("batch-appends entries from one search call in a single write", async () => {
    const batch = await recordLeakLedgerEntries(ledgerPath, [
      {
        tool: "vault_search",
        run_id: "run-B",
        visibility: "private",
        source_vault: "/vaults/private-owner",
      },
      {
        tool: "vault_search",
        run_id: "run-B",
        visibility: "private",
        source_vault: "/vaults/private-owner",
      },
    ]);
    expect(batch.ok).toBe(true);
    const scan = await privateReadsForRun(ledgerPath, "run-B");
    expect(scan.count).toBe(2);
  });

  it("never surfaces source paths from privateReadsForRun", async () => {
    await recordLeakLedgerEntry(ledgerPath, {
      tool: "vault_read",
      run_id: "run-P",
      visibility: "private",
      source_vault: "/vaults/private-owner",
    });
    const scan = await privateReadsForRun(ledgerPath, "run-P");
    expect(Object.keys(scan).sort()).toEqual(["count", "principals"]);
    expect(JSON.stringify(scan)).not.toContain("very-specific-doc");
  });

  it("FIX 3: a recorded entry carries no private path — no 'file' key at all", async () => {
    const append = await recordLeakLedgerEntry(ledgerPath, {
      tool: "vault_read",
      run_id: "run-nopath",
      visibility: "private",
      source_vault: "/vaults/private-owner",
    });
    expect(append.ok).toBe(true);
    if (!append.ok) return;
    expect(Object.keys(append.value).sort()).toEqual(
      ["run_id", "source_vault", "timestamp", "tool", "visibility"].sort(),
    );
    const log = await readLeakLedger(ledgerPath);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(JSON.stringify(log.value)).not.toMatch(/"file"/);
  });

  it("treats a missing ledger file as no evidence, not an error", async () => {
    const missing = join(dir, "does-not-exist.jsonl");
    const log = await readLeakLedger(missing);
    expect(log.ok && log.value).toEqual([]);
    const scan = await privateReadsForRun(missing, "run-X");
    expect(scan).toEqual({ count: 0, principals: [] });
  });

  it("leakLedgerPath falls back to the OS default when unconfigured", () => {
    expect(leakLedgerPath(undefined)).toBe(defaultLeakLedgerPath());
    expect(leakLedgerPath("")).toBe(defaultLeakLedgerPath());
    expect(leakLedgerPath("/custom/path.jsonl")).toBe("/custom/path.jsonl");
  });

  it("sourceVaultId resolves to an absolute path", () => {
    expect(sourceVaultId(".")).not.toBe(".");
    expect(sourceVaultId("/already/absolute")).toBe("/already/absolute");
  });
});
