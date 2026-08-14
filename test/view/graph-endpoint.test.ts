import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultWrite } from "../../src/tools/write.js";
import { handleView } from "../../src/view/server.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:test";
const HOST = "127.0.0.1:8788";

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Doc",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-07-01",
    provenance: "direct",
    sources: [] as string[],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    ...overrides,
  };
}

describe("viewer P2 — /api/graph endpoint (R5/R8)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("returns a {nodes,edges,...} graph with a source edge and node standing", async () => {
    await vaultWrite(vault, {
      path: "pricing/a.md",
      body: "# Alpha\n",
      frontmatter: frontmatter({ title: "Alpha", status: "canonical" }),
      agent: AGENT,
    });
    // b cites a in sources → forward edge b --source--> a
    await vaultWrite(vault, {
      path: "pricing/b.md",
      body: "# Beta\n",
      frontmatter: frontmatter({ title: "Beta", sources: ["pricing/a.md"] }),
      agent: AGENT,
    });

    const res = await handleView(vault, { path: "/api/graph", host: HOST });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    const g = JSON.parse(res.body);
    const paths = g.nodes.map((n: { path: string }) => n.path);
    expect(paths).toContain("pricing/a.md");
    expect(paths).toContain("pricing/b.md");
    expect(g.edges).toContainEqual({ from: "pricing/b.md", to: "pricing/a.md", kind: "source" });
    const a = g.nodes.find((n: { path: string }) => n.path === "pricing/a.md");
    expect(a.status).toBe("canonical");
    expect(a).toHaveProperty("decayed");
    expect(a).toHaveProperty("contested");
  });

  it("honors ego scope from the query params", async () => {
    for (const [p, t] of [
      ["pricing/a.md", "A"],
      ["pricing/b.md", "B"],
      ["pricing/c.md", "C"],
    ] as const) {
      await vaultWrite(vault, {
        path: p,
        body: `# ${t}\n`,
        frontmatter: frontmatter({ title: t }),
        agent: AGENT,
      });
    }
    // isolate a: no edges → ego(a) is just {a}
    const res = await handleView(vault, {
      path: "/api/graph",
      host: HOST,
      params: new URLSearchParams("scope=ego&root=pricing/a.md&depth=1"),
    });
    const g = JSON.parse(res.body);
    expect(g.nodes.map((n: { path: string }) => n.path)).toEqual(["pricing/a.md"]);
  });

  it("returns well-formed graph arrays with a consistent shown count", async () => {
    const res = await handleView(vault, { path: "/api/graph", host: HOST });
    expect(res.status).toBe(200);
    const g = JSON.parse(res.body);
    expect(Array.isArray(g.nodes)).toBe(true);
    expect(Array.isArray(g.edges)).toBe(true);
    expect(typeof g.total).toBe("number");
    expect(g.shown).toBe(g.nodes.length);
  });

  it("rejects a non-loopback Host (rebind guard) before doing work", async () => {
    const res = await handleView(vault, { path: "/api/graph", host: "evil.example.com" });
    expect(res.status).toBe(403);
  });
});
