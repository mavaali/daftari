// U3: the write-time refusal half of the cross-vault leak gate. U2 (already
// landed) instruments vault_read/vault_search to append run_id-keyed entries
// to a ledger OUTSIDE any vault, stamped with the SERVING vault's own
// `visibility`. This file covers the OTHER end: does `vault_write` /
// `vault_append` — writing into a `visibility: shared` vault — refuse (or
// warn) when the ledger shows the current run already read something
// `private`.
//
// Every scenario wires a "private" vault and a "shared" (gated) vault to the
// SAME session ledger file, exactly like a real single-box household session
// would: one process serves the private vault, another serves the shared
// one, and the ledger is the one thing both can see.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { vaultRead } from "../../src/tools/read.js";
import { LEAK_GATE_PREFIX, vaultAppend, vaultWrite } from "../../src/tools/write.js";
import { configPath } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// Any authenticated agent caller — the exact role shape doesn't matter here,
// only that an AccessContext is present (vs. an operator server with none).
const AGENT_ACCESS = {
  user: "agent:claude-code",
  roleName: "admin",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

const PRIVATE_DOC = "competitive-intel/aurora-pipelines-vs-helios-connect.md";

function newFrontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Serverless Cost Notes",
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
    tags: ["pricing", "serverless"],
    ...overrides,
  };
}

describe("write-time leak gate (U3)", () => {
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
    ledgerDir = mkdtempSync(join(tmpdir(), "daftari-leak-gate-dst-"));
    ledgerPath = join(ledgerDir, "leak-ledger.jsonl");
    // Explicit mode: refuse on BOTH vaults — the engine default is "off" (a
    // household deployment opts in explicitly), so this suite's baseline case
    // sets it. The private vault also needs an active mode since FIX 3: a
    // read is only journaled to the ledger when leak_gate.mode !== "off" on
    // the SERVING vault — without this, none of the private reads below
    // would ever reach the ledger for the shared vault's gate to see.
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

  it("RED-TEAM: refuses a shared write when this run read a private source (mode: refuse)", async () => {
    const readResult = await vaultRead(privateVault, PRIVATE_DOC, undefined, "run-redteam-1");
    expect(readResult.ok).toBe(true);

    const write = await vaultWrite(
      sharedVault,
      {
        path: "pricing/new-note.md",
        body: "# Laundered\n\nShould never land.\n",
        frontmatter: newFrontmatter(),
        agent: "agent:claude-code",
        run_id: "run-redteam-1",
      },
      AGENT_ACCESS,
    );

    expect(write.ok).toBe(false);
    if (write.ok) return;
    expect(write.error.message.startsWith(LEAK_GATE_PREFIX)).toBe(true);
    expect(write.error.message).toContain("run-redteam-1");
    // The refusal names a COUNT, never the private document's path/basename.
    expect(write.error.message).not.toContain("aurora-pipelines-vs-helios-connect");
    expect(write.error.message).not.toContain(PRIVATE_DOC);

    // Nothing landed: no file, no commit.
    const readBack = await vaultRead(sharedVault, "pricing/new-note.md");
    expect(readBack.ok).toBe(false);

    // A rejected_leak provenance entry was logged, and its reason ALSO never
    // names the private path.
    const log = await readProvenanceLog(sharedVault);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    const rejected = log.value.find((e) => e.action === "rejected_leak");
    expect(rejected).toBeDefined();
    expect(rejected?.run_id).toBe("run-redteam-1");
    expect(rejected?.reason).not.toContain(PRIVATE_DOC);
  });

  it("allows a shared write when this run read nothing private", async () => {
    const write = await vaultWrite(
      sharedVault,
      {
        path: "pricing/new-note.md",
        body: "# Clean\n\nNo private reads under this run.\n",
        frontmatter: newFrontmatter(),
        agent: "agent:claude-code",
        run_id: "run-clean-1",
      },
      AGENT_ACCESS,
    );
    expect(write.ok).toBe(true);
    if (!write.ok) return;
    expect(write.value.leak_warning).toBeUndefined();
  });

  it("allows a write when the TARGET vault is itself private, even with a private read on the run", async () => {
    const readResult = await vaultRead(privateVault, PRIVATE_DOC, undefined, "run-private-target");
    expect(readResult.ok).toBe(true);

    const write = await vaultWrite(
      privateVault,
      {
        path: "pricing/new-note.md",
        body: "# Fine\n\nWriting private-to-private.\n",
        frontmatter: newFrontmatter(),
        agent: "agent:claude-code",
        run_id: "run-private-target",
      },
      AGENT_ACCESS,
    );
    expect(write.ok).toBe(true);
  });

  it("warn mode lands the write and attaches leak_warning instead of refusing", async () => {
    configureVault(
      sharedVault,
      `visibility: shared\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: warn\n`,
    );
    const readResult = await vaultRead(privateVault, PRIVATE_DOC, undefined, "run-warn-1");
    expect(readResult.ok).toBe(true);

    const write = await vaultWrite(
      sharedVault,
      {
        path: "pricing/new-note.md",
        body: "# Warned\n\nLands anyway.\n",
        frontmatter: newFrontmatter(),
        agent: "agent:claude-code",
        run_id: "run-warn-1",
      },
      AGENT_ACCESS,
    );
    expect(write.ok).toBe(true);
    if (!write.ok) return;
    expect(write.value.leak_warning).toBeDefined();
    expect(write.value.leak_warning).not.toContain(PRIVATE_DOC);

    const readBack = await vaultRead(sharedVault, "pricing/new-note.md");
    expect(readBack.ok).toBe(true);
  });

  it("mode: off never checks the ledger — always succeeds, no warning", async () => {
    configureVault(
      sharedVault,
      `visibility: shared\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: off\n`,
    );
    const readResult = await vaultRead(privateVault, PRIVATE_DOC, undefined, "run-off-1");
    expect(readResult.ok).toBe(true);

    const write = await vaultWrite(
      sharedVault,
      {
        path: "pricing/new-note.md",
        body: "# Off\n\nGate disabled.\n",
        frontmatter: newFrontmatter(),
        agent: "agent:claude-code",
        run_id: "run-off-1",
      },
      AGENT_ACCESS,
    );
    expect(write.ok).toBe(true);
    if (!write.ok) return;
    expect(write.value.leak_warning).toBeUndefined();
  });

  it("fail-closed: an unreadable ledger REFUSES in mode: refuse, rather than allowing", async () => {
    // A ledger "path" that is actually a directory: readFile on it throws
    // EISDIR, not ENOENT — a genuinely broken ledger, not merely "nothing
    // recorded yet" (which stays allowed, see the next test).
    const brokenLedgerPath = join(ledgerDir, "broken-ledger-is-a-dir");
    mkdirSync(brokenLedgerPath);
    configureVault(
      sharedVault,
      `visibility: shared\nleak_gate:\n  session_ledger_path: "${brokenLedgerPath}"\n  mode: refuse\n`,
    );

    const write = await vaultWrite(
      sharedVault,
      {
        path: "pricing/new-note.md",
        body: "# Should not land\n",
        frontmatter: newFrontmatter(),
        agent: "agent:claude-code",
        run_id: "run-broken-ledger",
      },
      AGENT_ACCESS,
    );
    expect(write.ok).toBe(false);
    if (write.ok) return;
    expect(write.error.message.startsWith(LEAK_GATE_PREFIX)).toBe(true);

    const readBack = await vaultRead(sharedVault, "pricing/new-note.md");
    expect(readBack.ok).toBe(false);
  });

  it("a ledger that simply doesn't exist yet is NOT a fail-closed refusal (nothing recorded != broken)", async () => {
    const neverWrittenPath = join(ledgerDir, "never-written.jsonl");
    configureVault(
      sharedVault,
      `visibility: shared\nleak_gate:\n  session_ledger_path: "${neverWrittenPath}"\n  mode: refuse\n`,
    );
    const write = await vaultWrite(
      sharedVault,
      {
        path: "pricing/new-note.md",
        body: "# Fine\n",
        frontmatter: newFrontmatter(),
        agent: "agent:claude-code",
        run_id: "run-no-ledger-yet",
      },
      AGENT_ACCESS,
    );
    expect(write.ok).toBe(true);
  });

  it("run_id-less: an agent (access-bearing) caller writing into a shared vault with NO run_id is refused", async () => {
    const write = await vaultWrite(
      sharedVault,
      {
        path: "pricing/new-note.md",
        body: "# No run id\n",
        frontmatter: newFrontmatter(),
        agent: "agent:claude-code",
        // run_id deliberately omitted.
      },
      AGENT_ACCESS,
    );
    expect(write.ok).toBe(false);
    if (write.ok) return;
    expect(write.error.message.startsWith(LEAK_GATE_PREFIX)).toBe(true);
  });

  it("run_id-less: an OPERATOR (no AccessContext) is exempt and writes normally", async () => {
    const write = await vaultWrite(sharedVault, {
      path: "pricing/new-note.md",
      body: "# Operator, no run id\n",
      frontmatter: newFrontmatter(),
      agent: "agent:claude-code",
      // No access argument at all — operator server.
    });
    expect(write.ok).toBe(true);
  });

  it("KNOWN LIMITATION (asserted, not fixed): rephrase-laundering under a different run_id is NOT caught", async () => {
    // The agent reads private material under run R...
    const readResult = await vaultRead(privateVault, PRIVATE_DOC, undefined, "run-launder-source");
    expect(readResult.ok).toBe(true);

    // ...then writes into the shared vault under a DIFFERENT run_id R2. The
    // ledger has nothing recorded under R2, so the gate — which can only see
    // what THIS run_id read — has no evidence to refuse on. This is the
    // documented structural boundary of a free-text, caller-supplied run_id:
    // closing it needs a stronger identity signal than run_id alone.
    const write = await vaultWrite(
      sharedVault,
      {
        path: "pricing/new-note.md",
        body: "# Laundered via a fresh run_id\n",
        frontmatter: newFrontmatter(),
        agent: "agent:claude-code",
        run_id: "run-launder-destination",
      },
      AGENT_ACCESS,
    );
    expect(write.ok).toBe(true);
  });

  it("vault_append is covered by the same gate (performWrite is the shared insertion point)", async () => {
    const readResult = await vaultRead(privateVault, PRIVATE_DOC, undefined, "run-append-redteam");
    expect(readResult.ok).toBe(true);

    const append = await vaultAppend(
      sharedVault,
      {
        path: "pricing/serverless-cost-predictability.md",
        section: "## Should never land\n\nLaundered via append.\n",
        agent: "agent:claude-code",
        run_id: "run-append-redteam",
      },
      AGENT_ACCESS,
    );
    expect(append.ok).toBe(false);
    if (append.ok) return;
    expect(append.error.message.startsWith(LEAK_GATE_PREFIX)).toBe(true);
    expect(append.error.message).not.toContain(PRIVATE_DOC);
  });
});
