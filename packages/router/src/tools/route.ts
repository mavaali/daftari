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

  // Prefix-parsing of args.path only runs when no explicit vault was provided.
  // If both args.vault and a vault-prefixed args.path are set, the prefix is
  // forwarded verbatim — the caller chose explicit, so we trust them.
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
    const known =
      pool
        .all()
        .map((c) => c.name)
        .join(", ") || "(none)";
    return err(`${tool}: unknown vault '${vault}'. Known vaults: ${known}`);
  }
  return child.callTool(tool, rest);
}
