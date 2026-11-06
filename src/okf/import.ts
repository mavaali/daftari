// `daftari okf import` — adopt an OKF bundle into a Daftari vault.
//
// Every non-reserved markdown file in the bundle is mapped to Daftari
// frontmatter (see okfToDaftari) and written into the target vault at the same
// relative path. A bundle produced by `daftari okf export` round-trips exactly
// via its `daftari` sidecar; a foreign bundle is mapped conservatively (imported
// docs land as drafts in the accumulation domain), with v0.2 trust signals
// informing the mapping — see okfToDaftari. Writes are auto-committed —
// git is Daftari's version layer — and the SQLite index is rebuilt so search
// sees the new docs immediately. `--dry-run` reports the plan and writes nothing.

import { lstatSync, realpathSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseDocument } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../frontmatter/schema.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { reindexVault } from "../search/reindex.js";
import { directoryExists, listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { serializeDocument } from "../tools/write.js";
import { catFileBlob, commit } from "../utils/git.js";
import { hasDaftariSidecar, isAttestedComputation, okfToDaftari } from "./map.js";
import { OKF_RESERVED_FILES } from "./types.js";

export interface ImportOptions {
  // Acting identity recorded in created/updated authorship and the commit.
  agent?: string;
  // Report the plan without writing, committing, or reindexing.
  dryRun?: boolean;
  // Today's date (YYYY-MM-DD), injectable so mapping/tests stay deterministic.
  today?: string;
}

export interface ImportPlanItem {
  relPath: string;
  collection: string;
  title: string;
  roundTrip: boolean; // true when a `daftari` sidecar drove the mapping
}

export interface ImportResult {
  vaultRoot: string;
  imported: number;
  skipped: number;
  commit: string | null;
  reindexed: boolean;
  dryRun: boolean;
  warnings: string[];
  plan: ImportPlanItem[];
}

const DEFAULT_IMPORT_AGENT = "agent:okf-import";

function isReserved(relPath: string): boolean {
  return (OKF_RESERVED_FILES as readonly string[]).includes(relPath);
}

// Check canonical targets too: an otherwise ordinary filename may be an alias
// into a control directory. Reuse storage's physical confinement boundary.
function importPath(root: string, relPath: string) {
  const resolved = resolveVaultPath(root, relPath);
  if (!resolved.ok) return resolved;
  // A dangling link is not a missing output: writes would follow its target.
  // Check each existing component, including not-yet-created descendants.
  let component = resolve(root);
  for (const part of relative(component, resolved.value.absPath).split("/")) {
    component = join(component, part);
    try {
      const entry = lstatSync(component);
      if (entry.isSymbolicLink()) {
        try {
          realpathSync(component);
        } catch {
          return err(new Error(`unresolvable import path: ${relPath}`));
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return err(new Error(`cannot inspect import path: ${relPath}`));
      }
    }
  }
  const parts = resolved.value.relPath.split("/");
  if (
    !resolved.value.relPath.endsWith(".md") ||
    parts.some((part) => part.startsWith(".") || part === "node_modules")
  ) {
    return err(new Error(`not an importable document path: ${relPath}`));
  }
  return resolved;
}

interface PreparedDocument {
  relPath: string;
  canonicalPath: string;
  text: string;
  unchanged: boolean;
}

export async function importBundle(
  bundleDir: string,
  vaultRoot: string,
  options: ImportOptions = {},
): Promise<Result<ImportResult, Error>> {
  if (!(await directoryExists(bundleDir)) || !(await directoryExists(vaultRoot))) {
    return err(new Error("import requires existing bundle and vault directories"));
  }
  const listed = await listFiles(bundleDir);
  if (!listed.ok) return err(listed.error);

  const agent = options.agent ?? DEFAULT_IMPORT_AGENT;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const dryRun = options.dryRun === true;

  const warnings: string[] = [];
  const plan: ImportPlanItem[] = [];
  const writtenPaths: string[] = [];
  const skipped = 0;
  const prepared: PreparedDocument[] = [];
  const destinations = new Set<string>();

  // Complete the read/validate/serialize plan before creating directories,
  // writing documents, initializing Git, or opening the index.
  try {
    for (const relPath of listed.value) {
      if (isReserved(relPath)) continue; // structural, not a concept doc

      const source = importPath(bundleDir, relPath);
      if (!source.ok) return err(new Error(`invalid import source: ${source.error.message}`));
      if (!(await stat(source.value.absPath)).isFile()) {
        return err(new Error(`import source is not a regular file: ${relPath}`));
      }
      const target = importPath(vaultRoot, relPath);
      if (!target.ok) return err(new Error(`invalid import destination: ${target.error.message}`));
      if (destinations.has(target.value.relPath)) {
        return err(new Error(`duplicate import destination: ${relPath}`));
      }
      destinations.add(target.value.relPath);
      let existing: string | undefined;
      try {
        if (!(await stat(target.value.absPath)).isFile()) {
          return err(new Error(`import destination is not a regular file: ${relPath}`));
        }
        const current = await readFile(target.value.absPath);
        if (!current.ok) return current;
        existing = current.value;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const raw = await readFile(source.value.absPath);
      if (!raw.ok) return err(new Error(`could not read ${relPath}: ${raw.error.message}`));

      const parsed = parseDocument(raw.value);
      if (!parsed.ok) {
        return err(new Error(`could not parse ${relPath}: ${parsed.error.message}`));
      }

      const okfRaw = parsed.value.raw;
      const daftariRaw = okfToDaftari(okfRaw, { relPath, today, updatedBy: agent });
      const { frontmatter, report } = validateFrontmatter(daftariRaw);
      if (!report.valid) {
        const issues = report.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
        return err(new Error(`invalid imported frontmatter in ${relPath}: ${issues}`));
      }

      const roundTrip = hasDaftariSidecar(okfRaw);

      // Advisory only, never enforcement: a bundle's self-declared type must not
      // buy write protection. The operator reviews and elevates deliberately.
      if (isAttestedComputation(okfRaw.type) && !roundTrip) {
        warnings.push(
          `${relPath}: Attested Computation imported WITHOUT write protection — ` +
            `review it, then elevate with vault_set_tier (tier: source) if this vault should enforce it`,
        );
      }

      plan.push({
        relPath,
        collection: frontmatter.collection,
        title: frontmatter.title,
        roundTrip,
      });

      const fileText = serializeDocument(frontmatter, parsed.value.content, [], daftariRaw);
      const output = parseDocument(fileText);
      if (!output.ok)
        return err(new Error(`invalid import output for ${relPath}: ${output.error.message}`));
      prepared.push({
        relPath,
        canonicalPath: target.value.relPath,
        text: fileText,
        unchanged: existing === fileText,
      });
    }
  } catch (e) {
    return err(new Error(`import preflight failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  for (const path of destinations) {
    let parent = dirname(path);
    while (parent !== ".") {
      if (destinations.has(parent)) {
        return err(new Error(`import destination is also a planned directory: ${parent}`));
      }
      parent = dirname(parent);
    }
  }

  if (dryRun) {
    return ok({
      vaultRoot,
      imported: plan.length,
      skipped,
      commit: null,
      reindexed: false,
      dryRun: true,
      warnings,
      plan,
    });
  }

  // Resolve the whole plan once more before mutation, then each destination
  // immediately before its write. Never silently redirect a prepared write.
  for (const doc of prepared) {
    const target = importPath(vaultRoot, doc.relPath);
    if (!target.ok) return target;
    if (target.value.relPath !== doc.canonicalPath) {
      return err(new Error(`import destination changed after preflight: ${doc.relPath}`));
    }
  }
  for (const doc of prepared) {
    if (doc.unchanged) continue;
    try {
      const target = importPath(vaultRoot, doc.relPath);
      if (!target.ok) throw target.error;
      if (target.value.relPath !== doc.canonicalPath) {
        throw new Error(`import destination changed after preflight: ${doc.relPath}`);
      }
      await mkdir(dirname(target.value.absPath), { recursive: true });
      await writeFile(target.value.absPath, doc.text, "utf-8");
      writtenPaths.push(doc.canonicalPath);
    } catch (e) {
      return err(
        new Error(
          `import incomplete: write failed for ${doc.relPath} after ${writtenPaths.length} document(s) written; ` +
            `files may have changed, no import commit or reindex completed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  let commitHash: string | null = null;
  let phase = "commit";
  try {
    // Existing bytes are not proof of a completed import: a previous attempt
    // may have failed its commit or reindex. Retry those steps even when there
    // is nothing to rewrite, without manufacturing an empty Git commit.
    const commitPaths: string[] = [];
    for (const doc of prepared) {
      const prior = await catFileBlob(vaultRoot, `HEAD:./${doc.canonicalPath}`);
      if (!prior.ok || prior.value !== doc.text) commitPaths.push(doc.canonicalPath);
    }
    if (commitPaths.length > 0) {
      const committed = await commit(
        vaultRoot,
        commitPaths,
        `okf import: ${commitPaths.length} document(s)`,
        agent,
      );
      if (committed.ok) commitHash = committed.value.hash;
      else
        return err(
          new Error(
            `import incomplete: ${writtenPaths.length} document(s) written but commit failed; files remain on disk: ${committed.error.message}`,
          ),
        );
    }

    phase = "reindex";
    let reindexed = false;
    if (prepared.length > 0) {
      const reindex = await reindexVault(vaultRoot);
      if (reindex.ok) {
        const failedImports = reindex.value.skipped.filter((doc) => destinations.has(doc.path));
        if (failedImports.length > 0) {
          return err(
            new Error(
              `import incomplete: reindex skipped imported documents: ${failedImports.map((doc) => `${doc.path}: ${doc.reason}`).join("; ")}`,
            ),
          );
        }
        for (const doc of reindex.value.skipped) {
          warnings.push(`reindex skipped ${doc.path}: ${doc.reason}`);
        }
        for (const doc of reindex.value.invalidFrontmatter) {
          warnings.push(`reindex validation warning for ${doc.path}: ${doc.reason}`);
        }
        reindexed = true;
      } else
        return err(
          new Error(
            `import incomplete: documents ${commitHash ? `committed as ${commitHash}` : "already committed"}, but reindex failed: ${reindex.error.message}`,
          ),
        );
    }

    return ok({
      vaultRoot,
      imported: writtenPaths.length,
      skipped,
      commit: commitHash,
      reindexed,
      dryRun: false,
      warnings,
      plan,
    });
  } catch (e) {
    return err(
      new Error(
        `import incomplete: ${phase} failed after ${writtenPaths.length} document(s) written` +
          `${commitHash ? ` (commit ${commitHash})` : ""}; files remain on disk: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}
