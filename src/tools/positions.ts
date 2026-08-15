// Position tools (Slice 1, U-4/U-5): vault_assert writes the calling
// principal's position on a claim doc; vault_positions queries by doc or by
// principal. Pure logic lives in curation/positions.ts; write plumbing is
// reused from write.ts (LD-9) — no duplicated lock/commit/provenance code.

import {
  type AccessContext,
  canRatify,
  canRead,
  hasAnyRead,
  isProposeOnly,
} from "../access/rbac.js";
import {
  applyAssert,
  comparePositions,
  conflictPairs,
  dissentIds,
  isContested,
  legacySnapshot,
  unsuperseded,
} from "../curation/positions.js";
import { stageActionWithConflictCheck } from "../curation/staged-actions.js";
import {
  addTension,
  listTensions,
  type ResolutionKind,
  resolveTension,
  type TensionResolution,
} from "../curation/tension.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { parseDocument } from "../frontmatter/parser.js";
import {
  CONFIDENCES,
  type Confidence,
  err,
  type Frontmatter,
  type OrgPosition,
  ok,
  type Position,
  PROVENANCES,
  type Provenance,
  type Result,
  STANCES,
  type Stance,
} from "../frontmatter/types.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import { collectionOf, type ToolDefinition } from "./read.js";
import {
  loadTargetDocument,
  performFrontmatterWrite,
  requireIndexReady,
  requireWriteAccess,
  retryOnStale,
  targetCollection,
  type WriteResult,
} from "./write.js";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function str(args: Record<string, unknown>, field: string, tool: string): Result<string, Error> {
  const v = args[field];
  if (typeof v !== "string" || v.trim().length === 0) {
    return err(new Error(`${tool} requires a non-empty '${field}' argument`));
  }
  return ok(v);
}

function optStr(
  args: Record<string, unknown>,
  field: string,
  tool: string,
): Result<string | null, Error> {
  const v = args[field];
  if (v === undefined || v === null) return ok(null);
  if (typeof v !== "string") return err(new Error(`${tool}: '${field}' must be a string`));
  return ok(v);
}

export interface AssertResult {
  path: string;
  action: "assert" | "staged";
  position: Position | null;
  superseded_position_id: string | null;
  contested: boolean;
  tension_ids: string[];
  tension_error?: string;
  commit: string | null;
  committed: boolean;
  staged_id?: string;
  expires_at?: string;
  conflicts_with?: string[];
}

export async function vaultAssert(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<AssertResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const path = str(args, "path", "vault_assert");
  if (!path.ok) return path;
  const agent = str(args, "agent", "vault_assert");
  if (!agent.ok) return agent;

  const stanceRaw = str(args, "stance", "vault_assert");
  if (!stanceRaw.ok) return stanceRaw;
  if (!(STANCES as readonly string[]).includes(stanceRaw.value)) {
    return err(new Error(`vault_assert 'stance' must be one of: ${STANCES.join(", ")}`));
  }
  const confidenceRaw = str(args, "confidence", "vault_assert");
  if (!confidenceRaw.ok) return confidenceRaw;
  if (!(CONFIDENCES as readonly string[]).includes(confidenceRaw.value)) {
    return err(new Error(`vault_assert 'confidence' must be one of: ${CONFIDENCES.join(", ")}`));
  }
  const provenanceRaw = optStr(args, "provenance", "vault_assert");
  if (!provenanceRaw.ok) return provenanceRaw;
  const provenance = (provenanceRaw.value ?? "direct") as Provenance;
  if (!(PROVENANCES as readonly string[]).includes(provenance)) {
    return err(new Error(`vault_assert 'provenance' must be one of: ${PROVENANCES.join(", ")}`));
  }
  const statement = optStr(args, "statement", "vault_assert");
  if (!statement.ok) return statement;
  const validFrom = optStr(args, "valid_from", "vault_assert");
  if (!validFrom.ok) return validFrom;
  const runIdArg = optStr(args, "run_id", "vault_assert");
  if (!runIdArg.ok) return runIdArg;
  const sources: string[] = Array.isArray(args.sources)
    ? args.sources.filter((s): s is string => typeof s === "string")
    : [];

  // R-3: the position's principal is the AUTHENTICATED user. With access, an
  // explicit differing 'principal' argument is impersonation → reject. With
  // no access context (operator server), an explicit principal is REQUIRED
  // and recorded as unverified.
  const principalArg = optStr(args, "principal", "vault_assert");
  if (!principalArg.ok) return principalArg;
  let principal: string;
  if (access) {
    if (principalArg.value !== null && principalArg.value !== access.user) {
      return err(
        new Error(
          `vault_assert: cannot assert a position for another principal ` +
            `(authenticated as '${access.user}')`,
        ),
      );
    }
    principal = access.user;
  } else {
    if (principalArg.value === null) {
      return err(
        new Error(
          "vault_assert: no access context — an explicit 'principal' argument is " +
            "required (recorded as unverified)",
        ),
      );
    }
    principal = principalArg.value;
  }

  // C-2 guard 1: "unknown" is reserved for the pos-000 legacy-snapshot
  // principal (LD-22) — no live caller, authenticated or operator, may
  // assert AS it. One check on the resolved value covers both paths.
  if (principal === "unknown") {
    return err(
      new Error("vault_assert: 'unknown' is reserved for the legacy snapshot principal (pos-000)"),
    );
  }

  // RBAC before any file I/O, keyed off the physical target dir (S1 rule).
  const writeGate = requireWriteAccess(access, targetCollection(vaultRoot, path.value));
  if (!writeGate.ok) return writeGate;

  // The load→apply→write below is a read-modify-write whose new positions
  // array is a pure function of the loaded document, so it runs under
  // retryOnStale: the write declares the load-time contentHash as its
  // base_version (issue #14's guarantee, which slice 1 shipped without), and
  // a writer whose lease window did not overlap the winner's — the silent
  // lost-position race — is rejected as stale, reloaded, and recomputed
  // against the winner's positions instead of erasing them.
  type AssertAttempt =
    | { kind: "staged"; result: AssertResult }
    | {
        kind: "written";
        relPath: string;
        title: string;
        applied: ReturnType<typeof applyAssert>;
        contested: boolean;
        written: WriteResult;
      };

  const attemptAssert = async (): Promise<Result<AssertAttempt, Error>> => {
    // Assert targets an EXISTING claim doc; creating the doc is vault_write's
    // job. loadTargetDocument canonicalizes (#127/#128) — one lock, one
    // position set per file, however the path is spelled.
    const target = await loadTargetDocument(vaultRoot, path.value, "vault_assert");
    if (!target.ok) return target;
    const fm = target.value.parsed.frontmatter;

    // U-12 / DN-2 / LD-22: the first assert on a legacy doc (typed positions
    // null — an explicit `positions: []` means already opted in, no snapshot)
    // snapshots the prior authored belief as pos-000 before the caller's own
    // position is applied. Guard 2 (applyAssert never self-supersedes across
    // principals) means the snapshot is never touched by a live caller's assert.
    const basePositions = fm.positions ?? [legacySnapshot(fm)];
    const applied = applyAssert(basePositions, {
      principal,
      stance: stanceRaw.value as Stance,
      statement: statement.value,
      confidence: confidenceRaw.value as Confidence,
      provenance,
      valid_from: validFrom.value,
      sources,
      created: todayISO(),
    });
    const contested = isContested(applied.positions);
    const capConfidence = contested && fm.org_position == null; // R-9

    const newFrontmatter: Frontmatter = {
      ...fm,
      positions: applied.positions,
      contested, // R-8: recomputed on every assert; hand-set values overwritten
      ...(capConfidence ? { confidence: "low" as Confidence } : {}),
      updated: todayISO(),
      updated_by: agent.value,
    };

    // R-13: a propose-only role's assert lands as a staged `write` proposal —
    // no file write, no positional tension yet (it fires when the ratified
    // write lands). Contention with other pending proposals is surfaced by
    // stageActionWithConflictCheck's inter-proposal tension.
    if (access && isProposeOnly(access.role)) {
      const staged = await stageActionWithConflictCheck(vaultRoot, {
        actionType: "write",
        targetPath: target.value.relPath,
        proposedBy: agent.value,
        rationale:
          `propose-only role '${access.roleName}': position ${stanceRaw.value} by ` +
          `'${principal}' staged for ratification`,
        proposedDiff: {
          frontmatter: {
            positions: applied.positions,
            contested,
            ...(capConfidence ? { confidence: "low" } : {}),
          },
          body: target.value.parsed.content,
        },
        ...(runIdArg.value !== null ? { runId: runIdArg.value } : {}),
      });
      if (!staged.ok) return staged;
      return ok({
        kind: "staged" as const,
        result: {
          path: target.value.relPath,
          action: "staged" as const,
          position: applied.newPosition,
          superseded_position_id: applied.superseded?.id ?? null,
          contested,
          tension_ids: [],
          commit: null,
          committed: false,
          staged_id: staged.value.id,
          expires_at: staged.value.expires_at,
          conflicts_with: staged.value.conflicts_with,
        },
      });
    }

    const written = await performFrontmatterWrite({
      vaultRoot,
      target: target.value,
      agent: agent.value,
      tool: "vault_assert",
      action: "assert" as WriteResult["action"],
      newFrontmatter,
      commitMessage: `vault_assert: ${stanceRaw.value} on ${target.value.relPath} by ${principal}`,
      baseVersion: target.value.contentHash,
      access,
      ...(runIdArg.value !== null ? { runId: runIdArg.value } : {}),
    });
    if (!written.ok) return written;
    return ok({
      kind: "written" as const,
      relPath: target.value.relPath,
      title: fm.title,
      applied,
      contested,
      written: written.value,
    });
  };

  const attempt = await retryOnStale(attemptAssert);
  if (!attempt.ok) return attempt;
  if (attempt.value.kind === "staged") return ok(attempt.value.result);
  const { relPath, title, applied, contested, written } = attempt.value;

  // R-5 + locked R-3: one binary tension per NEW conflicting pair, skipped
  // when an OPEN positional tension already names the same two ids on this
  // doc. loggedBy = the asserting principal (DN-3) — the loop-authored
  // ratify gate (CONSOLIDATE_AGENT) never fires on these.
  const tensionIds: string[] = [];
  let tensionError: string | undefined;
  const pairs = conflictPairs(applied.newPosition, applied.positions);
  if (pairs.length > 0) {
    const existing = await listTensions(vaultRoot);
    if (!existing.ok) {
      tensionError = existing.error.message;
    } else {
      const open = existing.value.filter(
        (t) => t.kind === "positional" && !t.resolved && t.sourceA === relPath,
      );
      const covered = (a: string, b: string): boolean =>
        open.some(
          (t) =>
            (t.positionA === a && t.positionB === b) || (t.positionA === b && t.positionB === a),
        );
      const claim = (p: Position): string =>
        p.statement ?? `${title} — ${p.stance} (${p.confidence})`;
      for (const pair of pairs) {
        if (covered(pair.a.id, pair.b.id)) continue;
        const minted = await addTension(vaultRoot, {
          kind: "positional",
          title: `Positional: ${pair.a.principal} vs ${pair.b.principal} on ${title}`,
          sourceA: relPath,
          claimA: claim(pair.a),
          sourceB: relPath,
          claimB: claim(pair.b),
          positionA: pair.a.id,
          positionB: pair.b.id,
          loggedBy: principal,
        });
        if (minted.ok) tensionIds.push(minted.value.id as string);
        else tensionError = minted.error.message;
      }
    }
  }

  return ok({
    path: relPath,
    action: "assert" as const,
    position: applied.newPosition,
    superseded_position_id: applied.superseded?.id ?? null,
    contested,
    tension_ids: tensionIds,
    ...(tensionError !== undefined ? { tension_error: tensionError } : {}),
    commit: written.commit,
    committed: written.committed,
  });
}

// The subset of RESOLUTION_KINDS vault_consolidate accepts for its in-call
// resolve_tension (LD-19). "invalid" is a legitimate tension-resolution kind
// generally, but not a consolidation verdict — consolidate is not a backdoor
// generic resolver.
const CONSOLIDATABLE_RESOLUTION_KINDS = ["superseded", "corrected", "accepted"] as const;
type ConsolidatableResolutionKind = (typeof CONSOLIDATABLE_RESOLUTION_KINDS)[number];

export interface ConsolidateResult {
  path: string;
  action: "consolidate";
  org_position: OrgPosition;
  confidence: Confidence;
  dissent: string[];
  contested: boolean | null;
  resolved_tension_id: string | null;
  resolve_error?: string;
  commit: string | null;
  committed: boolean;
}

// U-10 / R-16: ratify-gated consolidation. Writes the org's ratified stance
// (org_position), mirrors its confidence onto the doc (clearing the R-9
// low-confidence cap — C-1's "the mirror moves only by re-consolidating"),
// and carries dissent — computed server-side, never caller-supplied (LD-18).
// Optionally resolves one open positional tension on this doc in the same
// call (LD-19): validated BEFORE the write; the write commits first, and a
// resolve failure afterward is reported as resolve_error, never rolled back.
export async function vaultConsolidate(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<ConsolidateResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const path = str(args, "path", "vault_consolidate");
  if (!path.ok) return path;
  const agent = str(args, "agent", "vault_consolidate");
  if (!agent.ok) return agent;

  const stanceRaw = str(args, "stance", "vault_consolidate");
  if (!stanceRaw.ok) return stanceRaw;
  if (!(STANCES as readonly string[]).includes(stanceRaw.value)) {
    return err(new Error(`vault_consolidate 'stance' must be one of: ${STANCES.join(", ")}`));
  }
  const confidenceRaw = str(args, "confidence", "vault_consolidate");
  if (!confidenceRaw.ok) return confidenceRaw;
  if (!(CONFIDENCES as readonly string[]).includes(confidenceRaw.value)) {
    return err(
      new Error(`vault_consolidate 'confidence' must be one of: ${CONFIDENCES.join(", ")}`),
    );
  }
  const runIdArg = optStr(args, "run_id", "vault_consolidate");
  if (!runIdArg.ok) return runIdArg;

  let resolveTensionArg: {
    id: string;
    kind: ConsolidatableResolutionKind;
    rationale?: string;
  } | null = null;
  if (args.resolve_tension !== undefined && args.resolve_tension !== null) {
    const rt = args.resolve_tension;
    if (typeof rt !== "object" || Array.isArray(rt)) {
      return err(new Error("vault_consolidate: 'resolve_tension' must be an object"));
    }
    const rtObj = rt as Record<string, unknown>;
    const idRes = str(rtObj, "id", "vault_consolidate resolve_tension");
    if (!idRes.ok) return idRes;
    const kindRes = str(rtObj, "kind", "vault_consolidate resolve_tension");
    if (!kindRes.ok) return kindRes;
    if (!(CONSOLIDATABLE_RESOLUTION_KINDS as readonly string[]).includes(kindRes.value)) {
      return err(
        new Error(
          `vault_consolidate resolve_tension 'kind' must be one of: ` +
            `${CONSOLIDATABLE_RESOLUTION_KINDS.join(", ")}`,
        ),
      );
    }
    const rationaleRes = optStr(rtObj, "rationale", "vault_consolidate resolve_tension");
    if (!rationaleRes.ok) return rationaleRes;
    resolveTensionArg = {
      id: idRes.value,
      kind: kindRes.value as ConsolidatableResolutionKind,
      ...(rationaleRes.value !== null ? { rationale: rationaleRes.value } : {}),
    };
  }

  // LD-25: same identity shape as vault_assert's R-3 operator rule, but the
  // resolved identity here is the RATIFIER, not a position's principal.
  const principalArg = optStr(args, "principal", "vault_consolidate");
  if (!principalArg.ok) return principalArg;
  let ratifier: string;
  if (access) {
    if (principalArg.value !== null && principalArg.value !== access.user) {
      return err(
        new Error(
          `vault_consolidate: cannot ratify as another principal ` +
            `(authenticated as '${access.user}')`,
        ),
      );
    }
    ratifier = access.user;
  } else {
    if (principalArg.value === null) {
      return err(
        new Error(
          "vault_consolidate: no access context — an explicit 'principal' argument is " +
            "required (recorded as unverified)",
        ),
      );
    }
    ratifier = principalArg.value;
  }

  // C-2 guard 5: "unknown" is reserved for the pos-000 legacy-snapshot
  // principal — no live ratifier, authenticated or operator, may ratify AS it.
  if (ratifier === "unknown") {
    return err(
      new Error(
        "vault_consolidate: 'unknown' is reserved for the legacy snapshot principal (pos-000)",
      ),
    );
  }

  // LD-20: a propose-only role is denied even if `ratify` is (mis)granted —
  // a proposer is not a ratifier, and there is no propose-only path for
  // consolidate (unlike vault_write/vault_assert, which coerce into staged
  // proposals).
  if (access && isProposeOnly(access.role)) {
    return err(
      new Error(`access denied: role '${access.roleName}' is propose-only — it cannot consolidate`),
    );
  }
  if (access && !canRatify(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot consolidate`));
  }

  // Same read-modify-write discipline as vault_assert above: dissent and the
  // contested flag are pure functions of the loaded positions, so the write
  // declares its load-time contentHash and a stale attempt (a position
  // asserted while this ratification was in flight) is reloaded and
  // recomputed — never allowed to erase the interleaved position or ratify
  // with a dissent list computed from a superseded snapshot.
  type ConsolidateAttempt = {
    relPath: string;
    orgPosition: OrgPosition;
    dissent: string[];
    contested: boolean | null;
    written: WriteResult;
  };

  const attemptConsolidate = async (): Promise<Result<ConsolidateAttempt, Error>> => {
    const target = await loadTargetDocument(vaultRoot, path.value, "vault_consolidate");
    if (!target.ok) return target;
    const fm = target.value.parsed.frontmatter;

    const dissent = dissentIds(fm.positions ?? [], stanceRaw.value as Stance);

    // LD-19: resolve_tension is validated BEFORE any write. The id must name
    // an OPEN tension with kind "positional" and sourceA === this doc — never
    // a backdoor generic resolver.
    if (resolveTensionArg) {
      const all = await listTensions(vaultRoot);
      if (!all.ok) return all;
      const t = all.value.find((x) => x.id === resolveTensionArg?.id);
      if (!t || t.resolved || t.kind !== "positional" || t.sourceA !== target.value.relPath) {
        return err(
          new Error(
            "vault_consolidate: resolve_tension does not name an open positional tension " +
              "on this document",
          ),
        );
      }
      if (resolveTensionArg.kind === "accepted" && dissent.length === 0) {
        return err(
          new Error("vault_consolidate: resolve_tension kind 'accepted' requires standing dissent"),
        );
      }
    }

    const orgPosition: OrgPosition = {
      stance: stanceRaw.value as Stance,
      confidence: confidenceRaw.value as Confidence,
      ratified_by: ratifier,
      ratified_at: todayISO(),
      dissent,
    };

    // LD-21: contested is re-derived from the live set, never touched by
    // consolidate itself; a fully legacy doc (positions null) stays null.
    const contested = fm.positions != null ? isContested(fm.positions) : null;

    const newFrontmatter: Frontmatter = {
      ...fm,
      org_position: orgPosition,
      confidence: confidenceRaw.value as Confidence, // the mirror — clears the R-9 cap
      contested,
      updated: todayISO(),
      updated_by: agent.value,
    };

    const written = await performFrontmatterWrite({
      vaultRoot,
      target: target.value,
      agent: agent.value,
      tool: "vault_consolidate",
      action: "consolidate" as WriteResult["action"],
      newFrontmatter,
      commitMessage: `vault_consolidate: ${stanceRaw.value} on ${target.value.relPath} ratified by ${ratifier}`,
      baseVersion: target.value.contentHash,
      access,
      ...(runIdArg.value !== null ? { runId: runIdArg.value } : {}),
    });
    if (!written.ok) return written;
    return ok({
      relPath: target.value.relPath,
      orgPosition,
      dissent,
      contested,
      written: written.value,
    });
  };

  const attempt = await retryOnStale(attemptConsolidate);
  if (!attempt.ok) return attempt;
  const { relPath, orgPosition, dissent, contested, written } = attempt.value;

  // The doc write commits FIRST; a resolve failure afterward is reported as
  // resolve_error, not rolled back (LD-19 — mirror of Slice 1's tension_error
  // channel).
  let resolvedTensionId: string | null = null;
  let resolveError: string | undefined;
  if (resolveTensionArg) {
    const resolution: TensionResolution = {
      resolved_at: new Date().toISOString(),
      resolved_by: ratifier,
      kind: resolveTensionArg.kind as ResolutionKind,
      ...(resolveTensionArg.rationale !== undefined
        ? { rationale: resolveTensionArg.rationale }
        : {}),
    };
    const resolved = await resolveTension(vaultRoot, resolveTensionArg.id, resolution);
    if (resolved.ok) resolvedTensionId = resolveTensionArg.id;
    else resolveError = resolved.error.message;
  }

  return ok({
    path: relPath,
    action: "consolidate" as const,
    org_position: orgPosition,
    confidence: confidenceRaw.value as Confidence,
    dissent,
    contested,
    resolved_tension_id: resolvedTensionId,
    ...(resolveError !== undefined ? { resolve_error: resolveError } : {}),
    commit: written.commit,
    committed: written.committed,
  });
}

export interface PositionsResult {
  count: number;
  positions: Array<{ path: string; position: Position; contested: boolean }>;
}

export async function vaultPositions(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<PositionsResult, Error>> {
  const path = optStr(args, "path", "vault_positions");
  if (!path.ok) return path;
  const principal = optStr(args, "principal", "vault_positions");
  if (!principal.ok) return principal;
  const includeSuperseded = args.include_superseded === true;
  if ((path.value === null) === (principal.value === null)) {
    return err(new Error("vault_positions requires exactly one of 'path' or 'principal'"));
  }

  if (path.value !== null) {
    const resolved = resolveVaultPath(vaultRoot, path.value);
    if (!resolved.ok) return resolved;
    // #212 discipline: the message never echoes the path — an unreadable doc
    // must be byte-indistinguishable from a missing one, and the collection
    // is the first path segment, so even echoing the caller's own string
    // would leak it back through this channel.
    const notFound = () => err(new Error("vault_positions: document not found"));
    const file = await readFile(resolved.value.absPath);
    if (!file.ok) return notFound();
    const parsed = parseDocument(file.value);
    if (!parsed.ok) return parsed;
    if (
      access &&
      !canRead(access.role, collectionOf(resolved.value.relPath, parsed.value.frontmatter))
    ) {
      return notFound();
    }
    const set = parsed.value.frontmatter.positions ?? [];
    const chosen = (includeSuperseded ? set : unsuperseded(set)).slice().sort(comparePositions);
    return ok({
      count: chosen.length,
      positions: chosen.map((p) => ({
        path: resolved.value.relPath,
        position: p,
        contested: isContested(set),
      })),
    });
  }

  // By principal: whole-vault scan via the lint loader (LD-10). Unreadable
  // docs are silently omitted — no count, no hint (#217 omission rule).
  if (access && !hasAnyRead(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot use vault_positions`));
  }
  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;
  const out: PositionsResult["positions"] = [];
  for (const doc of loaded.value) {
    if (access && !canRead(access.role, collectionOf(doc.path, doc.frontmatter))) continue;
    const set = doc.frontmatter.positions;
    if (set == null) continue;
    const pool = includeSuperseded ? set : unsuperseded(set);
    for (const p of pool.filter((x) => x.principal === principal.value).sort(comparePositions)) {
      out.push({ path: doc.path, position: p, contested: isContested(set) });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ok({ count: out.length, positions: out });
}

const POSITION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    id: { type: "string" },
    principal: { type: "string" },
    stance: { type: "string", enum: [...STANCES] },
    statement: { type: ["string", "null"] },
    confidence: { type: "string", enum: [...CONFIDENCES] },
    provenance: { type: "string", enum: [...PROVENANCES] },
    valid_from: { type: ["string", "null"] },
    superseded_by: { type: ["string", "null"] },
    created: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
  },
  required: [
    "id",
    "principal",
    "stance",
    "statement",
    "confidence",
    "provenance",
    "valid_from",
    "superseded_by",
    "created",
    "sources",
  ],
};

const ORG_POSITION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    stance: { type: "string", enum: [...STANCES] },
    confidence: { type: "string", enum: [...CONFIDENCES] },
    ratified_by: { type: "string" },
    ratified_at: { type: "string" },
    dissent: { type: "array", items: { type: "string" } },
  },
  required: ["stance", "confidence", "ratified_by", "ratified_at", "dissent"],
};

const assertToolDefinition: ToolDefinition = {
  name: "vault_assert",
  title: "Assert a position on a claim document",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  description:
    "Assert, dispute, or qualify the calling principal's position on an " +
    "existing claim document. The position's principal is the authenticated " +
    "--user; a prior live position by the same principal is superseded, never " +
    "edited. A second conflicting live stance (assert vs dispute) marks the " +
    "document contested, caps its confidence at low until an org position is " +
    "ratified (see vault_consolidate), and auto-logs a 'positional' tension (never " +
    "caller-loggable via vault_tension_log; resolve through " +
    "vault_tension_resolve). Propose-only roles: the assert lands as a staged " +
    "'write' proposal for ratification — nothing is written and no positional " +
    "tension is logged until the ratified write lands. The first assert on a " +
    "legacy doc (typed positions null) snapshots the doc's prior belief as " +
    "pos-000 (principal 'unknown', system-authored, unforgeable). Under " +
    "concurrent writes to the same doc the call retries once against the " +
    "fresh state, then fails loudly ('locked' or 'stale write') — safe to " +
    "re-call; no position is ever silently overwritten.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Vault-relative path of the existing claim doc" },
      stance: { type: "string", enum: [...STANCES] },
      statement: { type: "string", description: "Optional refinement of the title claim" },
      confidence: { type: "string", enum: [...CONFIDENCES] },
      provenance: { type: "string", enum: [...PROVENANCES], description: "Default: direct" },
      valid_from: { type: "string", description: "YYYY-MM-DD" },
      sources: { type: "array", items: { type: "string" } },
      agent: { type: "string", description: "Free-text acting identity (advisory)" },
      principal: {
        type: "string",
        description:
          "Only honored (and required) when the server runs without an access " +
          "context; recorded as unverified. With an access context it must " +
          "match the authenticated user.",
      },
      run_id: { type: "string" },
    },
    required: ["path", "stance", "confidence", "agent"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      action: { type: "string", enum: ["assert", "staged"] },
      position: { ...POSITION_SCHEMA, type: ["object", "null"] },
      superseded_position_id: { type: ["string", "null"] },
      contested: { type: "boolean" },
      tension_ids: { type: "array", items: { type: "string" } },
      tension_error: { type: "string" },
      commit: { type: ["string", "null"] },
      committed: { type: "boolean" },
      staged_id: { type: "string" },
      expires_at: { type: "string" },
      conflicts_with: { type: "array", items: { type: "string" } },
    },
    required: [
      "path",
      "action",
      "position",
      "superseded_position_id",
      "contested",
      "tension_ids",
      "commit",
      "committed",
    ],
  },
  docLinks: (value) => [(value as AssertResult).path],
  handler: (vaultRoot, args, access) => vaultAssert(vaultRoot, args, access),
};

const positionsToolDefinition: ToolDefinition = {
  name: "vault_positions",
  title: "Query principals' positions",
  annotations: { readOnlyHint: true },
  description:
    "Query positions: all positions on one doc ('path'), or all live " +
    "positions held by a principal across the vault ('principal'). Exactly " +
    "one selector. Results are limited to docs the caller can read; " +
    "include_superseded (default false) adds superseded entries.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      principal: { type: "string" },
      include_superseded: { type: "boolean" },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 0 },
      positions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            position: POSITION_SCHEMA,
            contested: { type: "boolean" },
          },
          required: ["path", "position", "contested"],
        },
      },
    },
    required: ["count", "positions"],
  },
  docLinks: (value) => [...new Set((value as PositionsResult).positions.map((p) => p.path))],
  handler: (vaultRoot, args, access) => vaultPositions(vaultRoot, args, access),
};

const consolidateToolDefinition: ToolDefinition = {
  name: "vault_consolidate",
  title: "Ratify an org position on a contested claim",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  description:
    "Ratify the org's consolidated stance on a claim document (ratify-gated: " +
    "requires a role with ratify: true; propose-only roles are denied outright " +
    "— there is no staged-proposal path for consolidation). Writes org_position " +
    "and mirrors its confidence onto the doc, clearing the R-9 low-confidence " +
    "cap; the mirror holds through re-contest and moves only by " +
    "re-consolidating. dissent is computed server-side from the live position " +
    "set at ratify time (assert<->dispute; qualify opposes nothing) — never " +
    "caller-supplied. Allowed on uncontested or fully legacy docs (dissent: " +
    "[]). Optionally resolves one open positional tension on this doc in the " +
    "same call via resolve_tension: validated before any write (must name an " +
    "open 'positional' tension whose sourceA is this doc; kind 'accepted' " +
    "requires standing dissent); the doc write commits first, and a resolve " +
    "failure afterward is reported as resolve_error, never rolled back. Under " +
    "concurrent writes to the same doc the call retries once against the " +
    "fresh state (dissent recomputed), then fails loudly ('locked' or 'stale " +
    "write') — safe to re-call.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Vault-relative path of the existing claim doc" },
      stance: { type: "string", enum: [...STANCES] },
      confidence: { type: "string", enum: [...CONFIDENCES] },
      agent: { type: "string", description: "Free-text acting identity (advisory)" },
      principal: {
        type: "string",
        description:
          "Only honored (and required) when the server runs without an access " +
          "context; recorded as unverified as the ratifier. With an access " +
          "context it must match the authenticated user.",
      },
      run_id: { type: "string" },
      resolve_tension: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: [...CONSOLIDATABLE_RESOLUTION_KINDS] },
          rationale: { type: "string" },
        },
        required: ["id", "kind"],
        additionalProperties: false,
      },
    },
    required: ["path", "stance", "confidence", "agent"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      action: { type: "string", enum: ["consolidate"] },
      org_position: ORG_POSITION_SCHEMA,
      confidence: { type: "string", enum: [...CONFIDENCES] },
      dissent: { type: "array", items: { type: "string" } },
      contested: { type: ["boolean", "null"] },
      resolved_tension_id: { type: ["string", "null"] },
      resolve_error: { type: "string" },
      commit: { type: ["string", "null"] },
      committed: { type: "boolean" },
    },
    required: [
      "path",
      "action",
      "org_position",
      "confidence",
      "dissent",
      "contested",
      "resolved_tension_id",
      "commit",
      "committed",
    ],
  },
  docLinks: (value) => [(value as ConsolidateResult).path],
  handler: (vaultRoot, args, access) => vaultConsolidate(vaultRoot, args, access),
};

export const positionsTools: ToolDefinition[] = [
  assertToolDefinition,
  positionsToolDefinition,
  consolidateToolDefinition,
];
