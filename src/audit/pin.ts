// src/audit/pin.ts
// `daftari audit --pin` / `--pin --apply` — backfills whole-file pins onto
// unpinned `describes` bindings. Spec: docs/superpowers/specs/2026-07-26-
// citation-anchors-jit-verification-design.md, Decision 5, hardened per the
// plan resolution (C6 dirty-tree skip, C10 live-holder refusal).
//
// Follows the `daftari backfill` plan/apply precedent (src/backfill/) with
// one deliberate difference: there is no persisted plan FILE. `--pin` (plan
// mode, the default) recomputes the proposal fresh every run and prints it;
// `--pin --apply` recomputes the SAME proposal and writes it in one pass —
// simpler than backfill's ratify-per-folder flow because a pin backfill is
// either wholly safe (clean tree) or wholly deferred (dirty tree), never
// partially ratified.

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { recordProvenance } from "../curation/provenance.js";
import { parseDocument } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../frontmatter/schema.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { isDaftariProcess, readLockfile } from "../lifecycle/lock.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import { serializeDocument } from "../tools/write.js";
import { loadConfig } from "../utils/config.js";
import { blobAtHead, commit, hashObjects } from "../utils/git.js";
import { collectRepos } from "./collect.js";
import { classifyDescribesEdges } from "./describes.js";
import { resolveSingleDocsRepo } from "./docs-repo.js";
import type { AuditConfig, DescribesEdge } from "./types.js";

export interface PinPlanEntry {
  path: string; // vault-relative doc path
  repo: string; // code repo name (matches code_repos)
  targetPath: string; // repo-relative code path
  oldEntry: string; // the describes entry as written
  newEntry: string; // oldEntry + "@<sha12>"
}

export interface PinSkip {
  path: string;
  repo: string;
  targetPath: string;
  reason: string;
}

export interface PinPlanResult {
  docsRepoPath: string;
  docsRepoName: string;
  proposals: PinPlanEntry[];
  skipped: PinSkip[];
  // Repo prefixes referenced by an unpinned binding that resolve in the
  // AUDIT's own registry but not in the docs vault's own `code_repos` —
  // C2's "unpinnable: not in code_repos" bucket, so the CLI-flag workflow
  // gets an actionable message instead of dead silence.
  unpinnable: string[];
}

function liveHolder(vaultRoot: string): { pid: number; mode: string } | null {
  const lock = readLockfile(vaultRoot);
  if (!lock.ok || lock.value === null) return null;
  if (!isDaftariProcess(lock.value.pid, vaultRoot)) return null; // stale, not live
  return { pid: lock.value.pid, mode: lock.value.mode ?? "stdio" };
}

// Plan mode: read-only. For every unpinned edge whose repo is in the docs
// vault's own `code_repos` and whose target resolves at HEAD, batch-hashes
// the working tree per repo and compares against HEAD's blob. A clean file
// proposes appending `@<sha12>` (HEAD's blob, so the pin is retrievable from
// the odb and intact-on-arrival by construction); a dirty one is skipped
// with the dirty-skip message (C6) rather than pinning an unretrievable
// working-tree blob. Whole-file pins only — a range is an author's judgment
// call a batch tool never invents (Decision 5).
export async function planPins(config: AuditConfig): Promise<Result<PinPlanResult, Error>> {
  const docsRepoPathOrErr = resolveSingleDocsRepo(config, "--pin");
  if (typeof docsRepoPathOrErr !== "string") return err(new Error(docsRepoPathOrErr.error));
  const docsRepoPath = docsRepoPathOrErr;

  const docsConfig = loadConfig(docsRepoPath);
  if (!docsConfig.ok) return docsConfig;
  const codeRepos = docsConfig.value.codeRepos;

  const collected = await collectRepos(config);
  if (!collected.ok) return err(new Error(collected.error.message));
  const snapshots = collected.value;
  const docsSnap = snapshots.find((s) => s.config.path === docsRepoPath);
  if (!docsSnap)
    return err(new Error("internal: docs repo snapshot not found among collected repos"));

  const auditRepoNames = new Set(snapshots.map((s) => s.config.name));
  const edges = classifyDescribesEdges(snapshots);
  const unpinned = edges.filter((e) => e.pin === null);

  const unpinnablePrefixes = new Set<string>();
  const candidates: Array<{ edge: DescribesEdge; repoAbsPath: string }> = [];
  for (const e of unpinned) {
    if (e.targetRepo in codeRepos) {
      candidates.push({ edge: e, repoAbsPath: codeRepos[e.targetRepo] as string });
    } else if (auditRepoNames.has(e.targetRepo)) {
      unpinnablePrefixes.add(e.targetRepo);
    }
  }

  // Candidates whose target resolves at HEAD only.
  const withHead: Array<{ edge: DescribesEdge; repoAbsPath: string; headSha: string }> = [];
  for (const c of candidates) {
    const head = await blobAtHead(c.repoAbsPath, c.edge.targetPath);
    if (!head.ok) continue; // not resolvable at HEAD -> not plannable
    withHead.push({ edge: c.edge, repoAbsPath: c.repoAbsPath, headSha: head.value });
  }

  const byRepo = new Map<string, typeof withHead>();
  for (const c of withHead) {
    const list = byRepo.get(c.repoAbsPath) ?? [];
    list.push(c);
    byRepo.set(c.repoAbsPath, list);
  }

  const proposals: PinPlanEntry[] = [];
  const skipped: PinSkip[] = [];
  for (const [repoAbsPath, list] of byRepo) {
    // A working-tree deletion must not fail the whole batch hash-object call
    // (C1's contract) — split out before hashing, reported as a dirty skip.
    const present = list.filter((c) => existsSync(`${repoAbsPath}/${c.edge.targetPath}`));
    const deleted = list.filter((c) => !present.includes(c));
    for (const c of deleted) {
      skipped.push({
        path: c.edge.sourcePath,
        repo: c.edge.targetRepo,
        targetPath: c.edge.targetPath,
        reason: "skipped: working tree differs from HEAD (commit first, then re-run)",
      });
    }
    if (present.length === 0) continue;

    const hashRes = await hashObjects(
      repoAbsPath,
      present.map((c) => c.edge.targetPath),
    );
    if (!hashRes.ok) {
      for (const c of present) {
        skipped.push({
          path: c.edge.sourcePath,
          repo: c.edge.targetRepo,
          targetPath: c.edge.targetPath,
          reason: `skipped: cannot hash working tree: ${hashRes.error.message}`,
        });
      }
      continue;
    }
    present.forEach((c, i) => {
      const workingHash = hashRes.value[i] as string;
      if (workingHash !== c.headSha) {
        skipped.push({
          path: c.edge.sourcePath,
          repo: c.edge.targetRepo,
          targetPath: c.edge.targetPath,
          reason: "skipped: working tree differs from HEAD (commit first, then re-run)",
        });
        return;
      }
      const shortSha = c.headSha.slice(0, 12);
      proposals.push({
        path: c.edge.sourcePath,
        repo: c.edge.targetRepo,
        targetPath: c.edge.targetPath,
        oldEntry: c.edge.raw,
        newEntry: `${c.edge.raw}@${shortSha}`,
      });
    });
  }

  return ok({
    docsRepoPath,
    docsRepoName: docsSnap.config.name,
    proposals,
    skipped,
    unpinnable: [...unpinnablePrefixes].sort(),
  });
}

export interface PinApplyResult {
  applied: string[];
  unchanged: string[];
  skipped: PinSkip[];
  commit: string | null;
}

// Apply: writes the SAME proposals planPins would compute for a clean tree.
// Refuses against a live holder of the docs vault's process.lock (C10) —
// unlike backfill's --scope ratification, there is no override flag in v1:
// the operator's remedy is stopping the server. Idempotent: already-pinned
// (byte-identical serialization) entries produce no write and no commit.
export async function applyPins(
  docsRepoPath: string,
  proposals: PinPlanEntry[],
  agent: string,
): Promise<Result<PinApplyResult, Error>> {
  const holder = liveHolder(docsRepoPath);
  if (holder) {
    return err(
      new Error(
        `daftari audit --pin --apply refuses: this vault is held by a live daftari ` +
          `process (pid=${holder.pid}, mode=${holder.mode}). Stop the server or run ` +
          `against an unheld vault.`,
      ),
    );
  }

  const config = loadConfig(docsRepoPath);
  if (!config.ok) return config;

  const byDoc = new Map<string, PinPlanEntry[]>();
  for (const p of proposals) {
    const list = byDoc.get(p.path) ?? [];
    list.push(p);
    byDoc.set(p.path, list);
  }

  const applied: string[] = [];
  const unchanged: string[] = [];
  const skipped: PinSkip[] = [];

  for (const [docPath, entries] of byDoc) {
    const resolved = resolveVaultPath(docsRepoPath, docPath);
    if (!resolved.ok) {
      skipped.push({ path: docPath, repo: "", targetPath: "", reason: resolved.error.message });
      continue;
    }
    const existing = await readFile(resolved.value.absPath);
    if (!existing.ok) {
      skipped.push({ path: docPath, repo: "", targetPath: "", reason: existing.error.message });
      continue;
    }
    const parsed = parseDocument(existing.value);
    if (!parsed.ok) {
      skipped.push({ path: docPath, repo: "", targetPath: "", reason: parsed.error.message });
      continue;
    }

    const replace = new Map(entries.map((e) => [e.oldEntry, e.newEntry]));
    // Already-pinned entries never touched (no auto-repair): only entries
    // whose exact `oldEntry` (unpinned, as classified at plan time) still
    // appear verbatim are replaced.
    const currentDescribes = parsed.value.frontmatter.describes;
    const newDescribes = currentDescribes.map((d) => replace.get(d) ?? d);
    const proposedFm = { ...parsed.value.frontmatter, describes: newDescribes };

    const { report } = validateFrontmatter(proposedFm as unknown as Record<string, unknown>);
    if (!report.valid) {
      skipped.push({
        path: docPath,
        repo: "",
        targetPath: "",
        reason: `proposed frontmatter is invalid: ${report.issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`,
      });
      continue;
    }

    const text = serializeDocument(
      proposedFm,
      parsed.value.content,
      config.value.schemaExtensions,
      parsed.value.raw,
    );
    if (text === existing.value) {
      unchanged.push(docPath);
      continue;
    }

    try {
      await writeFile(resolved.value.absPath, text, "utf-8");
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      skipped.push({ path: docPath, repo: "", targetPath: "", reason: `write failed: ${reason}` });
      continue;
    }
    applied.push(docPath);
  }

  let commitHash: string | null = null;
  if (applied.length > 0 && config.value.autoCommit) {
    const message = `daftari audit --pin: ${applied.length} doc(s) backfilled with code pins`;
    const committed = await commit(docsRepoPath, applied, message, agent, {
      gitDir: config.value.gitDir,
    });
    if (!committed.ok) return committed;
    commitHash = committed.value.hash;
  }

  for (const path of applied) {
    await recordProvenance(docsRepoPath, {
      tool: "daftari-audit",
      file: path,
      agent,
      action: "update",
    });
  }

  return ok({ applied, unchanged, skipped, commit: commitHash });
}
