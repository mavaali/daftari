// src/tools/erase.ts
//
// vault_erase — a path/source-keyed history scrub for the accidental sensitive
// commit (R11-R13). This is the deliberate, destructive counterpart to
// distill-and-discard: distill-and-discard keeps raw from LANDING; vault_erase
// removes something that already landed, from the git history, not just the
// worktree.
//
// Guardrails, in order:
//   1. RBAC — the caller's role must hold the `erase` capability (off by default).
//   2. Target — exactly one of `path` or `source_ref`.
//   3. Confirmation — `confirm` must echo the target string exactly.
//   4. Dependents — a nonzero source/link blast requires the exact current
//      `plan_hash` returned by vaultErasePlan.
//   5. Revalidation — recompute the plan at the last reversible point before
//      filter-repo; any target, graph, caller-visibility, or HEAD drift aborts.
// Only then does it dispatch the history rewrite (src/utils/git-erase.ts) and
// append a content-free receipt to .daftari/erasures.jsonl. For a secret-shaped
// target it returns rotate-first guidance: a history rewrite cannot un-disclose
// what was already pushed.

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AccessContext } from "../access/rbac.js";
import { canErase } from "../access/rbac.js";
import { sourceReadable } from "../curation/tension-access.js";
import {
  type BlastDownstreamEntry,
  bucketHiddenDownstream,
  buildReverseLinkMap,
  buildReverseSourceMap,
  computeBlast,
  type HiddenDownstream,
} from "../curation/tension-blast.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { headFullSha } from "../utils/git.js";
import { eraseFromHistory, type GitEraseDeps } from "../utils/git-erase.js";

export interface EraseTarget {
  kind: "path" | "source_ref";
  value: string;
}

export interface ErasePlan {
  target: EraseTarget;
  /** Caller-visible concrete paths selected by the target. */
  target_paths: string[];
  /** Coarsened count of source_ref-selected paths omitted by RBAC. */
  hidden_targets: HiddenDownstream;
  /** Caller-visible downstream dependents. */
  downstream: BlastDownstreamEntry[];
  /** Counts cover only the visible downstream list. */
  primary_blast: number;
  advisory_blast: number;
  /** Coarsened count of downstream paths omitted by RBAC. */
  hidden_downstream: HiddenDownstream;
  /** Full git commit anchoring this plan. */
  vault_head: string;
  /** Deterministic acknowledgment token over the full, unredacted plan state. */
  plan_hash: string;
}

export interface EraseOutcome {
  /** Vault-relative paths that were scrubbed. Empty when the erase was refused. */
  erased: string[];
  /** Anything the scrub could not guarantee (see EraseResult.incomplete). */
  incomplete: string[];
  /** True when the history op was refused (filter-repo absent) — nothing erased. */
  refused: boolean;
  /** Present only when the target looks secret-shaped: rotate-first guidance. */
  guidance?: string;
}

// A conservative "does this look like a secret?" heuristic — errs toward
// warning. It gates only GUIDANCE (never the erase itself), so a false positive
// costs a rotate-first sentence, never a blocked scrub.
function looksSecretShaped(s: string): boolean {
  return (
    /(?:secret|token|passw(?:or)?d|credential|api[-_]?key|private[-_]?key)/i.test(s) ||
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(s) ||
    /\b[A-Za-z0-9+/]{32,}={0,2}\b/.test(s)
  );
}

async function resolveSourceRefToPaths(
  vaultRoot: string,
  sourceRef: string,
): Promise<Result<string[], Error>> {
  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;
  const paths = loaded.value
    .filter((d) => (d.frontmatter.sources ?? []).includes(sourceRef))
    .map((d) => d.path)
    .sort();
  return ok(paths);
}

function eraseTarget(args: Record<string, unknown>): Result<EraseTarget, Error> {
  const path = typeof args.path === "string" ? args.path : undefined;
  const sourceRef = typeof args.source_ref === "string" ? args.source_ref : undefined;
  if ((path && sourceRef) || (!path && !sourceRef)) {
    return err(new Error("vault_erase requires exactly one of 'path' or 'source_ref'"));
  }
  return ok(
    path ? { kind: "path", value: path } : { kind: "source_ref", value: sourceRef as string },
  );
}

function eraseAccess(access?: AccessContext): Result<AccessContext, Error> {
  if (!access) {
    return err(
      new Error("vault_erase requires an authenticated access context (fail-closed — no default)"),
    );
  }
  if (!canErase(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot erase from history`));
  }
  return ok(access);
}

function stalePlanError(): Error {
  return new Error(
    "vault_erase aborted: plan_hash does not match the current erase plan — the plan is " +
      "missing, stale, or belongs to a different target/principal; review a fresh plan before retrying",
  );
}

export async function vaultErasePlan(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<ErasePlan, Error>> {
  const authorized = eraseAccess(access);
  if (!authorized.ok) return authorized;
  const target = eraseTarget(args);
  if (!target.ok) return target;

  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;
  const paths =
    target.value.kind === "path"
      ? [target.value.value]
      : loaded.value
          .filter((d) => (d.frontmatter.sources ?? []).includes(target.value.value))
          .map((d) => d.path)
          .sort();
  if (paths.length === 0) {
    return err(new Error(`vault_erase: no documents cite source_ref '${target.value.value}'`));
  }

  const blast = computeBlast({
    seeds: paths,
    reverseSource: buildReverseSourceMap(loaded.value),
    reverseLink: buildReverseLinkMap(loaded.value),
  });
  const head = await headFullSha(vaultRoot);
  if (!head.ok) return head;

  const visibleDownstream = blast.downstream.filter((entry) =>
    sourceReadable(null, authorized.value, entry.path),
  );
  const visibleTargets =
    target.value.kind === "path"
      ? paths
      : paths.filter((path) => sourceReadable(null, authorized.value, path));
  let primaryBlast = 0;
  let advisoryBlast = 0;
  for (const entry of visibleDownstream) {
    if (entry.dependency_type === "source") primaryBlast += 1;
    else advisoryBlast += 1;
  }

  const hashPayload = {
    version: 1,
    target: target.value,
    target_paths: paths,
    downstream: blast.downstream,
    vault_head: head.value,
    principal: authorized.value.user,
    role_name: authorized.value.roleName,
    readable_collections: [...(authorized.value.role?.read ?? [])].sort(),
  };
  const planHash = createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex");

  return ok({
    target: target.value,
    target_paths: visibleTargets,
    hidden_targets: bucketHiddenDownstream(paths.length - visibleTargets.length),
    downstream: visibleDownstream,
    primary_blast: primaryBlast,
    advisory_blast: advisoryBlast,
    hidden_downstream: bucketHiddenDownstream(blast.downstream.length - visibleDownstream.length),
    vault_head: head.value,
    plan_hash: planHash,
  });
}

// A content-free receipt line: the path (a breadcrumb, not the erased content),
// the principal, the instant, and what remained incomplete. Appended to an
// audit log so an erase is itself an auditable event.
async function appendReceipt(
  vaultRoot: string,
  record: { erased: string[]; incomplete: string[]; principal: string; refused: boolean },
): Promise<void> {
  const dir = join(vaultRoot, ".daftari");
  await mkdir(dir, { recursive: true });
  const line = `${JSON.stringify({
    kind: record.refused ? "erasure_refused" : "erasure",
    at: new Date().toISOString(),
    principal: record.principal,
    paths: record.erased,
    incomplete: record.incomplete,
  })}\n`;
  await appendFile(join(dir, "erasures.jsonl"), line, "utf8");
}

export async function vaultErase(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
  deps: GitEraseDeps = {},
): Promise<Result<EraseOutcome, Error>> {
  // 1. RBAC: the most destructive capability, checked first — and FAIL-CLOSED.
  // Every softer tool defaults to allow when no access context is present;
  // erase does not. An irreversible history rewrite + force-push is the one tool
  // where a missing identity must DENY, so a future wiring cannot inherit a
  // silent fail-open.
  const authorized = eraseAccess(access);
  if (!authorized.ok) return authorized;

  // 2. Exactly one target.
  const parsedTarget = eraseTarget(args);
  if (!parsedTarget.ok) return parsedTarget;
  const target = parsedTarget.value.value;

  // 3. Confirmation: the caller must echo the exact target — a typo aborts. The
  // expected value is NOT echoed in the error, so an agent caller cannot copy it
  // verbatim on retry (the confirmation must come from the caller's own intent).
  const confirm = typeof args.confirm === "string" ? args.confirm : undefined;
  if (confirm !== target) {
    return err(
      new Error(
        "vault_erase aborted: 'confirm' did not match — re-issue with 'confirm' set to the exact " +
          "path or source_ref you intend to erase (the expected value is not echoed here on purpose)",
      ),
    );
  }

  const plan = await vaultErasePlan(vaultRoot, args, authorized.value);
  if (!plan.ok) return plan;
  const suppliedPlanHash = args.plan_hash;
  const hasDownstream = plan.value.downstream.length > 0 || plan.value.hidden_downstream !== "none";
  if (
    (hasDownstream || suppliedPlanHash !== undefined) &&
    suppliedPlanHash !== plan.value.plan_hash
  ) {
    return err(stalePlanError());
  }

  // Resolve to the concrete path set to scrub.
  let paths: string[];
  if (parsedTarget.value.kind === "path") {
    paths = [target];
  } else {
    const resolved = await resolveSourceRefToPaths(vaultRoot, target);
    if (!resolved.ok) return resolved;
    if (resolved.value.length === 0) {
      return err(new Error(`vault_erase: no documents cite source_ref '${target}'`));
    }
    paths = resolved.value;
  }

  const acceptedPlanHash = plan.value.plan_hash;
  const scrub = await eraseFromHistory(vaultRoot, paths, {
    ...deps,
    validateBeforeRewrite: async () => {
      const fresh = await vaultErasePlan(vaultRoot, args, authorized.value);
      if (!fresh.ok) return fresh;
      return fresh.value.plan_hash === acceptedPlanHash ? ok(undefined) : err(stalePlanError());
    },
  });
  if (!scrub.ok) return scrub;
  const { refused } = scrub.value;
  const incomplete = [...scrub.value.incomplete];

  // H3: source_ref resolves against the CURRENT worktree only — history copies
  // of docs that cited the ref but were later deleted/superseded are not
  // covered. Say so loudly; those must be erased by path per historical name.
  if (parsedTarget.value.kind === "source_ref") {
    incomplete.push(
      "source-ref: resolved against the current worktree only — history copies of deleted or " +
        "superseded docs citing this ref are NOT covered; erase those by path",
    );
  }

  // On refuse, nothing was erased — the result must not read as a success.
  const erased = refused ? [] : scrub.value.paths;

  await appendReceipt(vaultRoot, {
    erased,
    incomplete,
    principal: authorized.value.user,
    refused,
  });

  const guidance = looksSecretShaped(target)
    ? "The erased target looks secret-shaped: a history rewrite cannot un-disclose what was " +
      "already pushed or cloned. ROTATE the secret now, then treat the old value as compromised."
    : undefined;

  return ok({
    erased,
    incomplete,
    refused,
    ...(guidance ? { guidance } : {}),
  });
}
