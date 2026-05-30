import type { ChildPool } from "../children.js";
import { parseVaultPath } from "../path.js";

type Args = Record<string, unknown>;
type Result = { content: unknown[]; isError?: boolean };

const err = (text: string): Result => ({ isError: true, content: [{ type: "text", text }] });

export async function routeToVault(pool: ChildPool, tool: string, args: Args): Promise<Result> {
  let vault: string | null =
    typeof args.vault === "string" && args.vault.length > 0 ? args.vault : null;
  const rest: Args = { ...args };
  delete rest.vault;

  if (!vault && typeof args.path === "string") {
    const parsed = parseVaultPath(args.path);
    if (parsed.vault && parsed.vault.length > 0) {
      vault = parsed.vault;
      rest.path = parsed.path;
    }
  }

  if (!vault) {
    return err(
      `${tool} requires a vault: pass {vault: name} or a vault-prefixed path like 'name:path/to.md'`,
    );
  }
  const child = pool.get(vault);
  if (!child) {
    const all = pool.all() ?? [];
    const names = all.map((c) => c.name);
    // Truncate to 20 to keep error messages readable at large pool sizes.
    const known =
      names.length > 20
        ? `${names.slice(0, 20).join(", ")} … (${names.length} total)`
        : names.join(", ") || "(none)";
    return err(`${tool}: unknown vault '${vault}'. Known vaults: ${known}`);
  }
  return child.callTool(tool, rest);
}
