import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { recordProvenance } from "../../src/curation/provenance.js";
import { recordDecision, stageAction } from "../../src/curation/staged-actions.js";
import { vaultWitness, witnessTools } from "../../src/tools/witness.js";
import {
  buildWitness,
  stakeFor,
  WAGER_GONE_STAKE,
  WAGER_SURVIVAL_CREDIT,
} from "../../src/witness/track-record.js";

const TODAY = new Date().toISOString().slice(0, 10);

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

let vault: string;

function writeDoc(relPath: string, overrides: Record<string, string | number | null> = {}): void {
  const fm: Record<string, string | number | null> = {
    title: `Doc ${relPath}`,
    domain: "accumulation",
    collection: relPath.split("/")[0] ?? "",
    status: "canonical",
    confidence: "medium",
    created: TODAY,
    updated: TODAY,
    updated_by: "agent:test",
    provenance: "direct",
    superseded_by: null,
    ttl_days: 120,
    ...overrides,
  };
  const lines = Object.entries(fm).map(([k, v]) => {
    if (v === null) return `${k}: null`;
    return typeof v === "number" ? `${k}: ${v}` : `${k}: "${v}"`;
  });
  mkdirSync(join(vault, relPath.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(
    join(vault, relPath),
    `---\n${lines.join("\n")}\nsources: []\ntags: []\n---\n\nBody.\n`,
    "utf-8",
  );
}

async function logWrite(file: string, principal: string, action = "create", timestamp?: string) {
  const r = await recordProvenance(vault, {
    tool: "vault_write",
    file,
    agent: principal,
    action,
    principal,
    ...(timestamp ? { timestamp } : {}),
  });
  expect(r.ok).toBe(true);
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-witness-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("buildWitness", () => {
  it("prices the open book: live claims, exposure, contested stake at risk", async () => {
    writeDoc("pricing/high.md", { confidence: "high" });
    writeDoc("pricing/hedged.md", { confidence: "low" });
    await logWrite("pricing/high.md", "agent:alpha");
    await logWrite("pricing/hedged.md", "agent:alpha");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      join(vault, ".daftari", "tensions.md"),
      `## ${TODAY} — Dispute\n- **Id:** t-1\n- **Kind:** factual\n` +
        `- **Source A:** pricing/high.md says X.\n- **Source B:** pricing/hedged.md says Y.\n` +
        `- **Status:** unresolved\n- **Logged by:** agent:beta\n`,
      "utf-8",
    );

    const r = await buildWitness(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const alpha = r.value.principals.find((p) => p.principal === "agent:alpha");
    expect(alpha?.docsAuthored).toBe(2);
    expect(alpha?.liveClaims).toBe(2);
    expect(alpha?.openExposure).toBe(stakeFor("high") + stakeFor("low")); // 3 + 0
    expect(alpha?.contestedOpen).toBe(2); // both sides of t-1 are alpha's
    expect(alpha?.stakeAtRisk).toBe(3);
    const beta = r.value.principals.find((p) => p.principal === "agent:beta");
    expect(beta?.tensionsLogged).toBe(1);
  });

  it("settles the book: retired and corrected claims burn, survivors earn", async () => {
    // Lost by retirement.
    writeDoc("pricing/retired.md", { status: "deprecated", confidence: "high" });
    await logWrite("pricing/retired.md", "agent:alpha");
    // Lost by ruling: canonical doc, but a tension resolved 'corrected'.
    writeDoc("pricing/corrected.md", { confidence: "medium" });
    await logWrite("pricing/corrected.md", "agent:alpha");
    // Lost by deletion (gone doc — provenance only).
    await logWrite("pricing/vanished.md", "agent:alpha");
    // Survived: created two TTLs ago, freshly re-verified.
    writeDoc("pricing/veteran.md", { created: daysAgo(300), updated: TODAY, ttl_days: 120 });
    await logWrite("pricing/veteran.md", "agent:beta");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      join(vault, ".daftari", "tensions.md"),
      `## ${daysAgo(30)} — Settled dispute\n- **Id:** t-2\n- **Kind:** factual\n` +
        `- **Source A:** pricing/corrected.md says X.\n- **Source B:** pricing/veteran.md says Y.\n` +
        `- **Status:** resolved\n- **Logged by:** agent:beta\n` +
        `- **Resolved at:** ${TODAY}T00:00:00Z\n- **Resolved by:** human:test\n` +
        `- **Resolution kind:** corrected\n`,
      "utf-8",
    );

    const r = await buildWitness(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const alpha = r.value.principals.find((p) => p.principal === "agent:alpha");
    expect(alpha?.lost).toBe(3);
    expect(alpha?.burnedStake).toBe(stakeFor("high") + stakeFor("medium") + WAGER_GONE_STAKE);
    expect(alpha?.balance).toBe(-(alpha?.burnedStake ?? Number.NaN));
    const beta = r.value.principals.find((p) => p.principal === "agent:beta");
    // veteran is on the corrected tension too — but as sourceB it is ALSO
    // marked corrected; both sides of a corrected ruling settle. So beta's
    // veteran counts lost, not survived.
    expect(beta?.lost).toBe(1);
    expect(beta?.survived).toBe(0);
  });

  it("credits survival through a full TTL cycle", async () => {
    writeDoc("pricing/veteran.md", { created: daysAgo(300), updated: TODAY, ttl_days: 120 });
    await logWrite("pricing/veteran.md", "agent:beta");
    const r = await buildWitness(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const beta = r.value.principals.find((p) => p.principal === "agent:beta");
    expect(beta?.survived).toBe(1);
    expect(beta?.creditEarned).toBe(WAGER_SURVIVAL_CREDIT);
    expect(beta?.balance).toBe(WAGER_SURVIVAL_CREDIT);
  });

  it("tracks proposal outcomes per principal", async () => {
    writeDoc("pricing/doc.md");
    const a1 = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/doc.md",
      proposedBy: "agent:loop",
      rationale: "r",
      proposedDiff: {},
    });
    expect(a1.ok).toBe(true);
    if (!a1.ok) return;
    const a2 = await stageAction(vault, {
      actionType: "deprecate",
      targetPath: "pricing/doc.md",
      proposedBy: "agent:loop",
      rationale: "r",
      proposedDiff: {},
    });
    expect(a2.ok).toBe(true);
    if (!a2.ok) return;
    const dec = await recordDecision(vault, a1.value.id, {
      status: "rejected",
      ratifiedAt: new Date().toISOString(),
      ratifiedBy: "human:test",
    });
    expect(dec.ok).toBe(true);

    const r = await buildWitness(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const loop = r.value.principals.find((p) => p.principal === "agent:loop");
    expect(loop?.proposals).toEqual({ total: 2, ratified: 0, rejected: 1, expired: 0, pending: 1 });
  });

  it("raises the flat-curve warning when one principal holds ≥95% of writes", async () => {
    writeDoc("pricing/a.md");
    for (let i = 0; i < 20; i++) await logWrite("pricing/a.md", "agent:solo", "update");
    const r = await buildWitness(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.concentration.topPrincipal).toBe("agent:solo");
    expect(r.value.concentration.topShare).toBe(1);
    expect(r.value.flatCurveWarning).toBe(true);
  });

  it("counts docs with no provenance as unattributed, on nobody's record", async () => {
    writeDoc("pricing/orphan.md");
    const r = await buildWitness(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unattributedDocs).toBe(1);
    expect(r.value.principals).toEqual([]);
  });

  it("scopes everything to readable collections under RBAC", async () => {
    writeDoc("pricing/open.md");
    writeDoc("moonshot/secret.md");
    await logWrite("pricing/open.md", "agent:alpha");
    await logWrite("moonshot/secret.md", "agent:alpha");
    const analyst: AccessContext = {
      user: "human:test",
      roleName: "analyst",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const r = await buildWitness(vault, new Date(), analyst);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const alpha = r.value.principals.find((p) => p.principal === "agent:alpha");
    expect(alpha?.writes).toBe(1); // the moonshot write is invisible
    expect(alpha?.docsAuthored).toBe(1);
  });
});

describe("vaultWitness tool", () => {
  it("fetches a single principal and errors on an unknown one", async () => {
    writeDoc("pricing/a.md");
    await logWrite("pricing/a.md", "agent:alpha");
    const one = await vaultWitness(vault, { principal: "agent:alpha" });
    expect(one.ok).toBe(true);
    const miss = await vaultWitness(vault, { principal: "agent:nobody" });
    expect(miss.ok).toBe(false);
  });

  it("denies a role with no read access", async () => {
    const guest: AccessContext = { user: "guest", roleName: "guest", role: null };
    const r = await vaultWitness(vault, {}, guest);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("access denied");
  });

  it("registers as a read-only tool", () => {
    const def = witnessTools.find((t) => t.name === "vault_witness");
    expect(def?.annotations?.readOnlyHint).toBe(true);
  });
});
