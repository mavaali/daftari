// Operator-side persistence for distill receipts (#423). Append-only JSONL at
// .daftari/distill-receipts.jsonl, keyed by the artifact runId so a run's
// provider/ZDR/cost facts join to the claims it produced. Machine-local and
// gitignored — these are operator telemetry (R10), NEVER exposed through an MCP
// tool or CLI read path.
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { DistillReceipt } from "./cost.js";
import { err, ok, type Result } from "../frontmatter/types.js";

export function distillReceiptsPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "distill-receipts.jsonl");
}

export async function appendDistillReceipt(
  vaultRoot: string,
  receipt: DistillReceipt,
): Promise<Result<void, Error>> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    await appendFile(distillReceiptsPath(vaultRoot), `${JSON.stringify(receipt)}\n`);
    return ok(undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot persist distill receipt: ${reason}`));
  }
}
