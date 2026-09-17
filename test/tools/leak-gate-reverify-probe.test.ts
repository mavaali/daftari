// ADVERSARIAL RE-VERIFY probes (throwaway, added for the fix-round audit).
// Distinct from write-leak-gate-redteam-probe.test.ts: these target the NEW
// surfaces the fix round introduced — merge run_id parity, mode:off/warn
// behavior of merge, over-refusal regressions from FIX 2, target-vs-source
// visibility keying, and per-run scan-count correctness after `file` was
// dropped from the ledger entry. Same fixture wiring as the red-team probe.

import { chmodSync, existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultRead } from "../../src/tools/read.js";
import { LEAK_GATE_PREFIX, vaultMerge, vaultWrite } from "../../src/tools/write.js";
import { configPath } from "../../src/utils/config.js";
import { privateReadsForRunStrict } from "../../src/curation/leak-ledger.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT_ACCESS = {
  user: "agent:claude-code",
  roleName: "admin",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

const PRIVATE_DOC = "competitive-intel/aurora-pipelines-vs-helios-connect.md";
const PRIVATE_DOC_2 = "competitive-intel/northwind-data-governance.md";
const SECRET_BODY = "# Leaked\n\nprivate content that must not cross into shared.\n";

function fm(title: string) {
  return {
    title,
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    updated: "2026-05-01",
    updated_by: "agent:seed",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["pricing"],
  };
}

describe("RE-VERIFY probes: leak gate fix round", () => {
  let privateVault: string;
  let sharedVault: string;
  let ledgerDir: string;
  let ledgerPath: string;

  function configureVault(vault: string, yaml: string): void {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(configPath(vault), yaml);
  }

  beforeEach(() => {
    privateVault = makeTempVault();
    sharedVault = makeTempVault();
    ledgerDir = mkdtempSync(join(tmpdir(), "daftari-reverify-"));
    ledgerPath = join(ledgerDir, "leak-ledger.jsonl");
    configureVault(
      privateVault,
      `visibility: private\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: refuse\n`,
    );
    configureVault(
      sharedVault,
      `visibility: shared\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: refuse\n`,
    );
  });

  afterEach(() => {
    cleanupVault(privateVault);
    cleanupVault(sharedVault);
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  // ATTACK 1 — different-run_id parity. Read private under R1, then MERGE
  // under R2. Documented limitation: the ledger has nothing under R2, so the
  // merge is NOT caught — but this must be exactly the same escape hatch
  // vault_write has (not a WORSE hole). Verify both land.
  it("ATTACK-1: merge under a DIFFERENT run_id launders — SAME as vault_write (parity, documented limit)", async () => {
    const r = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "R1");
    expect(r.ok).toBe(true);

    // vault_write under R2 (no private read logged under R2) — lands.
    const w = await vaultWrite(
      sharedVault,
      { path: "pricing/write-r2.md", frontmatter: fm("w"), body: SECRET_BODY, agent: "agent:claude-code", run_id: "R2" },
      AGENT_ACCESS,
    );
    console.log("[ATTACK-1] vault_write under R2 ok?", w.ok);
    expect(w.ok).toBe(true);

    // vault_merge under R2 — must have the SAME outcome (lands). Parity, not worse.
    const m = await vaultMerge(
      sharedVault,
      {
        path_a: "pricing/cirrus-capacity-tiers-2026.md",
        path_b: "pricing/helios-consumption-pricing.md",
        target_path: "pricing/merge-r2.md",
        agent: "agent:claude-code",
        body: SECRET_BODY,
        run_id: "R2",
      },
      AGENT_ACCESS,
    );
    console.log("[ATTACK-1] vault_merge under R2 ok?", m.ok, "; parity with write:", m.ok === w.ok);
    expect(m.ok).toBe(true);
    expect(m.ok).toBe(w.ok); // parity
    expect(existsSync(join(sharedVault, "pricing/merge-r2.md"))).toBe(true);
  });

  // ATTACK 4b — merge with mode:"off" behaves normally (no refusal).
  it("ATTACK-4b: merge with mode:off is never refused even after a private read under same run", async () => {
    configureVault(
      sharedVault,
      `visibility: shared\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: off\n`,
    );
    // private read still active — but shared target's gate is off.
    const r = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "Roff");
    expect(r.ok).toBe(true);
    const m = await vaultMerge(
      sharedVault,
      {
        path_a: "pricing/cirrus-capacity-tiers-2026.md",
        path_b: "pricing/helios-consumption-pricing.md",
        target_path: "pricing/merge-off.md",
        agent: "agent:claude-code",
        body: SECRET_BODY,
        run_id: "Roff",
      },
      AGENT_ACCESS,
    );
    console.log("[ATTACK-4b] merge with mode off ok?", m.ok);
    expect(m.ok).toBe(true);
    expect(existsSync(join(sharedVault, "pricing/merge-off.md"))).toBe(true);
  });

  // WARN mode — a private read under the run then a shared write/merge LANDS
  // (warn never blocks), unlike refuse.
  it("ATTACK-warn: warn mode lands the write/merge (best-effort, never refuses)", async () => {
    configureVault(
      sharedVault,
      `visibility: shared\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: warn\n`,
    );
    const r = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "Rwarn");
    expect(r.ok).toBe(true);
    const w = await vaultWrite(
      sharedVault,
      { path: "pricing/warn.md", frontmatter: fm("warn"), body: SECRET_BODY, agent: "agent:claude-code", run_id: "Rwarn" },
      AGENT_ACCESS,
    );
    const m = await vaultMerge(
      sharedVault,
      {
        path_a: "pricing/cirrus-capacity-tiers-2026.md",
        path_b: "pricing/helios-consumption-pricing.md",
        target_path: "pricing/merge-warn.md",
        agent: "agent:claude-code",
        body: SECRET_BODY,
        run_id: "Rwarn",
      },
      AGENT_ACCESS,
    );
    console.log("[ATTACK-warn] write ok?", w.ok, "merge ok?", m.ok);
    expect(w.ok).toBe(true);
    expect(m.ok).toBe(true);
  });

  // ATTACK 4a — FIX 2 must NOT refuse reads when the gate is OFF. A default
  // install (mode off) with an UNWRITABLE ledger dir must still serve reads.
  it("ATTACK-4a: mode:off read is served even when ledger dir is unwritable (no over-refusal on default installs)", async () => {
    const lockedDir = join(ledgerDir, "locked-off");
    mkdirSync(lockedDir, { recursive: true });
    const lockedLedger = join(lockedDir, "leak-ledger.jsonl");
    configureVault(
      privateVault,
      `visibility: private\nleak_gate:\n  session_ledger_path: "${lockedLedger}"\n  mode: off\n`,
    );
    chmodSync(lockedDir, 0o555);
    try {
      const r = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "Roff2");
      console.log("[ATTACK-4a] mode:off read served despite unwritable ledger?", r.ok);
      expect(r.ok).toBe(true);
      expect(existsSync(lockedLedger)).toBe(false);
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  // ATTACK 3-inverse — no OVER-refusal in normal operation. Gated vault,
  // run_id present, ledger dir ABSENT-but-creatable => read SUCCEEDS and the
  // ledger is created (mkdir path in ensureLedgerWritable). Then a clean
  // shared write under a run with NO private read SUCCEEDS.
  it("ATTACK-3inv: gated read with absent-but-creatable ledger dir succeeds and creates it; clean shared write not over-refused", async () => {
    const freshDir = join(ledgerDir, "nested", "does-not-exist-yet");
    const freshLedger = join(freshDir, "leak-ledger.jsonl");
    configureVault(
      privateVault,
      `visibility: private\nleak_gate:\n  session_ledger_path: "${freshLedger}"\n  mode: refuse\n`,
    );
    configureVault(
      sharedVault,
      `visibility: shared\nleak_gate:\n  session_ledger_path: "${freshLedger}"\n  mode: refuse\n`,
    );
    // no private read at all this run.
    const w = await vaultWrite(
      sharedVault,
      { path: "pricing/clean.md", frontmatter: fm("clean"), body: "clean", agent: "agent:claude-code", run_id: "Rclean" },
      AGENT_ACCESS,
    );
    console.log("[ATTACK-3inv] clean shared write (no private read) ok?", w.ok);
    expect(w.ok).toBe(true);

    // a gated private read with the absent-but-creatable ledger dir SUCCEEDS.
    const r = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "Rcreate");
    console.log("[ATTACK-3inv] gated read created ledger dir & served?", r.ok, "; ledger exists?", existsSync(freshLedger));
    expect(r.ok).toBe(true);
    expect(existsSync(freshLedger)).toBe(true);
  });

  // ATTACK 4d — merge keys the gate off the TARGET vault's visibility, not the
  // source. Merging INTO a private vault under a run that read private must be
  // ALLOWED (gate only fires when the write target is shared).
  it("ATTACK-4d: merge INTO a private vault is allowed (gate keys on target visibility, not source)", async () => {
    // Read private under R, then merge two docs INSIDE the private vault.
    const r = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "Rpriv");
    expect(r.ok).toBe(true);
    const m = await vaultMerge(
      privateVault,
      {
        path_a: "pricing/cirrus-capacity-tiers-2026.md",
        path_b: "pricing/helios-consumption-pricing.md",
        target_path: "pricing/merge-into-private.md",
        agent: "agent:claude-code",
        body: SECRET_BODY,
        run_id: "Rpriv",
      },
      AGENT_ACCESS,
    );
    console.log("[ATTACK-4d] merge into private vault ok?", m.ok);
    expect(m.ok).toBe(true);
    expect(existsSync(join(privateVault, "pricing/merge-into-private.md"))).toBe(true);
  });

  // ATTACK 4c — dropping `file` from the ledger entry did NOT break per-run
  // private-read counting. Two DISTINCT private reads under one run => count 2.
  it("ATTACK-4c: scan still counts private reads per run correctly after `file` removed", async () => {
    await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "Rcount");
    await vaultRead(privateVault, PRIVATE_DOC_2, AGENT_ACCESS, "Rcount");
    // a read under a DIFFERENT run must not inflate the count.
    await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "Rother");
    const scanned = await privateReadsForRunStrict(ledgerPath, "Rcount");
    expect(scanned.ok).toBe(true);
    if (scanned.ok) {
      console.log("[ATTACK-4c] private-read count for Rcount:", scanned.value.count);
      expect(scanned.value.count).toBe(2);
    }
    // and the refusal reason surfaces that count (2), never a path.
    const w = await vaultWrite(
      sharedVault,
      { path: "pricing/count.md", frontmatter: fm("count"), body: "x", agent: "agent:claude-code", run_id: "Rcount" },
      AGENT_ACCESS,
    );
    expect(w.ok).toBe(false);
    if (!w.ok) {
      console.log("[ATTACK-4c] refusal reason:", w.error.message);
      expect(w.error.message).toContain("2 private-visibility source");
      expect(w.error.message).not.toContain(PRIVATE_DOC);
      expect(w.error.message).not.toContain(PRIVATE_DOC_2);
    }
    // verify the raw ledger carries no document path/basename at all.
    const raw = readFileSync(ledgerPath, "utf-8");
    expect(raw).not.toContain("aurora-pipelines");
    expect(raw).not.toContain("northwind-data-governance");
  });

  // ATTACK 5 — merge refusal message + provenance name run_id + count only.
  it("ATTACK-5: merge refusal message carries run_id + count, no private path", async () => {
    await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "Rmsg");
    const m = await vaultMerge(
      sharedVault,
      {
        path_a: "pricing/cirrus-capacity-tiers-2026.md",
        path_b: "pricing/helios-consumption-pricing.md",
        target_path: "pricing/merge-msg.md",
        agent: "agent:claude-code",
        body: SECRET_BODY,
        run_id: "Rmsg",
      },
      AGENT_ACCESS,
    );
    expect(m.ok).toBe(false);
    if (!m.ok) {
      console.log("[ATTACK-5] merge refusal:", m.error.message);
      expect(m.error.message).toContain(LEAK_GATE_PREFIX);
      expect(m.error.message).toContain("Rmsg");
      expect(m.error.message).not.toContain("aurora");
      expect(m.error.message).not.toContain(PRIVATE_DOC);
    }
    expect(existsSync(join(sharedVault, "pricing/merge-msg.md"))).toBe(false);
  });
});
