import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startPool } from "./children.js";
import { parseConfig } from "./config.js";
import { createRouterServer } from "./server.js";

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const prefix = `--${name}=`;
  const eq = argv.find((a) => a.startsWith(prefix));
  return eq ? eq.slice(prefix.length) : null;
}

export async function main(argv: string[]): Promise<number> {
  const configPath = flag(argv, "config");
  if (!configPath) {
    process.stderr.write("usage: daftari-router --config <vaults.yaml>\n");
    return 2;
  }

  let cfg: ReturnType<typeof parseConfig>;
  try {
    cfg = parseConfig(readFileSync(configPath, "utf-8"));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`router: failed to load config '${configPath}': ${reason}\n`);
    return 1;
  }

  const daftariBin = flag(argv, "daftari-bin") ?? "daftari";

  let pool: Awaited<ReturnType<typeof startPool>>;
  try {
    pool = await startPool(cfg, daftariBin);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`router: failed to start pool: ${reason}\n`);
    return 1;
  }

  // Seed catalog from the first child's tools/list. We assume all children
  // expose the same tool surface (documented in README).
  const first = pool.all()[0];
  let toolsResp: Awaited<ReturnType<typeof first.listTools>>;
  try {
    toolsResp = await first.listTools();
  } catch (e) {
    await pool.close();
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`router: failed to list tools from first child: ${reason}\n`);
    return 1;
  }

  // The SDK's tool shape includes inputSchema typed as `unknown` after our T4
  // widening. Catalog accepts ChildToolDescriptor (structural). The cast is
  // safe here because daftari children always return the structural form.
  const { mcp } = createRouterServer(pool, toolsResp.tools as never);

  const shutdown = async (sig: string) => {
    process.stderr.write(`router: ${sig} — closing children\n`);
    try {
      await pool.close();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      process.stderr.write(`router: error during shutdown: ${reason}\n`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  process.stderr.write(`router: ready (${cfg.vaults.length} vaults)\n`);

  // Hold the process open — signal handler will exit.
  return new Promise<number>(() => {});
}
