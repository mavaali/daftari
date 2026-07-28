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

// ---------------------------------------------------------------------------
// Output schema (spec 2026-07-26, Decision 3)
// ---------------------------------------------------------------------------
//
// Two shapes share one schema: the full report carries `principals` (plus
// `unattributedDocs`), and a single-principal request carries `principal`
// instead. `concentration` and `flatCurveWarning` ride both — the flat-curve
// monitor must reach the caller either way — so only those two are required.

const principalRecordSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    principal: { type: "string", description: "e.g. 'agent:claude-code' or 'human:mihir'" },
    // Raw activity.
    writes: { type: "integer" },
    firstWriteAt: { type: ["string", "null"] },
    lastWriteAt: { type: ["string", "null"] },
    docsAuthored: { type: "integer" },
    // The open book.
    liveClaims: { type: "integer", description: "Authored docs currently canonical" },
    openExposure: { type: "number", description: "Σ stake(confidence) over live claims" },
    contestedOpen: { type: "integer", description: "Live claims under unresolved tensions" },
    stakeAtRisk: { type: "number" },
    // The settled book.
    lost: { type: "integer" },
    burnedStake: { type: "number" },
    survived: { type: "integer" },
    creditEarned: { type: "number" },
    balance: { type: "number", description: "creditEarned − burnedStake (advisory)" },
    proposals: {
      type: "object",
      properties: {
        total: { type: "integer" },
        ratified: { type: "integer" },
        rejected: { type: "integer" },
        expired: { type: "integer" },
        pending: { type: "integer" },
        edited: {
          type: "integer",
          description:
            "Ratified via edit-then-approve — a subset of 'ratified', not additional to it",
        },
        byCategory: {
          type: "object",
          additionalProperties: { type: "integer" },
          description: "Decided (ratified/rejected) proposals by reason_category",
        },
      },
      required: ["total", "ratified", "rejected", "expired", "pending", "edited", "byCategory"],
      additionalProperties: false,
    },
    tensionsLogged: { type: "integer" },
  },
  required: [
    "principal",
    "writes",
    "firstWriteAt",
    "lastWriteAt",
    "docsAuthored",
    "liveClaims",
    "openExposure",
    "contestedOpen",
    "stakeAtRisk",
    "lost",
    "burnedStake",
    "survived",
    "creditEarned",
    "balance",
    "proposals",
    "tensionsLogged",
  ],
  additionalProperties: false,
};

const witnessOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    principals: {
      type: "array",
      items: principalRecordSchema,
      description: "Every principal's record; absent when a single 'principal' was requested",
    },
    principal: principalRecordSchema,
    unattributedDocs: {
      type: "integer",
      description: "Docs with no provenance history — nobody's record",
    },
    concentration: {
      type: "object",
      properties: {
        topPrincipal: { type: ["string", "null"] },
        topShare: { type: "number", description: "Write share of the top principal, 0–1" },
      },
      required: ["topPrincipal", "topShare"],
      additionalProperties: false,
    },
    flatCurveWarning: {
      type: "boolean",
      description: "True when one principal holds ≥95% of writes — records are uninformative",
    },
  },
  required: ["concentration", "flatCurveWarning"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Compact `content` summary (spec 2026-07-26, Decision 3, PR 1 gap closure).
// No docLinks: a principal is an identity string, not a vault document path.
// ---------------------------------------------------------------------------

interface WitnessSingle {
  principal: WitnessResult["principals"][number];
  concentration: WitnessResult["concentration"];
  flatCurveWarning: boolean;
}

function summarizeWitness(value: unknown): string {
  const v = value as WitnessResult | WitnessSingle;
  if ("principal" in v) {
    const p = v.principal;
    return (
      `${p.principal}: ${p.writes} write(s), ${p.liveClaims} live claim(s), ` +
      `balance ${p.balance.toFixed(1)}`
    );
  }
  const flat = v.flatCurveWarning ? " — flat-curve warning: one principal dominates" : "";
  return `${v.principals.length} principal(s), ${v.unattributedDocs} unattributed doc(s)${flat}`;
}

export const witnessTools: ToolDefinition[] = [
  {
    name: "vault_witness",
    title: "Per-principal track records",
    oneLine: "Report per-principal track records of proposals and writes.",
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
    outputSchema: witnessOutputSchema,
    summarize: summarizeWitness,
    handler: (vaultRoot, args, access) => vaultWitness(vaultRoot, args, access),
  },
];
