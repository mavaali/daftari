// Enables real (non-shadow) consolidation in a tmpdir-guarded vault.
//
// Safety contract: daftari defaults to shadow_mode:true (all consolidation
// calls are no-ops outside real vaults). This function flips shadow_mode:false
// ONLY when vaultRoot is under os.tmpdir() — so recall-bench can exercise the
// full consolidation pipeline without ever touching a real vault.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as parseYaml, dump as dumpYaml } from "js-yaml";
import { isUnderTmpdir } from "./adapter.js";

export function enableRealConsolidation(vaultRoot: string): void {
  if (!isUnderTmpdir(vaultRoot)) {
    throw new Error(
      "recall-bench: refusing to enable real consolidation (shadow_mode:false) outside os.tmpdir(): " +
        resolve(vaultRoot),
    );
  }

  const daftariDir = join(resolve(vaultRoot), ".daftari");
  const configPath = join(daftariDir, "config.yaml");

  // Read existing config if present, preserving all keys.
  let existing: Record<string, unknown> = {};
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // File doesn't exist or is unreadable — start fresh.
  }

  existing["shadow_mode"] = false;

  mkdirSync(daftariDir, { recursive: true });
  writeFileSync(configPath, dumpYaml(existing), "utf8");

  console.error(
    `recall-bench: enabling REAL consolidation (shadow_mode:false) in tmp vault: ${resolve(vaultRoot)}`,
  );
}
