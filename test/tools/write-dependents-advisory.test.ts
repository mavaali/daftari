// U1: downstream dependents advisory on vault_deprecate / vault_supersede.
//
// When a source doc is retracted (deprecated or superseded), the tool result
// carries a `dependents` advisory so the actor immediately sees which docs
// cite the doc they just retracted.  Advisory only — no doc is ever edited.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultDeprecate, vaultSupersede, vaultWrite } from "../../src/tools/write.js";
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

describe("vault_deprecate — dependents advisory", () => {
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    // src.md — the doc we will deprecate
    await seed(vault, "pricing/src.md");
    // dep-a.md and dep-b.md cite src.md in their sources frontmatter
    await seed(vault, "pricing/dep-a.md", { sources: ["pricing/src.md"] });
    await seed(vault, "pricing/dep-b.md", { sources: ["pricing/src.md"] });
    // unrelated.md — does not cite src.md
    await seed(vault, "pricing/unrelated.md");
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("surfaces dep-a and dep-b in dependents.downstream after deprecating src.md", async () => {
    const result = await vaultDeprecate(vault, {
      path: "pricing/src.md",
      reason: "No longer valid",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { dependents } = result.value;
    expect(dependents).toBeDefined();
    if (!dependents) return;

    const paths = dependents.downstream.map((e) => e.path).sort();
    expect(paths).toEqual(["pricing/dep-a.md", "pricing/dep-b.md"].sort());
    expect(dependents.primary_blast).toBe(2);
    expect(dependents.hidden_downstream).toBe("none");
  });

  it("returns empty downstream when no docs cite the deprecated doc", async () => {
    const result = await vaultDeprecate(vault, {
      path: "pricing/unrelated.md",
      reason: "Stale",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { dependents } = result.value;
    expect(dependents).toBeDefined();
    if (!dependents) return;

    expect(dependents.downstream).toEqual([]);
    expect(dependents.primary_blast).toBe(0);
    expect(dependents.hidden_downstream).toBe("none");
  });
});

describe("vault_supersede — dependents advisory", () => {
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    // src.md — the doc we will supersede
    await seed(vault, "pricing/src.md");
    // successor.md — the replacement (must exist before supersede)
    await seed(vault, "pricing/successor.md");
    // dep-a.md and dep-b.md cite src.md
    await seed(vault, "pricing/dep-a.md", { sources: ["pricing/src.md"] });
    await seed(vault, "pricing/dep-b.md", { sources: ["pricing/src.md"] });
    // unrelated.md — does not cite src.md
    await seed(vault, "pricing/unrelated.md");
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("surfaces dep-a and dep-b in dependents.downstream after superseding src.md", async () => {
    const result = await vaultSupersede(vault, {
      old_path: "pricing/src.md",
      new_path: "pricing/successor.md",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { dependents } = result.value;
    expect(dependents).toBeDefined();
    if (!dependents) return;

    const paths = dependents.downstream.map((e) => e.path).sort();
    expect(paths).toEqual(["pricing/dep-a.md", "pricing/dep-b.md"].sort());
    expect(dependents.primary_blast).toBe(2);
    expect(dependents.hidden_downstream).toBe("none");
  });

  it("returns empty downstream when no docs cite the superseded doc", async () => {
    // First seed a fresh doc with no dependents
    await seed(vault, "pricing/isolated.md");
    await seed(vault, "pricing/isolated-next.md");

    const result = await vaultSupersede(vault, {
      old_path: "pricing/isolated.md",
      new_path: "pricing/isolated-next.md",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { dependents } = result.value;
    expect(dependents).toBeDefined();
    if (!dependents) return;

    expect(dependents.downstream).toEqual([]);
    expect(dependents.primary_blast).toBe(0);
    expect(dependents.hidden_downstream).toBe("none");
  });
});
