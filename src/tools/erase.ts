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
// Only then does it dispatch the history rewrite (src/utils/git-erase.ts) and
// append a content-free receipt to .daftari/erasures.jsonl. For a secret-shaped
// target it returns rotate-first guidance: a history rewrite cannot un-disclose
// what was already pushed.

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AccessContext } from "../access/rbac.js";
import { canErase } from "../access/rbac.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { eraseFromHistory, type GitEraseDeps } from "../utils/git-erase.js";

export interface EraseOutcome {
  /** Vault-relative paths that were scrubbed. */
  erased: string[];
  /** Anything the scrub could not guarantee (see EraseResult.incomplete). */
  incomplete: string[];
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
    .map((d) => d.path);
  return ok(paths);
}

// A content-free receipt line: the path (a breadcrumb, not the erased content),
// the principal, the instant, and what remained incomplete. Appended to an
// audit log so an erase is itself an auditable event.
async function appendReceipt(
  vaultRoot: string,
  record: { erased: string[]; incomplete: string[]; principal: string },
): Promise<void> {
  const dir = join(vaultRoot, ".daftari");
  await mkdir(dir, { recursive: true });
  const line = `${JSON.stringify({
    kind: "erasure",
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
  // 1. RBAC: the most destructive capability, checked first.
  if (access && !canErase(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot erase from history`));
  }

  // 2. Exactly one target.
  const path = typeof args.path === "string" ? args.path : undefined;
  const sourceRef = typeof args.source_ref === "string" ? args.source_ref : undefined;
  if ((path && sourceRef) || (!path && !sourceRef)) {
    return err(new Error("vault_erase requires exactly one of 'path' or 'source_ref'"));
  }
  const target = (path ?? sourceRef) as string;

  // 3. Confirmation: the caller must echo the exact target — a typo aborts.
  const confirm = typeof args.confirm === "string" ? args.confirm : undefined;
  if (confirm !== target) {
    return err(
      new Error(`vault_erase aborted: 'confirm' must echo the target exactly ('${target}')`),
    );
  }

  // Resolve to the concrete path set to scrub.
  let paths: string[];
  if (path !== undefined) {
    paths = [path];
  } else {
    const resolved = await resolveSourceRefToPaths(vaultRoot, sourceRef as string);
    if (!resolved.ok) return resolved;
    if (resolved.value.length === 0) {
      return err(new Error(`vault_erase: no documents cite source_ref '${sourceRef}'`));
    }
    paths = resolved.value;
  }

  const scrub = await eraseFromHistory(vaultRoot, paths, deps);
  if (!scrub.ok) return scrub;

  await appendReceipt(vaultRoot, {
    erased: paths,
    incomplete: scrub.value.incomplete,
    principal: access?.user ?? "cli",
  });

  const guidance = looksSecretShaped(target)
    ? "The erased target looks secret-shaped: a history rewrite cannot un-disclose what was " +
      "already pushed or cloned. ROTATE the secret now, then treat the old value as compromised."
    : undefined;

  return ok({
    erased: paths,
    incomplete: scrub.value.incomplete,
    ...(guidance ? { guidance } : {}),
  });
}
