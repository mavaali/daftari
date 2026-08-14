import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultBacklinks } from "../../src/tools/backlinks.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:test";

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Doc",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-07-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    ...overrides,
  };
}

describe("vault_backlinks (slice A)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("doc facet: a source citation is a 'source' backlink to the target", async () => {
    const target = await vaultWrite(vault, {
      path: "pricing/target.md",
      body: "# Target\n\nThe cited doc.\n",
      frontmatter: frontmatter({ title: "Target" }),
      agent: AGENT,
    });
    expect(target.ok).toBe(true);

    const citer = await vaultWrite(vault, {
      path: "pricing/citer.md",
      body: "# Citer\n\nBuilds on the target.\n",
      frontmatter: frontmatter({ title: "Citer", sources: ["pricing/target.md"] }),
      agent: AGENT,
    });
    expect(citer.ok).toBe(true);

    const res = await vaultBacklinks(vault, { target: "pricing/target.md" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    expect(res.value.kind).toBe("doc");
    expect(res.value.references).toContainEqual({ doc: "pricing/citer.md", via: "source" });
    expect(res.value.total).toBe(1);
  });

  it("doc facet: a body wikilink is a 'link' backlink to the target", async () => {
    await vaultWrite(vault, {
      path: "pricing/target.md",
      body: "# Target\n",
      frontmatter: frontmatter({ title: "Target" }),
      agent: AGENT,
    });
    await vaultWrite(vault, {
      path: "pricing/linker.md",
      body: "# Linker\n\nSee [the target](pricing/target.md) for detail.\n",
      frontmatter: frontmatter({ title: "Linker" }),
      agent: AGENT,
    });

    const res = await vaultBacklinks(vault, { target: "pricing/target.md" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    expect(res.value.kind).toBe("doc");
    expect(res.value.references).toContainEqual({ doc: "pricing/linker.md", via: "link" });
  });

  it("code facet: a describes binding is a backlink from the code file to the doc", async () => {
    await vaultWrite(vault, {
      path: "pricing/knows-code.md",
      body: "# Knows Code\n\nDescribes the pricing engine.\n",
      frontmatter: frontmatter({
        title: "Knows Code",
        describes: ["src/pricing/engine.ts"],
      }),
      agent: AGENT,
    });

    const res = await vaultBacklinks(vault, { target: "src/pricing/engine.ts" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    expect(res.value.kind).toBe("code");
    expect(res.value.references.map((r) => (r as { doc: string }).doc)).toContain(
      "pricing/knows-code.md",
    );
  });

  it("empty result is a valid, non-error response", async () => {
    const res = await vaultBacklinks(vault, { target: "src/nonexistent/file.ts" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    expect(res.value.references).toEqual([]);
    expect(res.value.total).toBe(0);
  });

  it("explicit kind override forces the code facet even for a doc-shaped path", async () => {
    await vaultWrite(vault, {
      path: "pricing/target.md",
      body: "# Target\n",
      frontmatter: frontmatter({ title: "Target" }),
      agent: AGENT,
    });
    const res = await vaultBacklinks(vault, { target: "pricing/target.md", kind: "code" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    expect(res.value.kind).toBe("code");
    // No doc describes 'pricing/target.md' as code → empty.
    expect(res.value.references).toEqual([]);
  });

  it("rejects an empty target", async () => {
    const res = await vaultBacklinks(vault, { target: "  " });
    expect(res.ok).toBe(false);
  });
});
