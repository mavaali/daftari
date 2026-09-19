// ADVERSARIAL PROBE. Originally found THREE holes in the U3 cross-vault leak
// gate (vault_merge ungated; fail-open on a silent ledger-append failure;
// the ledger itself leaking private paths / recording when never opted in).
// All three are now fixed — this file has been inverted to assert the gate
// HOLDS against each vector, so it stays a live regression guard rather than
// a throwaway. Mirrors the setup in write-leak-gate.test.ts: a private vault
// and a shared (mode: refuse) vault wired to the SAME ledger.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { vaultRead } from "../../src/tools/read.js";
import { LEAK_GATE_PREFIX, vaultMerge, vaultWrite } from "../../src/tools/write.js";
import { configPath } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT_ACCESS = {
  user: "agent:claude-code",
  roleName: "admin",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

const PRIVATE_DOC = "competitive-intel/aurora-pipelines-vs-helios-connect.md";
const SECRET_BODY = "# Leaked\n\nAurora internal pipeline pricing pulled from the PRIVATE vault.\n";

describe("RED-TEAM PROBE: leak gate", () => {
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
    ledgerDir = mkdtempSync(join(tmpdir(), "daftari-leak-probe-"));
    ledgerPath = join(ledgerDir, "leak-ledger.jsonl");
    // The private vault ALSO needs an active mode (FIX 3): a read is only
    // journaled when leak_gate.mode !== "off" on the SERVING vault.
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

  // VECTOR 1 — the headline. vault_merge now runs the same gate as vault_write.
  it("VECTOR-1 (FIXED): vault_merge is refused into a shared vault under refuse mode, same as vault_write", async () => {
    // Log a private read under run R.
    const r = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "run-merge-bypass");
    expect(r.ok).toBe(true);

    // Sanity: a normal vault_write under the SAME run IS refused (gate works).
    const blocked = await vaultWrite(
      sharedVault,
      {
        path: "pricing/should-be-blocked.md",
        frontmatter: {
          title: "blocked",
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
        },
        body: SECRET_BODY,
        agent: "agent:claude-code",
        run_id: "run-merge-bypass",
      },
      AGENT_ACCESS,
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toContain(LEAK_GATE_PREFIX);

    // Attempted bypass: merge two existing shared docs, writing the SECRET
    // body into the shared vault — under the same run that read the private
    // source, with run_id threaded through (FIX 1: vault_merge now accepts
    // and gates on run_id exactly like vault_write).
    const merged = await vaultMerge(
      sharedVault,
      {
        path_a: "pricing/cirrus-capacity-tiers-2026.md",
        path_b: "pricing/helios-consumption-pricing.md",
        target_path: "pricing/leaked-via-merge.md",
        agent: "agent:claude-code",
        body: SECRET_BODY,
        run_id: "run-merge-bypass",
      },
      AGENT_ACCESS,
    );

    const targetAbs = join(sharedVault, "pricing/leaked-via-merge.md");
    console.log("[VECTOR-1] vault_merge ok?", merged.ok, "; target exists?", existsSync(targetAbs));
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.error.message).toContain(LEAK_GATE_PREFIX);
    expect(existsSync(targetAbs)).toBe(false);
  });

  // VECTOR-1b — even an omitted run_id on vault_merge must not slip past the
  // gate the way a bare direct writeFile once did: an access-bearing caller
  // into a shared/refuse vault with no run_id is refused, same as vault_write.
  it("VECTOR-1b (FIXED): vault_merge with NO run_id into a shared/refuse vault is refused", async () => {
    const merged = await vaultMerge(
      sharedVault,
      {
        path_a: "pricing/cirrus-capacity-tiers-2026.md",
        path_b: "pricing/helios-consumption-pricing.md",
        target_path: "pricing/leaked-via-merge-norunid.md",
        agent: "agent:claude-code",
        body: SECRET_BODY,
        // run_id deliberately omitted
      },
      AGENT_ACCESS,
    );
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.error.message).toContain(LEAK_GATE_PREFIX);
    expect(existsSync(join(sharedVault, "pricing/leaked-via-merge-norunid.md"))).toBe(false);
  });

  // VECTOR 3 — was: silent non-record => fail OPEN in refuse mode. FIX 2
  // makes the private vault REFUSE TO SERVE the read when its active gate's
  // ledger cannot be journaled, rather than silently proceeding and letting
  // the later write-time scan read the resulting ENOENT as "nothing happened".
  it("VECTOR-3 (FIXED): unwritable ledger dir => the gated private read itself is refused, never silently unrecorded", async () => {
    const lockedDir = join(ledgerDir, "locked");
    mkdirSync(lockedDir, { recursive: true });
    const lockedLedger = join(lockedDir, "leak-ledger.jsonl");
    // Reconfigure both vaults to the locked ledger path.
    configureVault(
      privateVault,
      `visibility: private\nleak_gate:\n  session_ledger_path: "${lockedLedger}"\n  mode: refuse\n`,
    );
    configureVault(
      sharedVault,
      `visibility: shared\nleak_gate:\n  session_ledger_path: "${lockedLedger}"\n  mode: refuse\n`,
    );
    // Read-only dir: appendFile would => EACCES. FIX 2 checks writability
    // BEFORE serving the read and refuses rather than swallowing that error.
    chmodSync(lockedDir, 0o555);

    try {
      const r = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "run-failopen");
      console.log("[VECTOR-3] gated private read refused when ledger unwritable?", !r.ok);
      expect(r.ok).toBe(false);
      const recorded = existsSync(lockedLedger);
      console.log("[VECTOR-3] ledger file created?", recorded);

      // Since the private read never landed, a shared write under the SAME
      // run_id has nothing to correlate against either way — but the point
      // of the fix is that the read itself never silently proceeded
      // unrecorded, not that this particular write is blocked.
      const w = await vaultWrite(
        sharedVault,
        {
          path: "pricing/failopen.md",
          frontmatter: {
            title: "failopen",
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
          },
          body: SECRET_BODY,
          agent: "agent:claude-code",
          run_id: "run-failopen",
        },
        AGENT_ACCESS,
      );
      console.log("[VECTOR-3] shared write ok?", w.ok);
      expect(w.ok).toBe(true);
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  // VECTOR 6 — was: ledger appends even when the gate mode is off
  // (always-on, privacy hygiene hole). FIX 3(a) gates every append on the
  // SERVING vault's own leak_gate.mode !== "off"; FIX 3(b) drops the private
  // path from the entry shape entirely, so even an active-gate append never
  // carries it.
  it("VECTOR-6 (FIXED): mode: off records nothing; an active gate records no private path", async () => {
    // Private vault explicitly opts OUT (mode: off): no ledger entry at all.
    configureVault(
      privateVault,
      `visibility: private\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: off\n`,
    );
    const r = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "run-modeoff");
    expect(r.ok).toBe(true);
    const existsWhenOff = existsSync(ledgerPath);
    console.log("[VECTOR-6] ledger exists with mode off?", existsWhenOff);
    expect(existsWhenOff).toBe(false);

    // Private vault opts IN (mode: refuse): an entry is recorded, but it
    // never carries the private document's path or basename.
    configureVault(
      privateVault,
      `visibility: private\nleak_gate:\n  session_ledger_path: "${ledgerPath}"\n  mode: refuse\n`,
    );
    const r2 = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "run-modeon");
    expect(r2.ok).toBe(true);
    const exists = existsSync(ledgerPath);
    const contents = exists ? readFileSync(ledgerPath, "utf-8") : "";
    console.log(
      "[VECTOR-6] ledger records the private doc PATH when active?",
      contents.includes(PRIVATE_DOC),
    );
    expect(exists).toBe(true);
    expect(contents).not.toContain(PRIVATE_DOC);
    expect(contents).not.toContain("aurora-pipelines-vs-helios-connect");
    expect(contents).toContain('"visibility":"private"');
  });

  // VECTOR 2 — run_id omission is refused (control should hold).
  it("VECTOR-2: agent shared write with NO run_id is refused", async () => {
    const w = await vaultWrite(
      sharedVault,
      {
        path: "pricing/norunid.md",
        frontmatter: {
          title: "norunid",
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
        },
        body: "no run id",
        agent: "agent:claude-code",
        // no run_id
      },
      AGENT_ACCESS,
    );
    console.log("[VECTOR-2] no-run_id write refused?", !w.ok);
    expect(w.ok).toBe(false);
  });

  // VECTOR 5 + 4 — refusal names no private path; nothing partial lands.
  it("VECTOR-5/4: refusal reason + provenance carry no private path; no target file", async () => {
    const r = await vaultRead(privateVault, PRIVATE_DOC, AGENT_ACCESS, "run-pathleak");
    expect(r.ok).toBe(true);
    const w = await vaultWrite(
      sharedVault,
      {
        path: "pricing/pathleak.md",
        frontmatter: {
          title: "pathleak",
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
        },
        body: "x",
        agent: "agent:claude-code",
        run_id: "run-pathleak",
      },
      AGENT_ACCESS,
    );
    expect(w.ok).toBe(false);
    if (!w.ok) {
      console.log("[VECTOR-5] refusal reason:", w.error.message);
      expect(w.error.message).not.toContain("aurora");
      expect(w.error.message).not.toContain(PRIVATE_DOC);
    }
    // VECTOR 4: nothing partial on disk.
    expect(existsSync(join(sharedVault, "pricing/pathleak.md"))).toBe(false);
    // Provenance row exists (rejected_leak) but must not carry the private path.
    const prov = await readProvenanceLog(sharedVault);
    if (prov.ok) {
      const blob = JSON.stringify(prov.value);
      console.log("[VECTOR-4] provenance rejected_leak present?", blob.includes("rejected_leak"));
      expect(blob).not.toContain(PRIVATE_DOC);
    }
  });
});
