// vault_witness — per-principal track records from the ledger, priced by
// the wager schedule. Read-only: the witness testifies from what the vault
// already recorded (provenance, tensions, staged actions); it never grades
// beyond deterministic arithmetic on exported provisional constants, and it
// never enforces — routing a write by a track record is the caller's
// judgment, not the vault's.

import { type AccessContext, hasAnyRead } from "../access/rbac.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { buildWitness, type WitnessResult } from "../witness/track-record.js";
import type { ToolDefinition } from "./read.js";

export async function vaultWitness(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<WitnessResult | { principal: unknown }, Error>> {
  if (access && !hasAnyRead(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot use vault_witness`));
  }

  const witness = await buildWitness(vaultRoot, new Date(), access);
  if (!witness.ok) return witness;

  if (args.principal !== undefined) {
    if (typeof args.principal !== "string" || args.principal.length === 0) {
      return err(new Error("vault_witness 'principal' must be a non-empty string"));
    }
    const match = witness.value.principals.find((p) => p.principal === args.principal);
    if (!match) {
      return err(new Error(`vault_witness: no record for principal '${args.principal}'`));
    }
    return ok({
      principal: match,
      concentration: witness.value.concentration,
      flatCurveWarning: witness.value.flatCurveWarning,
    } as unknown as { principal: unknown });
  }

  return witness;
}

export const witnessTools: ToolDefinition[] = [
  {
    name: "vault_witness",
    title: "Per-principal track records",
    annotations: { readOnlyHint: true },
    description:
      "Per-principal track records aggregated from the vault's own ledgers " +
      "(provenance log, tension log, staged actions), priced by the wager " +
      "schedule: writing a claim at a confidence level stakes points " +
      "(low 0 / medium 1 / high 3, provisional); a claim later corrected or " +
      "retired burns the stake; a claim maintained through a full TTL cycle " +
      "earns credit. Returns, per principal: write volume and span, docs " +
      "authored, live claims with open exposure, contested claims with " +
      "stake at risk, the settled book (lost/burned vs survived/credited, " +
      "balance), proposal outcomes (ratified/rejected/expired), and tensions " +
      "logged. Includes the flat-curve monitor: when one principal holds " +
      "≥95% of writes, track records are declared uninformative rather than " +
      "reported as signal. Read-only, deterministic, advisory — nothing is " +
      "enforced and no document is touched. Pass 'principal' to fetch one " +
      "record.",
    inputSchema: {
      type: "object",
      properties: {
        principal: {
          type: "string",
          description:
            "Optional identity to fetch a single record for, e.g. " +
            "agent:claude-code or human:mihir.",
        },
      },
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultWitness(vaultRoot, args, access),
  },
];
