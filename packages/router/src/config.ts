import { homedir } from "node:os";
import YAML from "yaml";

export type Transport = "stdio";
export type VaultConfig = {
  name: string;
  path: string;
  user: string;
  role: string;
  description: string;
};
export type RouterConfig = {
  transport: Transport;
  vaults: VaultConfig[];
  defaults: { searchLimit: number };
};

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return `${homedir()}/${p.slice(2)}`;
  return p;
}

export function parseConfig(yamlText: string): RouterConfig {
  const raw = YAML.parse(yamlText) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") throw new Error("config: empty or non-object root");

  const router = (raw.router ?? {}) as { transport?: string };
  const transport = (router.transport ?? "stdio") as Transport;
  if (transport !== "stdio") throw new Error(`config: unsupported transport: ${transport}`);

  const vaultsObj = (raw.vaults ?? {}) as Record<string, Record<string, string>>;
  const names = Object.keys(vaultsObj);
  if (names.length === 0) throw new Error("config: at least one vault required");

  const vaults: VaultConfig[] = names.map((name) => {
    if (name.includes(":")) throw new Error(`config: vault name must not contain colon: ${name}`);
    const v = vaultsObj[name];
    for (const f of ["path", "user", "role", "description"] as const) {
      if (typeof v?.[f] !== "string" || !v[f])
        throw new Error(`config: vault ${name} missing ${f}`);
    }
    return {
      name,
      path: expandHome(v.path),
      user: v.user,
      role: v.role,
      description: v.description,
    };
  });

  const defaults = (raw.defaults ?? {}) as { search_limit?: number };
  return {
    transport,
    vaults,
    defaults: {
      searchLimit: typeof defaults.search_limit === "number" ? defaults.search_limit : 10,
    },
  };
}
