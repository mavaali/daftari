// `daftari okf import` — adopt an OKF bundle into a Daftari vault.
//
// Every non-reserved markdown file in the bundle is mapped to Daftari
// frontmatter (see okfToDaftari) and written into the target vault at the same
// relative path. A bundle produced by `daftari okf export` round-trips exactly
// via its `daftari` sidecar; a foreign bundle is mapped conservatively (imported
// docs land as drafts in the accumulation domain). Writes are auto-committed —
// git is Daftari's version layer — and the SQLite index is rebuilt so search
// sees the new docs immediately. `--dry-run` reports the plan and writes nothing.

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseDocument } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../frontmatter/schema.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { reindexVault } from "../search/reindex.js";
import { listFiles, readFile } from "../storage/local.js";
import { serializeDocument } from "../tools/write.js";
import { commit } from "../utils/git.js";
import { okfToDaftari } from "./map.js";
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
  return (OKF_RESERVED_FILES as readonly string[]).includes(basename(relPath));
}

export async function importBundle(
  bundleDir: string,
  vaultRoot: string,
  options: ImportOptions = {},
): Promise<Result<ImportResult, Error>> {
  const listed = await listFiles(bundleDir);
  if (!listed.ok) return err(listed.error);

  const agent = options.agent ?? DEFAULT_IMPORT_AGENT;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const dryRun = options.dryRun === true;

  const warnings: string[] = [];
  const plan: ImportPlanItem[] = [];
  const writtenPaths: string[] = [];
  let skipped = 0;

  for (const relPath of listed.value) {
    if (isReserved(relPath)) continue; // structural, not a concept doc

    const raw = await readFile(join(bundleDir, relPath));
    if (!raw.ok) {
      warnings.push(`could not read ${relPath}: ${raw.error.message}`);
      skipped++;
      continue;
    }

    const parsed = parseDocument(raw.value);
    if (!parsed.ok) {
      warnings.push(`could not parse ${relPath}: ${parsed.error.message}`);
      skipped++;
      continue;
    }

    const okfRaw = parsed.value.raw;
    const daftariRaw = okfToDaftari(okfRaw, { relPath, today, updatedBy: agent });
    const { frontmatter } = validateFrontmatter(daftariRaw);

    plan.push({
      relPath,
      collection: frontmatter.collection,
      title: frontmatter.title,
      roundTrip: Object.hasOwn(okfRaw, "daftari"),
    });

    if (dryRun) continue;

    const fileText = serializeDocument(frontmatter, parsed.value.content, [], daftariRaw);
    const targetPath = join(vaultRoot, relPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, fileText, "utf-8");
    writtenPaths.push(relPath);
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

  let commitHash: string | null = null;
  if (writtenPaths.length > 0) {
    const committed = await commit(
      vaultRoot,
      writtenPaths,
      `okf import: ${writtenPaths.length} document(s)`,
      agent,
    );
    if (committed.ok) commitHash = committed.value.hash;
    else warnings.push(`could not commit import: ${committed.error.message}`);
  }

  let reindexed = false;
  if (writtenPaths.length > 0) {
    const reindex = await reindexVault(vaultRoot);
    if (reindex.ok) reindexed = true;
    else warnings.push(`could not reindex vault: ${reindex.error.message}`);
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
}
