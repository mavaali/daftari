#!/usr/bin/env node
// Phase 1 CLI stub: the `daftari` bin simply boots the MCP server. A richer
// CLI (vault init, doctor, rebuild-index) is deferred to a later phase.

import { main } from "./index.js";

main().catch((e) => {
  const reason = e instanceof Error ? e.stack ?? e.message : String(e);
  process.stderr.write(`daftari: fatal: ${reason}\n`);
  process.exitCode = 1;
});
