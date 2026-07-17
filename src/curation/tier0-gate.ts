// Tier 0 ratify gate (#232 via #236 QW1).
//
// vault_ratify calls this before dispatching an approved action. It refuses
// an approval that would INTRODUCE a certain structural defect — it never
// judges pre-existing vault mess (that is `daftari lint`'s job), so one bad
// document elsewhere cannot block every ratification. Direct writes stay
// unblocked: curation stays advisory, and the gate lives only at the
// ratification control point, which is already the human-judgment tier.
//
// Existence discipline (2026-07-14 spec / #235): the refusal message names a
// violating document only when the caller can read it. Canonical dependents
// in unreadable collections surface as a coarsened bucket (none|some|many),
// never as names or exact counts. A non-canonical SOURCE of the target is
// named by path even when unreadable — the path is already disclosed by the
// target's own frontmatter — but its status is withheld.

import { ok, type Result } from "../frontmatter/types.js";
import { isVaultPathLike } from "./lint.js";
import { bucketHiddenDownstream, type HiddenDownstream } from "./tension-blast.js";
import { buildPathIndexes, loadDocuments, resolveLink } from "./vault-docs.js";

// Action types whose ratification changes a lifecycle status and can
// therefore introduce a Tier 0 violation. Everything else passes untouched.
const GATED_ACTIONS = new Set(["promote", "deprecate", "supersede"]);

export interface Tier0GateVerdict {
  ok: boolean;
  // Human-readable violation lines; only caller-visible paths are named.
  violations: string[];
  // Coarsened count of violating canonical dependents the caller cannot see.
  hiddenDependents: HiddenDownstream;
}

export async function tier0GateForAction(
  vaultRoot: string,
  action: { actionType: string; targetPath: string },
  pathVisible?: (path: string) => boolean,
): Promise<Result<Tier0GateVerdict, Error>> {
  const pass: Tier0GateVerdict = { ok: true, violations: [], hiddenDependents: "none" };
  if (!GATED_ACTIONS.has(action.actionType)) return ok(pass);

  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;
  const docs = loaded.value;
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const { byPath: pathIndex, byBasename: basenameIndex } = buildPathIndexes(docs);

  // A missing target is the dispatching write tool's error to report — the
  // gate only judges structural consequences of a status change that CAN run.
  const target = byPath.get(action.targetPath);
  if (!target) return ok(pass);

  const violations: string[] = [];
  let hiddenDependentCount = 0;

  if (action.actionType === "promote") {
    // The target becomes canonical: certification requires resolvable sources
    // (referential integrity) that are themselves canonical (lifecycle).
    for (const raw of target.frontmatter.sources) {
      const resolved = resolveLink(raw, target.path, pathIndex, basenameIndex);
      if (!resolved || resolved === target.path) {
        if (isVaultPathLike(raw)) {
          violations.push(`would certify a doc with a broken source ref: ${raw}`);
        }
        continue;
      }
      const status = byPath.get(resolved)?.frontmatter.status;
      if (status !== "canonical") {
        const visible = pathVisible?.(resolved) ?? true;
        violations.push(
          `would create a canonical dependency on a non-canonical source: ` +
            `${resolved}${visible ? ` (${status})` : " (status withheld)"}`,
        );
      }
    }
  } else {
    // deprecate / supersede: the target leaves canonical standing. Any
    // canonical doc sourcing it would become a lifecycle violation.
    for (const doc of docs) {
      if (doc.frontmatter.status !== "canonical" || doc.path === target.path) continue;
      const dependsOnTarget = doc.frontmatter.sources.some(
        (raw) => resolveLink(raw, doc.path, pathIndex, basenameIndex) === target.path,
      );
      if (!dependsOnTarget) continue;
      if (pathVisible?.(doc.path) ?? true) {
        violations.push(`canonical dependent would be left on a dead source: ${doc.path}`);
      } else {
        hiddenDependentCount += 1;
      }
    }
  }

  const hiddenDependents = bucketHiddenDownstream(hiddenDependentCount);
  return ok({
    ok: violations.length === 0 && hiddenDependents === "none",
    violations,
    hiddenDependents,
  });
}
