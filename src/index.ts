// Daftari MCP server entry point.
//
// Parses `--vault <path>`, verifies the vault directory exists, then serves the
// read-path tools over stdio. Diagnostics go to stderr so they never corrupt
// the stdio JSON-RPC stream on stdout.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { directoryExists } from "./storage/local.js";

export function parseVaultArg(argv: string[]): string | null {
  const flagIndex = argv.indexOf("--vault");
  if (flagIndex !== -1 && flagIndex + 1 < argv.length) {
    return argv[flagIndex + 1] ?? null;
  }
  const inline = argv.find((a) => a.startsWith("--vault="));
  if (inline) return inline.slice("--vault=".length);
  return null;
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

  const server = createServer(vaultRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`daftari: serving vault at ${vaultRoot} (stdio)\n`);
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
