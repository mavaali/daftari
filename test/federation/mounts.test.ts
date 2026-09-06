// Mount loading (#297, spec Decisions 1-3): fail-loud validation, principal
// resolution against the referenced vault's own config (deny-all-guest
// default), and the alias-prefix collision scan.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearMountRegistry,
  federatedPathOf,
  loadMounts,
  type MountRegistry,
  parseFederatedPath,
} from "../../src/federation/mounts.js";
import { clearConfigCache, type FederationConfig } from "../../src/utils/config.js";

let base: string;
let canonical: string;

function makeVault(name: string, config: string, docs: Record<string, string> = {}): string {
  const root = join(base, name);
  mkdirSync(join(root, ".daftari"), { recursive: true });
  writeFileSync(join(root, ".daftari", "config.yaml"), config);
  for (const [rel, body] of Object.entries(docs)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const REF_CONFIG = `
roles:
  researcher:
    read: ["pricing"]
federation:
  principals:
    "human:mihir": { role: researcher }
    "human:broken": { role: no-such-role }
`;

function mountsOf(aliasToPath: Record<string, string>, optional = false): FederationConfig {
  return {
    mounts: Object.entries(aliasToPath).map(([alias, path]) => ({
      alias,
      path,
      index: "full" as const,
      optional,
    })),
    principals: {},
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "daftari-fed-"));
  canonical = makeVault("canonical", "roles: {}\n");
  clearConfigCache();
});

afterEach(() => {
  clearMountRegistry();
  clearConfigCache();
  rmSync(base, { recursive: true, force: true });
});

describe("loadMounts", () => {
  it("loads the referenced vault's resolved indexed declarations", async () => {
    makeVault(
      "ref",
      `${REF_CONFIG}\nschema_extensions:\n  priority:\n    type: number\nindexed_fields: [priority]\n`,
    );
    const result = await loadMounts(
      canonical,
      mountsOf({ research: "../ref" }),
      "human:mihir",
      () => {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mounts.get("research")?.indexedFields).toEqual([
        { field: "priority", type: "number" },
      ]);
    }
  });

  it("loads a mount and resolves the granted principal to the referenced vault's role", async () => {
    makeVault("ref", REF_CONFIG);
    const notices: string[] = [];
    const result = await loadMounts(
      canonical,
      mountsOf({ research: "../ref" }),
      "human:mihir",
      (l) => notices.push(l),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mount = result.value.mounts.get("research");
    expect(mount?.state).toBe("ok");
    expect(mount?.roleName).toBe("researcher");
    expect(mount?.role?.read).toEqual(["pricing"]);
    expect(notices).toEqual([]);
  });

  it("resolves an unmapped principal to guest deny-all with an operator notice", async () => {
    makeVault("ref", REF_CONFIG);
    const notices: string[] = [];
    const result = await loadMounts(
      canonical,
      mountsOf({ research: "../ref" }),
      "human:stranger",
      (l) => notices.push(l),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mount = result.value.mounts.get("research");
    expect(mount?.role).toBeNull();
    expect(mount?.roleName).toBe("guest");
    expect(notices.some((l) => l.includes("guest (deny-all)"))).toBe(true);
    expect(
      notices.some((l) => l.includes('federation.principals entry for "human:stranger"')),
    ).toBe(true);
  });

  it("resolves a grant naming an unknown role to guest with a distinct notice", async () => {
    makeVault("ref", REF_CONFIG);
    const notices: string[] = [];
    const result = await loadMounts(
      canonical,
      mountsOf({ research: "../ref" }),
      "human:broken",
      (l) => notices.push(l),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mounts.get("research")?.role).toBeNull();
    expect(notices.some((l) => l.includes("unknown role 'no-such-role'"))).toBe(true);
  });

  it("warns when the granted role carries write-shaped bits, and ignores them", async () => {
    makeVault(
      "ref",
      `
roles:
  writer:
    read: ["pricing"]
    write: ["pricing"]
federation:
  principals:
    "human:mihir": { role: writer }
`,
    );
    const notices: string[] = [];
    const result = await loadMounts(
      canonical,
      mountsOf({ research: "../ref" }),
      "human:mihir",
      (l) => notices.push(l),
    );
    expect(result.ok).toBe(true);
    expect(notices.some((l) => l.includes("mounts are read-only"))).toBe(true);
  });

  it("refuses a missing required mount, and degrades a missing optional one", async () => {
    const required = await loadMounts(
      canonical,
      mountsOf({ research: "../nope" }),
      "human:mihir",
      () => {},
    );
    expect(required.ok).toBe(false);
    if (!required.ok) {
      expect(required.error.message).toContain('mount "research": path not found');
      expect(required.error.message).toContain("optional: true");
    }

    const optional = await loadMounts(
      canonical,
      mountsOf({ research: "../nope" }, true),
      "human:mihir",
      () => {},
    );
    expect(optional.ok).toBe(true);
    if (!optional.ok) return;
    const mount = optional.value.mounts.get("research");
    expect(mount?.state).toBe("unavailable");
    expect(mount?.root).toBeNull();
  });

  it("refuses a directory that is not a daftari vault", async () => {
    mkdirSync(join(base, "plain-dir"));
    const result = await loadMounts(
      canonical,
      mountsOf({ research: "../plain-dir" }),
      "human:mihir",
      () => {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("is not a daftari vault");
    expect(result.error.message).toContain("daftari --init");
  });

  it("refuses nesting in either direction", async () => {
    // Mount inside the canonical vault.
    makeVault("canonical/inner", "roles: {}\n");
    const inner = await loadMounts(
      canonical,
      mountsOf({ inner: "inner" }),
      "human:mihir",
      () => {},
    );
    expect(inner.ok).toBe(false);
    if (!inner.ok) expect(inner.error.message).toContain("nests with the canonical vault");

    // Canonical vault inside the mount.
    const outer = await loadMounts(canonical, mountsOf({ outer: ".." }), "human:mihir", () => {});
    expect(outer.ok).toBe(false);
    if (!outer.ok) expect(outer.error.message).toContain("nests with the canonical vault");
  });

  it("refuses the same real path mounted twice, symlinks included", async () => {
    makeVault("ref", REF_CONFIG);
    symlinkSync(join(base, "ref"), join(base, "ref-link"));
    const result = await loadMounts(
      canonical,
      mountsOf({ research: "../ref", alt: "../ref-link" }),
      "human:mihir",
      () => {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('already mounted as "research"');
  });

  it("refuses a canonical file that shadows a declared alias prefix", async () => {
    makeVault("ref", REF_CONFIG);
    writeFileSync(join(canonical, "research:notes.md"), "# shadow\n");
    const result = await loadMounts(
      canonical,
      mountsOf({ research: "../ref" }),
      "human:mihir",
      () => {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("shadows the mount's path prefix");
    expect(result.error.message).toContain("research:notes.md");
  });

  it("leaves ordinary ':'-containing canonical filenames untouched", async () => {
    makeVault("ref", REF_CONFIG);
    writeFileSync(join(canonical, "notes:pricing.md"), "# fine\n");
    const result = await loadMounts(
      canonical,
      mountsOf({ research: "../ref" }),
      "human:mihir",
      () => {},
    );
    expect(result.ok).toBe(true);
  });
});

describe("parseFederatedPath", () => {
  const registry: MountRegistry = {
    mounts: new Map([
      [
        "research",
        {
          alias: "research",
          root: "/tmp/ref",
          state: "ok",
          role: null,
          roleName: "guest",
          schemaExtensions: [],
          indexedFields: [],
          indexMode: "full",
        },
      ],
    ]),
  };

  it("parses only when the first-':' prefix matches a declared alias", () => {
    expect(parseFederatedPath("research:notes/a.md", registry)).toEqual({
      alias: "research",
      relPath: "notes/a.md",
      raw: "research:notes/a.md",
    });
    expect(parseFederatedPath("notes:pricing.md", registry)).toBeNull();
    expect(parseFederatedPath("plain/path.md", registry)).toBeNull();
    expect(parseFederatedPath(":leading-colon.md", registry)).toBeNull();
  });

  it("round-trips through federatedPathOf", () => {
    const fed = parseFederatedPath(federatedPathOf("research", "a/b.md"), registry);
    expect(fed?.relPath).toBe("a/b.md");
  });
});
