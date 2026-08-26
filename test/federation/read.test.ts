// Federated vault_read and the vault_status federation block (#297, spec
// Decision 5): documents cross the mount boundary, vault state does not.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMountRegistry, loadMounts, setMountRegistry } from "../../src/federation/mounts.js";
import { vaultRead, vaultStatus } from "../../src/tools/read.js";
import { clearConfigCache } from "../../src/utils/config.js";

let base: string;
let canonical: string;

const REF_CONFIG = `
roles:
  researcher:
    read: ["pricing"]
schema_extensions:
  region:
    type: string
    required: true
federation:
  principals:
    "human:mihir": { role: researcher }
`;

const PRICING_DOC = `---
title: Plan Pro pricing
domain: accumulation
collection: pricing
status: canonical
confidence: high
created: 2026-01-05
updated: 2026-08-01
updated_by: human:ref-owner
provenance: direct
region: emea
---

Plan Pro costs $40/month.
`;

const SECRET_DOC = `---
title: Hidden strategy
domain: accumulation
collection: strategy
status: canonical
confidence: high
created: 2026-01-05
updated: 2026-08-01
updated_by: human:ref-owner
provenance: direct
---

Not for the mounting principal.
`;

async function mountRef(user: string): Promise<void> {
  const registry = await loadMounts(
    canonical,
    {
      mounts: [{ alias: "research", path: join(base, "ref"), index: "full", optional: false }],
      principals: {},
    },
    user,
    () => {},
  );
  if (!registry.ok) throw registry.error;
  setMountRegistry(registry.value);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "daftari-fedread-"));
  canonical = join(base, "canonical");
  mkdirSync(join(canonical, ".daftari"), { recursive: true });
  writeFileSync(join(canonical, ".daftari", "config.yaml"), "roles: {}\n");

  const ref = join(base, "ref");
  mkdirSync(join(ref, ".daftari"), { recursive: true });
  writeFileSync(join(ref, ".daftari", "config.yaml"), REF_CONFIG);
  mkdirSync(join(ref, "pricing"), { recursive: true });
  writeFileSync(join(ref, "pricing", "plan-pro.md"), PRICING_DOC);
  mkdirSync(join(ref, "strategy"), { recursive: true });
  writeFileSync(join(ref, "strategy", "hidden.md"), SECRET_DOC);
  clearConfigCache();
});

afterEach(() => {
  clearMountRegistry();
  clearConfigCache();
  rmSync(base, { recursive: true, force: true });
});

describe("federated vault_read", () => {
  it("reads a mount document the granted role can see, documents-only shape", async () => {
    await mountRef("human:mihir");
    const result = await vaultRead(canonical, "research:pricing/plan-pro.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vault).toBe("research");
    expect(result.value.path).toBe("research:pricing/plan-pro.md");
    expect(result.value.content).toContain("$40/month");
    expect(result.value.frontmatter.title).toBe("Plan Pro pricing");
    // The referenced vault's schema_extensions govern the advisory report:
    // `region` is declared there, so the doc validates clean.
    expect(result.value.validation.valid).toBe(true);
    // Vault state is not federated: every state channel is silent.
    expect(result.value.decay).toBeNull();
    expect(result.value.validity).toBeNull();
    expect(result.value.upstream_staleness).toBeNull();
    expect(result.value.structural).toBeNull();
    expect(result.value.anchors).toBeNull();
    expect(result.value.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates against the REFERENCED vault's extensions (missing required ext fails)", async () => {
    writeFileSync(
      join(base, "ref", "pricing", "no-region.md"),
      PRICING_DOC.replace("region: emea\n", ""),
    );
    await mountRef("human:mihir");
    const result = await vaultRead(canonical, "research:pricing/no-region.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.valid).toBe(false);
    expect(result.value.validation.issues.map((i) => i.field)).toContain("region");
  });

  it("labels distill provenance on a readable mounted document", async () => {
    writeFileSync(
      join(base, "ref", "pricing", "distilled.md"),
      PRICING_DOC.replace(
        "provenance: direct\n",
        'provenance: synthesized\nsources: ["distill:session-42#claim-7"]\n',
      ),
    );
    await mountRef("human:mihir");
    const result = await vaultRead(canonical, "research:pricing/distilled.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source_verifiability).toEqual([
      {
        source: "distill:session-42#claim-7",
        status: "born-unverifiable",
        reason:
          "external source, discarded by design — re-derivation means re-presenting the source",
      },
    ]);
  });

  it("denies a collection outside the granted role's read list", async () => {
    await mountRef("human:mihir");
    const result = await vaultRead(canonical, "research:strategy/hidden.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("access denied");
    expect(result.error.message).toContain("'researcher'");
  });

  it("denies everything for an unmapped principal (guest)", async () => {
    await mountRef("human:stranger");
    const result = await vaultRead(canonical, "research:pricing/plan-pro.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("access denied");
  });

  it("confines mount paths to the mount root", async () => {
    await mountRef("human:mihir");
    const result = await vaultRead(canonical, "research:../canonical/whatever.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("escapes vault root");
  });

  it("treats a ':'-containing path with no matching alias as canonical", async () => {
    await mountRef("human:mihir");
    writeFileSync(join(canonical, "notes:pricing.md"), "# plain canonical file\n");
    const result = await vaultRead(canonical, "notes:pricing.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vault).toBe("local");
  });

  it("stamps canonical reads with vault: local", async () => {
    writeFileSync(join(canonical, "note.md"), "# note\n");
    const result = await vaultRead(canonical, "note.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vault).toBe("local");
  });
});

describe("vault_status federation block", () => {
  it("reports per-mount state with readable-subset counts only", async () => {
    await mountRef("human:mihir");
    const result = await vaultStatus(canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.federation).toHaveLength(1);
    const mount = result.value.federation?.[0];
    expect(mount?.alias).toBe("research");
    expect(mount?.state).toBe("ok");
    // Two docs exist in the mount; only the pricing one is readable.
    expect(mount?.readableDocCount).toBe(1);
    expect(mount?.lastRefresh).toBeNull();
  });

  it("reports zero readable docs for a guest-resolved principal", async () => {
    await mountRef("human:stranger");
    const result = await vaultStatus(canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.federation?.[0]?.readableDocCount).toBe(0);
  });

  it("omits the block entirely when federation is not configured", async () => {
    const result = await vaultStatus(canonical);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.federation).toBeUndefined();
  });
});
