// Validity on the read surfaces: vault_read's per-document report, and
// vault_status's adoption monitor.
//
// Both are additive. A document with no authored interval reads exactly as it
// did before this feature — `validity: null`, the same nothing-to-say contract
// `decay` follows.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { vaultRead, vaultStatus } from "../../src/tools/read.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function frontmatter(over: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    title: "Plan Pro pricing",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-01-05",
    updated: "2026-01-05",
    updated_by: "agent:test",
    provenance: "direct",
    ...over,
  };
  const lines = Object.entries(base).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\ntags: []\n---\n\nPlan Pro was 49 USD per seat.\n`;
}

describe("vault_read — validity", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("returns null for a document with no authored interval", async () => {
    writeFileSync(join(vault, "pricing/no-validity.md"), frontmatter());
    const r = await vaultRead(vault, "pricing/no-validity.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.validity).toBeNull();
  });

  it("reports an open-ended interval as valid", async () => {
    writeFileSync(join(vault, "pricing/current.md"), frontmatter({ valid_from: "2020-01-01" }));
    const r = await vaultRead(vault, "pricing/current.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.validity?.state).toBe("valid");
    expect(r.value.validity?.from).toBe("2020-01-01");
    expect(r.value.validity?.banner).toBeNull();
  });

  it("banners a document whose validity has ended", async () => {
    writeFileSync(
      join(vault, "pricing/old.md"),
      frontmatter({ valid_from: "2020-01-01", valid_until: "2020-12-31" }),
    );
    const r = await vaultRead(vault, "pricing/old.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.validity?.state).toBe("expired");
    expect(r.value.validity?.banner).toContain("⚠ STALE");
  });

  it("leaves decay untouched — validity is a separate signal", async () => {
    // A doc with expired validity but no TTL and a canonical status is not
    // decayed. If this starts returning a DecayState, validity has leaked into
    // the decay path and consolidate/admit.ts will start refusing edges.
    writeFileSync(
      join(vault, "pricing/old.md"),
      frontmatter({ valid_from: "2020-01-01", valid_until: "2020-12-31" }),
    );
    const r = await vaultRead(vault, "pricing/old.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.validity?.state).toBe("expired");
    expect(r.value.decay).toBeNull();
  });
});

describe("vault_status — validityCoverage", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("counts every document as unknown before any interval is authored", async () => {
    const r = await vaultStatus(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cov = r.value.validityCoverage;
    expect(cov.authored).toBe(0);
    expect(cov.total).toBeGreaterThan(0);
    expect(cov.unknown).toBe(cov.total);
  });

  it("counts a document with either endpoint as authored", async () => {
    writeFileSync(join(vault, "pricing/a.md"), frontmatter({ valid_from: "2026-01-01" }));
    writeFileSync(join(vault, "pricing/b.md"), frontmatter({ valid_until: "2026-01-01" }));
    const r = await vaultStatus(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.validityCoverage.authored).toBe(2);
  });

  it("authored + unknown always equals total", async () => {
    writeFileSync(join(vault, "pricing/a.md"), frontmatter({ valid_from: "2026-01-01" }));
    const r = await vaultStatus(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cov = r.value.validityCoverage;
    expect(cov.authored + cov.unknown).toBe(cov.total);
  });

  it("reports over the caller's visible set only", async () => {
    // Mirrors stalenessDistribution: an unreadable collection must not
    // contribute to the denominator, or the count leaks vault size.
    writeFileSync(join(vault, "pricing/a.md"), frontmatter({ valid_from: "2026-01-01" }));
    const analyst: AccessContext = {
      user: "human:test",
      roleName: "analyst",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const scoped = await vaultStatus(vault, analyst);
    const unscoped = await vaultStatus(vault);
    expect(scoped.ok && unscoped.ok).toBe(true);
    if (!scoped.ok || !unscoped.ok) return;
    expect(scoped.value.validityCoverage.total).toBeLessThan(unscoped.value.validityCoverage.total);
    expect(scoped.value.validityCoverage.total).toBe(scoped.value.stalenessDistribution.total);
  });
});
