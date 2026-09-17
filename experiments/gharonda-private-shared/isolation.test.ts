// U2 — the catastrophic-leak test (Gharonda spike).
//
// U1 proved the three sovereign vaults' configs load and encode the
// 1Password-style private/shared policy. This unit proves the runtime
// consequence: acting AS human:alice, with BOTH `shared` and `bob` declared
// as federation mounts in her view, the assistant can read
// alice-private ∪ shared but by NO path — not a direct alias read, not
// search, not the mount merely being declared — can it read bob-private.
// A write-shaped tool targeting a mount is refused, and alice's process
// creates no derived state (index/WAL/lock) under either referenced root.
//
// Real in-process pattern, mirrored (not invented) from:
//   - test/federation/read.test.ts   (loadMounts + setMountRegistry + vaultRead)
//   - test/federation/search.test.ts (vaultSearch with an AccessContext)
//   - test/federation/classification.test.ts (scanArgsForFederatedPath +
//     federatedRefusal for the write-shaped-tool refusal, which server.ts
//     applies at dispatch — vault_write/vault_assert know nothing of
//     federation themselves)

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { federatedRefusal, scanArgsForFederatedPath } from "../../src/federation/classification.js";
import { clearMountRegistry, loadMounts, setMountRegistry } from "../../src/federation/mounts.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultSearch } from "../../src/tools/search.js";
import { clearConfigCache } from "../../src/utils/config.js";

const VAULTS_ROOT = join(__dirname, "vaults");
const ALICE_ROOT = join(VAULTS_ROOT, "alice-private");
const BOB_ROOT = join(VAULTS_ROOT, "bob-private");
const SHARED_ROOT = join(VAULTS_ROOT, "shared");

// Matches alice-private's own config.yaml `roles: owner: { read: ["*"], ... }`
// — the LOCAL role for alice's canonical vault, distinct from the per-mount
// role her principal resolves to against each referenced vault's policy.
const ALICE_ACCESS: AccessContext = {
  user: "human:alice",
  roleName: "owner",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

async function mountAliceView(): Promise<void> {
  const registry = await loadMounts(
    ALICE_ROOT,
    {
      mounts: [
        { alias: "shared", path: SHARED_ROOT, index: "full", optional: false },
        { alias: "bob", path: BOB_ROOT, index: "full", optional: false },
      ],
      principals: {},
    },
    "human:alice",
    () => {},
  );
  if (!registry.ok) throw registry.error;
  setMountRegistry(registry.value);
}

// Snapshot of everything under a vault's .daftari/ dir, recursively, so U2
// can prove alice's process creates nothing new there (spec: federation
// takes no process lock on a mount; a federated reader only reads markdown).
function snapshotDaftariDir(vaultRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(join(vaultRoot, ".daftari"), "");
  return out.sort();
}

beforeEach(async () => {
  clearConfigCache();
  await mountAliceView();
});

afterEach(() => {
  clearMountRegistry();
  clearConfigCache();
});

describe("U2 catastrophic-leak test — alice's view (shared + bob both mounted)", () => {
  it("1. reads an alice-private doc, including ALICE_SECRET_CANARY", async () => {
    const result = await vaultRead(ALICE_ROOT, "therapy-notes.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain("ALICE_SECRET_CANARY");
  });

  it("2. reads shared:<doc>, including SHARED_HOUSEHOLD_FACT", async () => {
    const result = await vaultRead(ALICE_ROOT, "shared:household-budget.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vault).toBe("shared");
    expect(result.value.content).toContain("SHARED_HOUSEHOLD_FACT");
  });

  describe("3. bob:<doc> is DENIED — the catastrophic-leak case", () => {
    it("direct alias read of bob's gift-ideas doc is denied, canary never returned", async () => {
      const result = await vaultRead(ALICE_ROOT, "bob:gift-ideas.md");
      expect(result.ok).toBe(false);
      if (result.ok) {
        // If this branch is ever reached, isolation has failed — assert
        // loudly rather than silently passing.
        expect(result.value.content).not.toContain("BOB_SECRET_CANARY");
        throw new Error(
          `LEAK: bob:gift-ideas.md was readable by alice — got content: ${result.value.content}`,
        );
      }
      expect(result.error.message).toContain("access denied");
    });

    it("direct alias read of bob's health-notes doc is denied, canary never returned", async () => {
      const result = await vaultRead(ALICE_ROOT, "bob:health-notes.md");
      expect(result.ok).toBe(false);
      if (result.ok) {
        expect(result.value.content).not.toContain("BOB_SECRET_CANARY");
        throw new Error(
          `LEAK: bob:health-notes.md was readable by alice — got content: ${result.value.content}`,
        );
      }
      expect(result.error.message).toContain("access denied");
    });

    it("the mount being DECLARED does not itself grant access — resolves to deny-all guest", async () => {
      // bob-private's federation.principals has no entry for human:alice, so
      // loadMounts resolves her to the guest role for this mount even though
      // the mount is declared and loaded successfully (state: "ok").
      const { getMountRegistry } = await import("../../src/federation/mounts.js");
      const registry = getMountRegistry();
      const bobMount = registry?.mounts.get("bob");
      expect(bobMount?.state).toBe("ok"); // declared and loaded
      expect(bobMount?.role).toBeNull(); // but resolved to deny-all guest
      expect(bobMount?.roleName).toBe("guest");
    });
  });

  describe("4. vault_search for CANARY/SECRET — alice+shared hits only", () => {
    it("returns alice-private and shared hits; bob's canary never appears", async () => {
      const result = await vaultSearch(ALICE_ROOT, { query: "CANARY" }, ALICE_ACCESS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // At minimum (per task spec): bob's canary must never surface, in path
      // or snippet, regardless of whether cross-mount search ranks it.
      const anyBobCanary = result.value.hits.some(
        (h) => h.path.includes("bob:") || h.snippet.includes("BOB_SECRET_CANARY"),
      );
      expect(anyBobCanary).toBe(false);

      // Cross-mount search IS wired in this daftari version (see
      // test/federation/search.test.ts "fuses hits from the local vault and
      // the mount"): the shared mount's hits should surface alongside local.
      const vaults = new Set(result.value.hits.map((h) => h.vault ?? "local"));
      expect(vaults.has("local")).toBe(true);
      expect(vaults.has("shared")).toBe(true);
      expect(vaults.has("bob")).toBe(false);
    });

    it("returns zero hits scoped to vaults: ['bob'] — the mount contributes nothing readable", async () => {
      const result = await vaultSearch(
        ALICE_ROOT,
        { query: "CANARY", vaults: ["bob"] },
        ALICE_ACCESS,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBe(0);
    });
  });

  describe("5. write-shaped tools targeting a mount are refused", () => {
    it("vault_write to shared:... is refused with the uniform read-only copy", async () => {
      const { getMountRegistry } = await import("../../src/federation/mounts.js");
      const registry = getMountRegistry();
      if (!registry) throw new Error("registry not loaded");
      const fed = scanArgsForFederatedPath({ path: "shared:household-budget.md" }, registry);
      expect(fed?.alias).toBe("shared");
      const refusal = federatedRefusal("vault_write", fed?.raw ?? "");
      expect(refusal).toBe(
        'federated mount is read-only: "shared:household-budget.md" — ' +
          "writes apply only to the local vault",
      );
    });

    it("vault_assert (source_a) to bob:... is refused with the uniform read-only copy", async () => {
      const { getMountRegistry } = await import("../../src/federation/mounts.js");
      const registry = getMountRegistry();
      if (!registry) throw new Error("registry not loaded");
      const fed = scanArgsForFederatedPath({ source_a: "bob:gift-ideas.md" }, registry);
      expect(fed?.alias).toBe("bob");
      const refusal = federatedRefusal("vault_assert", fed?.raw ?? "");
      expect(refusal).toBe(
        'federated mount is read-only: "bob:gift-ideas.md" — writes apply only to the local vault',
      );
    });
  });

  it("6. alice's process creates no derived state under bob-private/ or shared/", async () => {
    const bobBefore = snapshotDaftariDir(BOB_ROOT);
    const sharedBefore = snapshotDaftariDir(SHARED_ROOT);

    // Exercise every read/search vector above once more, in this test, so
    // the snapshot brackets real activity.
    await vaultRead(ALICE_ROOT, "shared:household-budget.md");
    await vaultRead(ALICE_ROOT, "bob:gift-ideas.md");
    await vaultSearch(ALICE_ROOT, { query: "CANARY" }, ALICE_ACCESS);

    const bobAfter = snapshotDaftariDir(BOB_ROOT);
    const sharedAfter = snapshotDaftariDir(SHARED_ROOT);

    // Only the checked-in config.yaml should ever exist under either
    // referenced vault's .daftari/ — no index db, WAL, or lock file. Any
    // derived state for a mount is redirected into the CANONICAL vault's
    // .daftari/federation/<alias>/ (src/federation/mounts.ts mountIndexDir),
    // never opened-for-write under the referenced root itself.
    expect(bobBefore).toEqual(["config.yaml"]);
    expect(sharedBefore).toEqual(["config.yaml"]);
    expect(bobAfter).toEqual(bobBefore);
    expect(sharedAfter).toEqual(sharedBefore);
  });
});
