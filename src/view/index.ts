// Top-level entry for `daftari view` — start the read-only browse portal.
//
// Loopback only: the viewer renders your whole vault with no auth, so it must
// never bind a routable interface. There is deliberately no --bind flag.
//
// Exit codes (the audit convention):
//   0 — clean shutdown (SIGINT/SIGTERM)
//   2 — usage error
//   3 — listen failure

import { resolve } from "node:path";
import { createViewServer } from "./server.js";

export const DEFAULT_VIEW_PORT = 8788;
const BIND = "127.0.0.1";

const HELP = `daftari view — a read-only web portal over the vault.

Usage:
  daftari view [--vault <path>] [--port <n>]
  daftari view --help

Serves an index of documents by collection and a page per document (rendered
markdown, frontmatter, and backlinks). Loopback only (${BIND}); read-only — no
editing, no mutation routes. Stop with Ctrl-C.

Flags:
  --vault <path>   Vault root (default: current directory).
  --port <n>       Port (default: ${DEFAULT_VIEW_PORT}).

Exit codes:
  0 — clean shutdown   2 — usage error   3 — listen failure
`;

function readStringArg(argv: string[], flag: string): string | undefined {
  const raw = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (raw === undefined) return undefined;
  const idx = argv.indexOf(raw);
  return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : argv[idx + 1];
}

export async function runView(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const vaultRoot = resolve(readStringArg(argv, "--vault") ?? ".");

  let port = DEFAULT_VIEW_PORT;
  const rawPort = readStringArg(argv, "--port");
  if (rawPort !== undefined) {
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      process.stderr.write("daftari view: --port must be an integer in 1..65535\n");
      return 2;
    }
    port = n;
  }

  const server = createViewServer(vaultRoot);

  return new Promise<number>((resolveCode) => {
    server.on("error", (e) => {
      process.stderr.write(`daftari view: ${e.message}\n`);
      resolveCode(3);
    });
    server.listen(port, BIND, () => {
      process.stdout.write(`daftari view: http://${BIND}:${port}  (vault: ${vaultRoot})\n`);
    });
    const shutdown = () => {
      server.close(() => resolveCode(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
