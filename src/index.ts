// Daftari MCP server entry point.
//
// Parses `--vault <path>`, verifies the vault directory exists, loads the RBAC
// config, builds the search index, then serves the tools over stdio under the
// access identity given by `--user` / `--role`. Diagnostics go to stderr so
// they never corrupt the stdio JSON-RPC stream on stdout.
//
// `--reindex` rebuilds the search index and exits without starting the server.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { reindexVault } from "./search/reindex.js";
import { createServer } from "./server.js";
import { directoryExists } from "./storage/local.js";
import { loadConfig } from "./utils/config.js";
import { GUEST_ROLE, resolveAccess } from "./access/rbac.js";

// Reads `--name value` or `--name=value` from argv; null if absent.
export function parseFlag(argv: string[], name: string): string | null {
  const flag = `--${name}`;
  const flagIndex = argv.indexOf(flag);
  if (flagIndex !== -1 && flagIndex + 1 < argv.length) {
    return argv[flagIndex + 1] ?? null;
  }
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(`${flag}=`.length);
  return null;
}

export function parseVaultArg(argv: string[]): string | null {
  return parseFlag(argv, "vault");
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const vaultArg = parseVaultArg(argv);
  if (!vaultArg) {
    process.stderr.write(
      "daftari: missing required --vault <path> argument\n",
    );
    process.exitCode = 1;
    return;
  }

  const vaultRoot = resolve(vaultArg);
  if (!(await directoryExists(vaultRoot))) {
    process.stderr.write(
      `daftari: vault directory not found: ${vaultRoot}\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Load the RBAC config. A malformed config fails loud: the server must not
  // start serving content under a policy it could not parse.
  const config = loadConfig(vaultRoot);
  if (!config.ok) {
    process.stderr.write(`daftari: ${config.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Resolve the access identity. With no --role the server runs as the
  // deny-all guest; an unknown role name resolves the same way.
  const user = parseFlag(argv, "user") ?? "guest";
  const roleName = parseFlag(argv, "role") ?? GUEST_ROLE;
  const access = resolveAccess(config.value, user, roleName);
  if (access.role === null && roleName !== GUEST_ROLE) {
    process.stderr.write(
      `daftari: warning: role '${roleName}' not found in config — ` +
        `running as deny-all guest\n`,
    );
  }

  // Build (or rebuild) the search index. With --reindex this is the whole job.
  const reindexed = await reindexVault(vaultRoot);
  if (reindexed.ok) {
    const r = reindexed.value;
    process.stderr.write(
      `daftari: indexed ${r.documentCount} docs, ${r.chunkCount} chunks ` +
        `(vectors ${r.vectorEnabled ? "on" : "off"})\n`,
    );
  } else {
    // A failed index is not fatal: lexical search still works and the search
    // tools retry indexing lazily on first use.
    process.stderr.write(
      `daftari: warning: index build failed: ${reindexed.error.message}\n`,
    );
  }

  if (argv.includes("--reindex")) {
    if (!reindexed.ok) process.exitCode = 1;
    return;
  }

  const server = createServer(vaultRoot, access);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `daftari: serving vault at ${vaultRoot} (stdio) — ` +
      `user=${access.user} role=${access.roleName}\n`,
  );
}

// Auto-run only when this module is the process entry point (e.g. `tsx
// src/index.ts`). When imported (by cli.ts or tests) it stays inert.
const entryUrl = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === entryUrl) {
  main().catch((e) => {
    const reason = e instanceof Error ? e.stack ?? e.message : String(e);
    process.stderr.write(`daftari: fatal: ${reason}\n`);
    process.exitCode = 1;
  });
}
