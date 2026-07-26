// The `boundary` argument on vault_supersede, vault_deprecate, vault_merge.
//
// "The date the successor takes over." Supplying it closes the PREDECESSOR's
// interval at boundary - 1 day, so a supersession event and a valid-time
// handoff can be recorded in one call.
//
// THE SUCCESSOR IS NEVER WRITTEN. vaultSupersede writes one document and gates
// RBAC on the predecessor's collection only; writing the successor too would
// be a second lock, a second provenance entry, a multi-file commit, and — when
// the successor lives in a different collection — a write the caller was never
// authorized for. Instead the result carries a `hint`, so the agent makes that
// call deliberately through the tool that carries the successor's own gate.
//
// And it refuses rather than clobbers: an authored valid_until is a claim
// somebody made, and a convenience argument does not get to overwrite it.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultRead } from "../../src/tools/read.js";
import { vaultDeprecate, vaultMerge, vaultSupersede, vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";

async function seed(
  vault: string,
  path: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const written = await vaultWrite(vault, {
    path,
    body: `# Note\n\nBody of ${path}.\n`,
    frontmatter: {
      title: "A Note",
      domain: "accumulation",
      collection: "pricing",
      status: "canonical",
      confidence: "medium",
      created: "2026-05-01",
      provenance: "direct",
      sources: [],
      superseded_by: null,
      ttl_days: 90,
      tags: ["note"],
      ...overrides,
    },
    agent: "agent:seed",
  });
  if (!written.ok) throw written.error;
}

async function validityOf(vault: string, path: string) {
  const read = await vaultRead(vault, path);
  if (!read.ok) throw read.error;
  return {
    from: read.value.frontmatter.valid_from,
    until: read.value.frontmatter.valid_until,
  };
}

describe("vault_supersede — boundary", () => {
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    await seed(vault, "pricing/v1.md", { valid_from: "2026-01-01" });
    await seed(vault, "pricing/v2.md");
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("leaves validity untouched when boundary is omitted", async () => {
    const r = await vaultSupersede(vault, {
      old_path: "pricing/v1.md",
      new_path: "pricing/v2.md",
      agent: AGENT,
    });
    expect(r.ok).toBe(true);
    expect(await validityOf(vault, "pricing/v1.md")).toEqual({
      from: "2026-01-01",
      until: null,
    });
  });

  it("closes the predecessor's interval the day before the boundary", async () => {
    const r = await vaultSupersede(vault, {
      old_path: "pricing/v1.md",
      new_path: "pricing/v2.md",
      agent: AGENT,
      boundary: "2026-04-01",
    });
    expect(r.ok).toBe(true);
    expect((await validityOf(vault, "pricing/v1.md")).until).toBe("2026-03-31");
  });

  it("handles a month boundary correctly", async () => {
    const r = await vaultSupersede(vault, {
      old_path: "pricing/v1.md",
      new_path: "pricing/v2.md",
      agent: AGENT,
      boundary: "2026-03-01",
    });
    expect(r.ok).toBe(true);
    expect((await validityOf(vault, "pricing/v1.md")).until).toBe("2026-02-28");
  });

  // --- C1: the successor must not be touched -------------------------------

  it("leaves the successor file BYTE-IDENTICAL", async () => {
    const successorPath = join(vault, "pricing/v2.md");
    const before = readFileSync(successorPath, "utf8");

    const r = await vaultSupersede(vault, {
      old_path: "pricing/v1.md",
      new_path: "pricing/v2.md",
      agent: AGENT,
      boundary: "2026-04-01",
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(successorPath, "utf8")).toBe(before);
  });

  it("returns a hint naming the successor and the suggested valid_from", async () => {
    const r = await vaultSupersede(vault, {
      old_path: "pricing/v1.md",
      new_path: "pricing/v2.md",
      agent: AGENT,
      boundary: "2026-04-01",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hint).toBeDefined();
    expect(r.value.hint).toContain("pricing/v2.md");
    expect(r.value.hint).toContain("2026-04-01");
  });

  it("emits no hint when boundary is omitted", async () => {
    const r = await vaultSupersede(vault, {
      old_path: "pricing/v1.md",
      new_path: "pricing/v2.md",
      agent: AGENT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hint).toBeUndefined();
  });

  // --- refuse rather than clobber ------------------------------------------

  it("refuses when the predecessor already carries a conflicting valid_until", async () => {
    await seed(vault, "pricing/closed.md", {
      valid_from: "2026-01-01",
      valid_until: "2026-06-30",
    });
    const r = await vaultSupersede(vault, {
      old_path: "pricing/closed.md",
      new_path: "pricing/v2.md",
      agent: AGENT,
      boundary: "2026-04-01",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("valid_until");
    expect(r.error.message).toContain("2026-06-30");
    // And the file is unchanged.
    expect((await validityOf(vault, "pricing/closed.md")).until).toBe("2026-06-30");
  });

  it("accepts a boundary consistent with the existing valid_until", async () => {
    await seed(vault, "pricing/consistent.md", {
      valid_from: "2026-01-01",
      valid_until: "2026-03-31",
    });
    const r = await vaultSupersede(vault, {
      old_path: "pricing/consistent.md",
      new_path: "pricing/v2.md",
      agent: AGENT,
      boundary: "2026-04-01",
    });
    expect(r.ok).toBe(true);
    expect((await validityOf(vault, "pricing/consistent.md")).until).toBe("2026-03-31");
  });

  it("rejects a malformed boundary", async () => {
    const r = await vaultSupersede(vault, {
      old_path: "pricing/v1.md",
      new_path: "pricing/v2.md",
      agent: AGENT,
      boundary: "April 2026",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("boundary");
  });
});

describe("vault_deprecate — boundary", () => {
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    await seed(vault, "pricing/old.md", { valid_from: "2026-01-01" });
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("closes the deprecated document's interval", async () => {
    const r = await vaultDeprecate(vault, {
      path: "pricing/old.md",
      reason: "pricing changed",
      agent: AGENT,
      boundary: "2026-04-01",
    });
    expect(r.ok).toBe(true);
    expect((await validityOf(vault, "pricing/old.md")).until).toBe("2026-03-31");
  });

  it("leaves validity untouched when boundary is omitted", async () => {
    const r = await vaultDeprecate(vault, {
      path: "pricing/old.md",
      reason: "pricing changed",
      agent: AGENT,
    });
    expect(r.ok).toBe(true);
    expect((await validityOf(vault, "pricing/old.md")).until).toBeNull();
  });

  it("refuses on a conflicting existing value", async () => {
    await seed(vault, "pricing/closed.md", { valid_until: "2026-06-30" });
    const r = await vaultDeprecate(vault, {
      path: "pricing/closed.md",
      reason: "x",
      agent: AGENT,
      boundary: "2026-04-01",
    });
    expect(r.ok).toBe(false);
  });
});

describe("vault_merge — boundary", () => {
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    await seed(vault, "pricing/a.md", { valid_from: "2026-01-01" });
    await seed(vault, "pricing/b.md", { valid_from: "2026-01-01" });
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("closes BOTH sources' intervals", async () => {
    const r = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      target_path: "pricing/merged.md",
      body: "# Merged\n\nCombined body.\n",
      agent: AGENT,
      boundary: "2026-04-01",
    });
    expect(r.ok).toBe(true);
    expect((await validityOf(vault, "pricing/a.md")).until).toBe("2026-03-31");
    expect((await validityOf(vault, "pricing/b.md")).until).toBe("2026-03-31");
  });

  it("refuses the WHOLE merge when either source conflicts", async () => {
    // A merge is already all-or-nothing; a partial validity write would leave
    // the vault in a state no single call could have produced.
    writeFileSync(
      join(vault, "pricing/b.md"),
      readFileSync(join(vault, "pricing/b.md"), "utf8").replace(
        "valid_until: null",
        "valid_until: 2026-06-30",
      ),
    );
    const r = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      target_path: "pricing/merged.md",
      body: "# Merged\n\nCombined body.\n",
      agent: AGENT,
      boundary: "2026-04-01",
    });
    expect(r.ok).toBe(false);
    // path_a must not have been closed either.
    expect((await validityOf(vault, "pricing/a.md")).until).toBeNull();
  });

  it("leaves the merge target's validity alone", async () => {
    const r = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      target_path: "pricing/merged.md",
      body: "# Merged\n\nCombined body.\n",
      agent: AGENT,
      boundary: "2026-04-01",
    });
    expect(r.ok).toBe(true);
    // The target is the successor. Same rule as vault_supersede: not ours to
    // write. It inherits path_a's frontmatter, whose valid_until is null.
    expect((await validityOf(vault, "pricing/merged.md")).until).toBeNull();
  });
});
