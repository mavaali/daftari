// Per-mount index lifecycle (#297, spec Decision 3): the index-location
// redirect keeps every derived byte under the canonical vault, `index:
// lexical` skips embeddings, and the referenced vault's `.daftari` state is
// never ingested.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMountIndexFresh, reindexMount } from "../../src/federation/mount-index.js";
import {
  clearMountRegistry,
  loadMounts,
  type MountRegistry,
  setMountRegistry,
} from "../../src/federation/mounts.js";
import { indexDbPath } from "../../src/storage/index-db.js";
import { clearConfigCache } from "../../src/utils/config.js";

let base: string;
let canonical: string;
let refRoot: string;

const REF_CONFIG = `
roles:
  researcher:
    read: ["pricing"]
federation:
  principals:
    "human:mihir": { role: researcher }
`;

function doc(title: string, body: string): string {
  return `---
title: ${title}
domain: accumulation
collection: pricing
status: canonical
confidence: high
created: 2026-01-05
updated: 2026-08-01
updated_by: human:ref-owner
provenance: direct
---

${body}
`;
}

async function mountRef(indexMode: "full" | "lexical" = "full"): Promise<MountRegistry> {
  const registry = await loadMounts(
    canonical,
    {
      mounts: [{ alias: "research", path: refRoot, index: indexMode, optional: false }],
      principals: {},
    },
    "human:mihir",
    () => {},
  );
  if (!registry.ok) throw registry.error;
  setMountRegistry(registry.value);
  return registry.value;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "daftari-fedidx-"));
  canonical = join(base, "canonical");
  mkdirSync(join(canonical, ".daftari"), { recursive: true });
  writeFileSync(join(canonical, ".daftari", "config.yaml"), "roles: {}\n");

  refRoot = join(base, "ref");
  mkdirSync(join(refRoot, ".daftari"), { recursive: true });
  writeFileSync(join(refRoot, ".daftari", "config.yaml"), REF_CONFIG);
  mkdirSync(join(refRoot, "pricing"), { recursive: true });
  writeFileSync(join(refRoot, "pricing", "plan-pro.md"), doc("Plan Pro", "Costs $40/month."));
  clearConfigCache();
});

afterEach(() => {
  clearMountRegistry();
  clearConfigCache();
  rmSync(base, { recursive: true, force: true });
});

describe("per-mount index location", () => {
  it("redirects the mount's index under the canonical .daftari/federation/<alias>/", async () => {
    // lexical: the location property under test is independent of embeddings,
    // and a full-mode build would try to load the model (unavailable offline).
    const registry = await mountRef("lexical");
    const mount = registry.mounts.get("research");
    if (!mount || mount.root === null) throw new Error("mount not loaded");

    expect(indexDbPath(mount.root)).toBe(
      join(canonical, ".daftari", "federation", "research", "index.db"),
    );

    const result = await reindexMount(mount);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documentCount).toBe(1);

    // The db landed in the canonical tree…
    expect(existsSync(join(canonical, ".daftari", "federation", "research", "index.db"))).toBe(
      true,
    );
    // …and NOTHING was created under the referenced root's .daftari — no
    // index.db and no WAL sidecars. Only the config we wrote is there.
    expect(readdirSync(join(refRoot, ".daftari"))).toEqual(["config.yaml"]);
  });

  it("index: lexical skips the embedding pass (vectors off, FTS rows present)", async () => {
    const registry = await mountRef("lexical");
    const mount = registry.mounts.get("research");
    if (!mount) throw new Error("mount not loaded");

    const result = await reindexMount(mount);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vectorEnabled).toBe(false);
    expect(result.value.embeddedCount).toBe(0);
    expect(result.value.chunkCount).toBeGreaterThan(0);
  });

  it("ensureMountIndexFresh builds once, then no-ops while the mount is unchanged", async () => {
    const registry = await mountRef("lexical");
    const mount = registry.mounts.get("research");
    if (!mount) throw new Error("mount not loaded");

    const first = await ensureMountIndexFresh(mount);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).not.toBeNull(); // built

    const second = await ensureMountIndexFresh(mount);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toBeNull(); // fresh — no rebuild

    // An out-of-band edit to the mount drifts the manifest; the next ensure
    // rebuilds (the vault_reindex / startup path).
    writeFileSync(join(refRoot, "pricing", "plan-max.md"), doc("Plan Max", "Costs $90/month."));
    const third = await ensureMountIndexFresh(mount);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value).not.toBeNull();
    expect(third.value?.documentCount).toBe(2);
  });
});
