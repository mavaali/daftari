import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type ChildPool, startPool } from "./children.js";
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

  // Register shutdown handlers EARLY so SIGINT during slow startup still
  // cleans up any children that have spawned.
  let pool: ChildPool | null = null;
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return; // C2 fix — interlock against double-signal race
    shuttingDown = true;
    process.stderr.write(`router: ${sig} — closing children\n`);
    let exitCode = 0;
    try {
      if (pool) await pool.close();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      process.stderr.write(`router: error during shutdown: ${reason}\n`);
      exitCode = 1;
    } finally {
      process.exit(exitCode);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  let cfg: ReturnType<typeof parseConfig>;
  try {
    cfg = parseConfig(readFileSync(configPath, "utf-8"));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`router: failed to load config '${configPath}': ${reason}\n`);
    return 1;
  }

  const daftariBin = flag(argv, "daftari-bin") ?? "daftari";

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

  // Heterogeneity check: warn if any child exposes a different tool surface.
  // The catalog is seeded from the first child only; calls to tools the other
  // children don't have will fail at dispatch time.
  const firstNames = new Set(toolsResp.tools.map((t) => t.name));
  for (const child of pool.all().slice(1)) {
    try {
      const otherTools = await child.listTools();
      const otherNames = new Set(otherTools.tools.map((t) => t.name));
      const missing = [...firstNames].filter((n) => !otherNames.has(n));
      const extra = [...otherNames].filter((n) => !firstNames.has(n));
      if (missing.length > 0) {
        process.stderr.write(
          `router: warning: vault '${child.name}' is missing tools: ${missing.join(", ")}\n`,
        );
      }
      if (extra.length > 0) {
        process.stderr.write(
          `router: warning: vault '${child.name}' exposes extra tools (not routed): ${extra.join(", ")}\n`,
        );
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `router: warning: could not list tools for vault '${child.name}': ${reason}\n`,
      );
    }
  }

  // The SDK's tool shape includes inputSchema typed as `unknown` after our T4
  // widening. Catalog accepts ChildToolDescriptor (structural). The cast is
  // safe here because daftari children always return the structural form.
  const { mcp } = createRouterServer(pool, toolsResp.tools as never);

  // Unlike daftari (which opens stdio before indexing to answer initialize
  // promptly), the router has no usable mode before children are ready —
  // listTools needs them, callTool needs them. Open the transport last.
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  process.stderr.write(`router: ready (${cfg.vaults.length} vaults)\n`);

  // Hold the process open — signal handler will exit.
  return new Promise<number>(() => {});
}
