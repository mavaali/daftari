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
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export type CatalogTool = ChildToolDescriptor & { routing: Routing };

const VAULT_DESC_FANOUT =
  "Optional. Limit operation to one vault by name. Omit to fan out to all vaults and merge results.";
const VAULT_DESC_REQUIRED =
  "Vault name (required). Alternatively pass a vault-prefixed path like 'devops:runbooks/k8s.md'.";

function vaultProp(routing: Routing): { type: string; description: string } {
  return {
    type: "string",
    description: routing === "fanout" ? VAULT_DESC_FANOUT : VAULT_DESC_REQUIRED,
  };
}

export function buildCatalog(childTools: ChildToolDescriptor[]): CatalogTool[] {
  return childTools
    .filter((t) => t.name in ROUTING)
    .map((t) => {
      if ("vault" in t.inputSchema.properties) {
        throw new Error(
          `tool '${t.name}' already defines a 'vault' property; router cannot add its own vault parameter`,
        );
      }
      const routing = ROUTING[t.name];
      const props = { ...t.inputSchema.properties, vault: vaultProp(routing) };
      return {
        ...t,
        routing,
        inputSchema: {
          ...t.inputSchema, // preserves additionalProperties etc.
          type: "object" as const,
          properties: props,
          required: t.inputSchema.required ?? [],
        },
      };
    });
}
