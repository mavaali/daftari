// Federated search (#297, spec Decision 4): per-vault pipelines under each
// vault's own policy, RRF fusion across the final rank lists, alias-prefixed
// round-trippable paths, and the `vaults` scope parameter.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { clearMountRegistry, loadMounts, setMountRegistry } from "../../src/federation/mounts.js";
import type { HybridSearchResult } from "../../src/search/hybrid.js";
import { vaultIndexMount, vaultRead } from "../../src/tools/read.js";
import { vaultReindex, vaultSearch, vaultSearchRelated } from "../../src/tools/search.js";
import { clearConfigCache } from "../../src/utils/config.js";

let base: string;
let canonical: string;
let refRoot: string;

const REF_CONFIG = `
schema_extensions:
  priority:
    type: number
indexed_fields: [priority]
roles:
  researcher:
    read: ["pricing"]
federation:
  principals:
    "human:mihir": { role: researcher }
`;

function doc(title: string, collection: string, body: string, priority = 2): string {
  return `---
title: ${title}
domain: accumulation
collection: ${collection}
status: canonical
confidence: high
created: 2026-01-05
updated: 2026-08-01
updated_by: human:owner
provenance: direct
priority: ${priority}
---

${body}
`;
}

const LOCAL_ANALYST: AccessContext = {
  user: "human:mihir",
  roleName: "analyst",
  role: { read: ["*"], write: [], promote: false, ratify: false },
};

async function mountRef(): Promise<void> {
  const registry = await loadMounts(
    canonical,
    {
      mounts: [{ alias: "research", path: refRoot, index: "lexical", optional: false }],
      principals: {},
    },
    "human:mihir",
    () => {},
  );
  if (!registry.ok) throw registry.error;
  setMountRegistry(registry.value);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "daftari-fedsearch-"));
  canonical = join(base, "canonical");
  mkdirSync(join(canonical, ".daftari"), { recursive: true });
  writeFileSync(
    join(canonical, ".daftari", "config.yaml"),
    "schema_extensions:\n  priority:\n    type: number\nindexed_fields: [priority]\nroles: {}\n",
  );
  mkdirSync(join(canonical, "notes"), { recursive: true });
  writeFileSync(
    join(canonical, "notes", "zephyr-local.md"),
    doc("Zephyr rollout", "notes", "The zephyrmark rollout plan for the local team."),
  );

  refRoot = join(base, "ref");
  mkdirSync(join(refRoot, ".daftari"), { recursive: true });
  writeFileSync(join(refRoot, ".daftari", "config.yaml"), REF_CONFIG);
  mkdirSync(join(refRoot, "pricing"), { recursive: true });
  writeFileSync(
    join(refRoot, "pricing", "zephyr-pricing.md"),
    doc("Zephyr pricing", "pricing", "The zephyrmark price is $40/month."),
  );
  mkdirSync(join(refRoot, "strategy"), { recursive: true });
  writeFileSync(
    join(refRoot, "strategy", "zephyr-secret.md"),
    doc("Zephyr strategy", "strategy", "The zephyrmark exit strategy — restricted."),
  );
  clearConfigCache();
});

afterEach(() => {
  clearMountRegistry();
  clearConfigCache();
  rmSync(base, { recursive: true, force: true });
});

describe("federated vault_search", () => {
  it("validates and applies a shared filter in every selected vault", async () => {
    await mountRef();
    const result = await vaultSearch(
      canonical,
      { filters: [{ field: "priority", op: "gte", value: 2 }] },
      LOCAL_ANALYST,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vectorUsed).toBe(false);
    expect(result.value.hits.map((hit) => hit.path)).toEqual(
      expect.arrayContaining(["notes/zephyr-local.md", "research:pricing/zephyr-pricing.md"]),
    );
    expect(result.value.hits.some((hit) => hit.path.includes("zephyr-secret"))).toBe(false);
  });

  it("fails if any selected vault lacks the field but local-only remains usable", async () => {
    writeFileSync(
      join(refRoot, ".daftari", "config.yaml"),
      `roles:\n  researcher:\n    read: ["pricing"]\nfederation:\n  principals:\n    "human:mihir": { role: researcher }\n`,
    );
    clearConfigCache();
    await mountRef();
    const all = await vaultSearch(
      canonical,
      { filters: [{ field: "priority", op: "eq", value: 2 }] },
      LOCAL_ANALYST,
    );
    expect(all.ok).toBe(false);
    if (!all.ok) {
      expect(all.error.message).toContain('mount "research"');
      expect(all.error.message).toContain("field 'priority' is not indexed");
    }

    const local = await vaultSearch(
      canonical,
      {
        filters: [{ field: "priority", op: "eq", value: 2 }],
        vaults: ["local"],
      },
      LOCAL_ANALYST,
    );
    expect(local.ok).toBe(true);
    if (local.ok) expect(local.value.hits.every((hit) => hit.vault === "local")).toBe(true);
  });

  it("fuses hits from the local vault and the mount, labeled and addressable", async () => {
    await mountRef();
    const result = await vaultSearch(canonical, { query: "zephyrmark" }, LOCAL_ANALYST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const vaults = new Set(result.value.hits.map((h) => h.vault));
    expect(vaults).toContain("local");
    expect(vaults).toContain("research");

    const mountHit = result.value.hits.find((h) => h.vault === "research");
    expect(mountHit?.path).toBe("research:pricing/zephyr-pricing.md");
    // Round-trip: the returned path reads directly.
    const read = await vaultRead(canonical, mountHit?.path ?? "");
    expect(read.ok).toBe(true);

    // The strategy doc exists in the mount but the granted role cannot read
    // it — omission, not redaction.
    expect(result.value.hits.some((h) => h.path.includes("zephyr-secret"))).toBe(false);
  });

  it("scopes with the vaults parameter and refuses unknown aliases", async () => {
    await mountRef();

    const localOnly = await vaultSearch(
      canonical,
      { query: "zephyrmark", vaults: ["local"] },
      LOCAL_ANALYST,
    );
    expect(localOnly.ok).toBe(true);
    if (localOnly.ok) {
      expect(localOnly.value.hits.every((h) => h.vault === "local")).toBe(true);
      expect(localOnly.value.hits.length).toBeGreaterThan(0);
    }

    const mountOnly = await vaultSearch(
      canonical,
      { query: "zephyrmark", vaults: ["research"] },
      LOCAL_ANALYST,
    );
    expect(mountOnly.ok).toBe(true);
    if (mountOnly.ok) {
      expect(mountOnly.value.hits.every((h) => h.vault === "research")).toBe(true);
      expect(mountOnly.value.hits.length).toBeGreaterThan(0);
    }

    const unknown = await vaultSearch(
      canonical,
      { query: "zephyrmark", vaults: ["nope"] },
      LOCAL_ANALYST,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.message).toContain('unknown mount alias "nope"');
  });

  it("refuses the vaults parameter when federation is not configured", async () => {
    const result = await vaultSearch(
      canonical,
      { query: "zephyrmark", vaults: ["research"] },
      LOCAL_ANALYST,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("requires federation to be configured");
  });

  it("keeps canonical-only behavior when federation is off, plus the local label", async () => {
    const result = await vaultSearch(canonical, { query: "zephyrmark" }, LOCAL_ANALYST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.length).toBeGreaterThan(0);
    expect(result.value.hits.every((h) => h.vault === "local")).toBe(true);
  });

  it("builds the rerank pool from the fused cross-vault ranking", async () => {
    await mountRef();
    const result = (await vaultSearch(
      canonical,
      { query: "zephyrmark", rerank_candidates: 5 },
      LOCAL_ANALYST,
    )) as { ok: true; value: HybridSearchResult };
    expect(result.ok).toBe(true);
    const pool = result.value.rerank?.candidates ?? [];
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.some((c) => c.path.startsWith("research:"))).toBe(true);
  });
});

describe("federated vault_search_related", () => {
  it("seeds from a mount document and ranks candidates across the scope", async () => {
    await mountRef();
    const result = await vaultSearchRelated(
      canonical,
      { path: "research:pricing/zephyr-pricing.md" },
      LOCAL_ANALYST,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The seed itself is excluded; the related local doc surfaces.
    expect(result.value.hits.some((h) => h.path === "research:pricing/zephyr-pricing.md")).toBe(
      false,
    );
    expect(result.value.hits.some((h) => h.vault === "local")).toBe(true);
  });

  it("refuses a mount seed the granted role cannot read", async () => {
    await mountRef();
    const result = await vaultSearchRelated(
      canonical,
      { path: "research:strategy/zephyr-secret.md" },
      LOCAL_ANALYST,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("access denied");
  });

  it("seeds locally and pulls related mount candidates into the pool", async () => {
    await mountRef();
    const result = await vaultSearchRelated(
      canonical,
      { path: "notes/zephyr-local.md" },
      LOCAL_ANALYST,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hits.some((h) => h.vault === "research")).toBe(true);
  });
});

describe("federated vault_reindex and vault_index", () => {
  it("vault_reindex {vault} rebuilds one mount and reports its alias", async () => {
    await mountRef();
    const result = await vaultReindex(canonical, { mount: "research" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vault).toBe("research");
    expect(result.value.documentCount).toBe(2);
    expect(result.value.vectorEnabled).toBe(false); // index: lexical

    const unknown = await vaultReindex(canonical, { mount: "nope" });
    expect(unknown.ok).toBe(false);
  });

  it("vault_index lists a mount's readable subset with addressable paths", async () => {
    await mountRef();
    const registry = (await import("../../src/federation/mounts.js")).getMountRegistry();
    const mount = registry?.mounts.get("research");
    if (!mount) throw new Error("mount not loaded");

    const result = await vaultIndexMount(mount);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Two docs exist; only pricing is readable by the granted role.
    expect(result.value.count).toBe(1);
    expect(result.value.entries[0]?.path).toBe("research:pricing/zephyr-pricing.md");
    expect(result.value.entries[0]?.vault).toBe("research");
  });
});
