import { describe, expect, it } from "vitest";
import { buildCatalog, ROUTING } from "../src/tools/catalog.js";

const childTools = [
  {
    name: "vault_read",
    description: "Read a doc.",
    inputSchema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "vault_search",
    description: "Search.",
    inputSchema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

describe("catalog", () => {
  it("adds optional vault property to schemas", () => {
    const cat = buildCatalog(childTools);
    const read = cat.find((t) => t.name === "vault_read");
    expect(read?.inputSchema.properties.vault).toMatchObject({ type: "string" });
    expect(read?.inputSchema.required).toContain("path");
    expect(read?.inputSchema.required).not.toContain("vault");
  });

  it("knows routing policy per tool", () => {
    expect(ROUTING.vault_read).toBe("require-vault");
    expect(ROUTING.vault_search).toBe("fanout");
    expect(ROUTING.vault_write).toBe("require-vault");
    expect(ROUTING.vault_search_related).toBe("require-vault");
  });

  it("describes vault parameter semantics in description", () => {
    const cat = buildCatalog(childTools);
    const read = cat.find((t) => t.name === "vault_read");
    const vault = read?.inputSchema.properties.vault as { description?: string } | undefined;
    expect(vault?.description).toMatch(/vault/i);
  });

  it("filters out tools not in ROUTING", () => {
    const cat = buildCatalog([
      ...childTools,
      {
        name: "vault_unknown_tool",
        description: "should be dropped",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ]);
    expect(cat.find((t) => t.name === "vault_unknown_tool")).toBeUndefined();
  });

  it("attaches routing policy to each catalog entry", () => {
    const cat = buildCatalog(childTools);
    expect(cat.find((t) => t.name === "vault_read")?.routing).toBe("require-vault");
    expect(cat.find((t) => t.name === "vault_search")?.routing).toBe("fanout");
  });

  it("throws if a child tool already defines a 'vault' property", () => {
    expect(() =>
      buildCatalog([
        {
          name: "vault_read",
          description: "Read.",
          inputSchema: {
            type: "object" as const,
            properties: { vault: { type: "string" }, path: { type: "string" } },
            required: ["path"],
          },
        },
      ]),
    ).toThrow(/vault/);
  });

  it("preserves additionalProperties from the source schema", () => {
    const cat = buildCatalog([
      {
        name: "vault_read",
        description: "Read a doc.",
        inputSchema: {
          type: "object" as const,
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ]);
    expect(cat[0]?.inputSchema.additionalProperties).toBe(false);
  });
});
