import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultWrite } from "../../src/tools/write.js";
import { buildDocView } from "../../src/view/doc-view.js";
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

describe("buildDocView (viewer P1 DTO)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("returns null for a path that is no vault document", async () => {
    const res = await buildDocView(vault, "pricing/nope.md");
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    expect(res.value).toBeNull();
  });

  it("carries raw content, frontmatter, and the epistemic report keys", async () => {
    await vaultWrite(vault, {
      path: "pricing/a.md",
      body: "# Alpha\n\nBody text.\n",
      frontmatter: frontmatter({ title: "Alpha" }),
      agent: AGENT,
    });
    const res = await buildDocView(vault, "pricing/a.md");
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    const dto = res.value;
    expect(dto).not.toBeNull();
    if (!dto) return;
    expect(dto.path).toBe("pricing/a.md");
    expect(dto.frontmatter.title).toBe("Alpha");
    expect(dto.content).toContain("Body text."); // raw markdown, not HTML
    expect(dto.content).not.toContain("<p>");
    // Report keys present (null-when-silent — a fresh doc has no decay).
    expect(dto).toHaveProperty("decay");
    expect(dto).toHaveProperty("structural");
    expect(dto).toHaveProperty("upstream_staleness");
    expect(dto).toHaveProperty("validity");
    expect(Array.isArray(dto.contested)).toBe(true);
  });

  it("includes backlinks from citing documents", async () => {
    await vaultWrite(vault, {
      path: "pricing/target.md",
      body: "# Target\n",
      frontmatter: frontmatter({ title: "Target" }),
      agent: AGENT,
    });
    await vaultWrite(vault, {
      path: "pricing/citer.md",
      body: "# Citer\n",
      frontmatter: frontmatter({ title: "Citer", sources: ["pricing/target.md"] }),
      agent: AGENT,
    });
    const res = await buildDocView(vault, "pricing/target.md");
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    expect(res.value?.backlinks).toContainEqual({ doc: "pricing/citer.md", via: "source" });
  });
});
