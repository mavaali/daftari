import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { vaultRead } from "../../src/tools/read.js";
import {
  vaultMerge,
  vaultSetConfidence,
  vaultSupersede,
  vaultWrite,
} from "../../src/tools/write.js";
import { log } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";

// analyst may write competitive-intel but NOT pricing (sample-vault config).
const ANALYST: AccessContext = {
  user: "ana",
  roleName: "analyst",
  role: { read: ["competitive-intel", "pricing"], write: ["competitive-intel"] },
};

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
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
  };
}

async function seed(vault: string, path: string, overrides: Record<string, unknown> = {}) {
  const written = await vaultWrite(vault, {
    path,
    body: `# A Note\n\nBody of ${path}.\n`,
    frontmatter: frontmatter(overrides),
    agent: "agent:seed",
  });
  if (!written.ok) throw written.error;
}

describe("vault_set_confidence", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("changes confidence, commits, and logs provenance", async () => {
    await seed(vault, "pricing/conf.md", { confidence: "low" });
    const result = await vaultSetConfidence(vault, {
      path: "pricing/conf.md",
      confidence: "high",
      reason: "Replicated across three independent passes.",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action).toBe("confidence-set");
    expect(result.value.commit).toMatch(/^[0-9a-f]+$/);

    const read = await vaultRead(vault, "pricing/conf.md");
    expect(read.ok && read.value.frontmatter.confidence).toBe("high");

    const history = await log(vault, { path: "pricing/conf.md" });
    expect(history.ok && history.value[0]?.subject).toContain("vault_set_confidence");

    const prov = await readProvenanceLog(vault);
    expect(prov.ok).toBe(true);
    if (!prov.ok) return;
    const entry = prov.value.find(
      (e) => e.file === "pricing/conf.md" && e.action === "confidence-set",
    );
    expect(entry?.frontmatter_diff?.confidence?.after).toBe("high");
  }, 60_000);

  it("rejects an invalid confidence value", async () => {
    await seed(vault, "pricing/conf.md");
    const result = await vaultSetConfidence(vault, {
      path: "pricing/conf.md",
      confidence: "very-high",
      reason: "x",
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
  });

  it("sets confidence on a doc that never declared one (no false no-op)", async () => {
    // A doc with no `confidence` field on disk. vault_write would default it, so
    // write the file directly. The validator reads it as "low" by default, but
    // the raw field is absent — set_confidence(…, "low") must still write it,
    // not reject it as already-low (the trap the raw-value guard avoids).
    const text = [
      "---",
      "title: No Confidence",
      "domain: accumulation",
      "collection: pricing",
      "status: canonical",
      "created: 2026-05-01",
      "updated: 2026-05-01",
      "updated_by: agent:seed",
      "provenance: direct",
      "---",
      "",
      "# No Confidence",
      "",
      "Body.",
      "",
    ].join("\n");
    writeFileSync(join(vault, "pricing", "no-conf.md"), text, "utf-8");

    const result = await vaultSetConfidence(vault, {
      path: "pricing/no-conf.md",
      confidence: "low",
      reason: "Calibrating an inherited doc that never set confidence.",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const read = await vaultRead(vault, "pricing/no-conf.md");
    expect(read.ok && read.value.frontmatter.confidence).toBe("low");
  }, 60_000);

  it("rejects when confidence is already at the target (no churn)", async () => {
    await seed(vault, "pricing/conf.md", { confidence: "high" });
    const result = await vaultSetConfidence(vault, {
      path: "pricing/conf.md",
      confidence: "high",
      reason: "x",
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
  });

  it("requires a reason", async () => {
    await seed(vault, "pricing/conf.md");
    const result = await vaultSetConfidence(vault, {
      path: "pricing/conf.md",
      confidence: "high",
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
  });

  it("denies a role without write access to the collection", async () => {
    await seed(vault, "pricing/conf.md", { confidence: "low" });
    const result = await vaultSetConfidence(
      vault,
      { path: "pricing/conf.md", confidence: "high", reason: "x", agent: AGENT },
      ANALYST,
    );
    expect(result.ok).toBe(false);
  });
});

describe("vault_supersede", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("marks the old doc superseded by the successor and commits", async () => {
    await seed(vault, "pricing/old.md");
    await seed(vault, "pricing/new.md");
    const result = await vaultSupersede(vault, {
      old_path: "pricing/old.md",
      new_path: "pricing/new.md",
      reason: "Newer analysis replaces it.",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action).toBe("supersede");

    const read = await vaultRead(vault, "pricing/old.md");
    expect(read.ok && read.value.frontmatter.status).toBe("superseded");
    expect(read.ok && read.value.frontmatter.superseded_by).toBe("pricing/new.md");

    const history = await log(vault, { path: "pricing/old.md" });
    expect(history.ok && history.value[0]?.subject).toContain("vault_supersede");
  }, 60_000);

  it("rejects superseding a doc by itself", async () => {
    await seed(vault, "pricing/old.md");
    const result = await vaultSupersede(vault, {
      old_path: "pricing/old.md",
      new_path: "pricing/old.md",
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects when the successor does not exist", async () => {
    await seed(vault, "pricing/old.md");
    const result = await vaultSupersede(vault, {
      old_path: "pricing/old.md",
      new_path: "pricing/ghost.md",
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing successor argument", async () => {
    await seed(vault, "pricing/old.md");
    const result = await vaultSupersede(vault, {
      old_path: "pricing/old.md",
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
  });

  it("denies a role without write access to the old doc's collection", async () => {
    await seed(vault, "pricing/old.md");
    await seed(vault, "pricing/new.md");
    const result = await vaultSupersede(
      vault,
      { old_path: "pricing/old.md", new_path: "pricing/new.md", agent: AGENT },
      ANALYST,
    );
    expect(result.ok).toBe(false);
  });
});

describe("vault_merge", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("writes the target and supersedes both sources in one commit", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      target_path: "pricing/merged.md",
      body: "# Merged\n\nCombined content.\n",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action).toBe("merge");
    expect(result.value.path).toBe("pricing/merged.md");

    // Target carries the merged body + synthesized provenance.
    const target = await vaultRead(vault, "pricing/merged.md");
    expect(target.ok && target.value.content).toContain("Combined content.");
    expect(target.ok && target.value.frontmatter.provenance).toBe("synthesized");

    // Both sources are superseded by the target.
    const a = await vaultRead(vault, "pricing/a.md");
    const b = await vaultRead(vault, "pricing/b.md");
    expect(a.ok && a.value.frontmatter.status).toBe("superseded");
    expect(a.ok && a.value.frontmatter.superseded_by).toBe("pricing/merged.md");
    expect(b.ok && b.value.frontmatter.status).toBe("superseded");
    expect(b.ok && b.value.frontmatter.superseded_by).toBe("pricing/merged.md");

    // All three files land in ONE commit.
    const la = await log(vault, { path: "pricing/a.md" });
    const lb = await log(vault, { path: "pricing/b.md" });
    const lt = await log(vault, { path: "pricing/merged.md" });
    expect(la.ok && lb.ok && lt.ok).toBe(true);
    if (!la.ok || !lb.ok || !lt.ok) return;
    expect(la.value[0]?.subject).toContain("vault_merge");
    expect(la.value[0]?.hash).toBe(lt.value[0]?.hash);
    expect(lb.value[0]?.hash).toBe(lt.value[0]?.hash);
  }, 60_000);

  it("merges B into A when target equals path_a", async () => {
    await seed(vault, "pricing/a.md", { created: "2026-04-01" });
    await seed(vault, "pricing/b.md");
    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      target_path: "pricing/a.md",
      body: "# A\n\nNow with B folded in.\n",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The target (a.md) gets the merged body and is NOT itself superseded.
    const a = await vaultRead(vault, "pricing/a.md");
    expect(a.ok && a.value.content).toContain("Now with B folded in.");
    expect(a.ok && a.value.frontmatter.status).not.toBe("superseded");
    // The existing target's created date is preserved.
    expect(a.ok && a.value.frontmatter.created).toBe("2026-04-01");

    // Only b.md is superseded.
    const b = await vaultRead(vault, "pricing/b.md");
    expect(b.ok && b.value.frontmatter.status).toBe("superseded");
    expect(b.ok && b.value.frontmatter.superseded_by).toBe("pricing/a.md");
  }, 60_000);

  it("rejects merging a doc with itself", async () => {
    await seed(vault, "pricing/a.md");
    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/a.md",
      target_path: "pricing/merged.md",
      body: "x",
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects path_a and path_b that alias the same file via ./", async () => {
    await seed(vault, "pricing/a.md");
    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "./pricing/a.md",
      target_path: "pricing/merged.md",
      body: "x",
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
  });

  it("folds into A (not double-write) when target aliases path_a via ./", async () => {
    await seed(vault, "pricing/a.md", { created: "2026-04-01" });
    await seed(vault, "pricing/b.md");
    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      // Same file as path_a, written with a different string.
      target_path: "./pricing/a.md",
      body: "# A\n\nFolded in.\n",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // a.md got the merged body and was NOT superseded against itself.
    const a = await vaultRead(vault, "pricing/a.md");
    expect(a.ok && a.value.content).toContain("Folded in.");
    expect(a.ok && a.value.frontmatter.status).not.toBe("superseded");
    expect(a.ok && a.value.frontmatter.created).toBe("2026-04-01");

    const b = await vaultRead(vault, "pricing/b.md");
    expect(b.ok && b.value.frontmatter.status).toBe("superseded");
  }, 60_000);

  // Like the `./` fold-in test above, but the source aliases the target via a
  // SYMLINK, not a lexical spelling. The self-target skip must compare CANONICAL
  // relPaths, not lexical absPaths: a symlink alias has a distinct absPath, so
  // an absPath-keyed skip would fail to fire and the source's superseded body
  // would clobber the merged target (same inode, last-write-wins) (#127/#128).
  it("folds into A (not double-write) when a source aliases the target via a symlink", async () => {
    await seed(vault, "pricing/a.md", { created: "2026-04-01" });
    await seed(vault, "pricing/b.md");
    // pricing/a-alias.md → pricing/a.md (both inside the vault).
    symlinkSync(join(vault, "pricing/a.md"), join(vault, "pricing/a-alias.md"));

    const result = await vaultMerge(vault, {
      path_a: "pricing/a-alias.md", // symlink alias of the target
      path_b: "pricing/b.md",
      target_path: "pricing/a.md",
      body: "# A\n\nFolded via symlink.\n",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // a.md must carry the MERGED body and must NOT be superseded against itself.
    const a = await vaultRead(vault, "pricing/a.md");
    expect(a.ok && a.value.content).toContain("Folded via symlink.");
    expect(a.ok && a.value.frontmatter.status).not.toBe("superseded");
    expect(a.ok && a.value.frontmatter.created).toBe("2026-04-01");

    const b = await vaultRead(vault, "pricing/b.md");
    expect(b.ok && b.value.frontmatter.status).toBe("superseded");
    expect(b.ok && b.value.frontmatter.superseded_by).toBe("pricing/a.md");
  }, 60_000);

  it("rejects when a source does not exist", async () => {
    await seed(vault, "pricing/a.md");
    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/ghost.md",
      target_path: "pricing/merged.md",
      body: "x",
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
  });

  it("denies a role without write access to one of the three collections", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    const result = await vaultMerge(
      vault,
      {
        path_a: "pricing/a.md",
        path_b: "pricing/b.md",
        target_path: "pricing/merged.md",
        body: "x",
        agent: AGENT,
      },
      ANALYST,
    );
    expect(result.ok).toBe(false);
  });
});

// S1 (2026-07-01 security review): the write gate must key off the directory the
// bytes physically land in — the resolved target path's top-level dir — never a
// caller-declared frontmatter.collection. Honoring the declared string let a
// role with write on collection A drop a file into collection B by lying in the
// frontmatter (and, without base_version, overwrite existing B docs).
describe("write-side ACL: path vs declared collection (S1)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("vault_write denies a path in an unwritable collection even when frontmatter.collection names a writable one", async () => {
    // analyst may write competitive-intel, NOT pricing.
    const result = await vaultWrite(
      vault,
      {
        path: "pricing/leak.md",
        body: "# Leak\n\nSecret pricing.\n",
        frontmatter: frontmatter({ collection: "competitive-intel" }),
        agent: AGENT,
      },
      ANALYST,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("access denied");
    // And the bytes must NOT have landed in pricing/.
    const read = await vaultRead(vault, "pricing/leak.md");
    expect(read.ok).toBe(false);
  });

  it("vault_write denies an aliased path that resolves into an unwritable collection", async () => {
    const result = await vaultWrite(
      vault,
      {
        // Lexically canonicalizes to pricing/leak2.md.
        path: "competitive-intel/../pricing/leak2.md",
        body: "# Leak\n\nSecret pricing.\n",
        frontmatter: frontmatter({ collection: "competitive-intel" }),
        agent: AGENT,
      },
      ANALYST,
    );
    expect(result.ok).toBe(false);
    const read = await vaultRead(vault, "pricing/leak2.md");
    expect(read.ok).toBe(false);
  });

  it("vault_write allows a write when the path's collection is writable (declared matches dir)", async () => {
    const result = await vaultWrite(
      vault,
      {
        path: "competitive-intel/note.md",
        body: "# Note\n\nBody.\n",
        frontmatter: frontmatter({ collection: "competitive-intel" }),
        agent: AGENT,
      },
      ANALYST,
    );
    expect(result.ok).toBe(true);
  });

  it("vault_write gates on the physical dir, not a mismatched declared collection (option a, not b)", async () => {
    // A declared collection that differs from the physical dir is a real pattern
    // (see fixture _drafts/moonshot). The gate is the physical dir the caller can
    // write; the mismatched declared string is not itself rejected.
    const result = await vaultWrite(
      vault,
      {
        path: "competitive-intel/staged.md",
        body: "# Staged\n\nBody.\n",
        frontmatter: frontmatter({ collection: "some-future-collection" }),
        agent: AGENT,
      },
      ANALYST,
    );
    expect(result.ok).toBe(true);
  });

  it("vault_merge denies a target in an unwritable collection even when frontmatter.collection names a writable one", async () => {
    await seed(vault, "competitive-intel/a.md", { collection: "competitive-intel" });
    await seed(vault, "competitive-intel/b.md", { collection: "competitive-intel" });
    const result = await vaultMerge(
      vault,
      {
        path_a: "competitive-intel/a.md",
        path_b: "competitive-intel/b.md",
        target_path: "pricing/merged.md",
        body: "# Merged\n\nCombined.\n",
        frontmatter: { collection: "competitive-intel" },
        agent: AGENT,
      },
      ANALYST,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("access denied");
    const read = await vaultRead(vault, "pricing/merged.md");
    expect(read.ok).toBe(false);
  });

  it("vault_merge allows a merge fully within a writable collection", async () => {
    await seed(vault, "competitive-intel/a.md", { collection: "competitive-intel" });
    await seed(vault, "competitive-intel/b.md", { collection: "competitive-intel" });
    const result = await vaultMerge(
      vault,
      {
        path_a: "competitive-intel/a.md",
        path_b: "competitive-intel/b.md",
        target_path: "competitive-intel/merged.md",
        body: "# Merged\n\nCombined.\n",
        agent: AGENT,
      },
      ANALYST,
    );
    expect(result.ok).toBe(true);
  });
});
