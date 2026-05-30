export type Routing = "fanout" | "require-vault";

export const ROUTING: Record<string, Routing> = {
  vault_read: "require-vault",
  vault_index: "fanout",
  vault_status: "fanout",
  vault_search: "fanout",
  vault_search_related: "fanout",
  vault_reindex: "fanout",
  vault_write: "require-vault",
  vault_append: "require-vault",
  vault_promote: "require-vault",
  vault_deprecate: "require-vault",
  vault_tension_log: "require-vault",
  vault_lint: "fanout",
  vault_provenance: "require-vault",
  vault_themes: "fanout",
};

export type ChildToolDescriptor = {
  name: string;
  description?: string;
  // inputSchema shape mirrors what daftari's tools return. Callers narrowing
  // from the SDK's `unknown` should structurally check before passing.
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
};

export type CatalogTool = ChildToolDescriptor;

function vaultProp(routing: Routing): { type: string; description: string } {
  return {
    type: "string",
    description:
      routing === "fanout"
        ? "Optional. Limit operation to one vault by name. Omit to fan out to all vaults and merge results."
        : "Vault name (required). Alternatively pass a vault-prefixed path like 'devops:runbooks/k8s.md'.",
  };
}

export function buildCatalog(childTools: ChildToolDescriptor[]): CatalogTool[] {
  return childTools
    .filter((t) => t.name in ROUTING)
    .map((t) => {
      const routing = ROUTING[t.name];
      const props = { ...t.inputSchema.properties, vault: vaultProp(routing) };
      return {
        ...t,
        inputSchema: {
          type: "object" as const,
          properties: props,
          required: t.inputSchema.required ?? [],
        },
      };
    });
}
