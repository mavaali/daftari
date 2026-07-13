// `daftari okf export` — render a Daftari vault as an OKF bundle.
//
// Each vault document becomes an OKF concept doc at the same relative path (so
// the collection folder layout is preserved), with OKF core frontmatter plus a
// verbatim `daftari` sidecar for lossless round-trip. Two reserved files are
// generated at the bundle root: index.md (a progressive-disclosure listing) and
// log.md (a chronological history, newest first). The source vault is never
// mutated — this is a pure read-then-write to a separate output directory.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { listFiles, readFile } from "../storage/local.js";
import { daftariToOkf, deriveDescription } from "./map.js";
import { OKF_INDEX_FILE, OKF_RESERVED_FILES, OKF_VERSION } from "./types.js";

export interface ExportOptions {
  // When set, only documents whose top-level directory (Daftari collection)
  // equals this value are exported.
  collection?: string;
}

export interface ExportResult {
  outDir: string;
  documentCount: number;
  skipped: number; // docs that failed to parse and were left out
  warnings: string[];
}

interface DocEntry {
  relPath: string;
  title: string;
  description: string | undefined;
  updated: string;
}

function collectionOf(relPath: string): string {
  const parts = relPath.split("/").filter((p) => p !== "");
  return parts.length > 1 ? parts[0] : "";
}

// Bundle-relative absolute link (leading "/"), the OKF form that stays stable if
// a doc is relocated.
function bundleLink(relPath: string): string {
  return `/${relPath}`;
}

function renderIndex(entries: DocEntry[]): string {
  const lines = ["# Index", ""];
  for (const e of entries) {
    const suffix = e.description ? ` — ${e.description}` : "";
    lines.push(`- [${e.title}](${bundleLink(e.relPath)})${suffix}`);
  }
  lines.push("");
  return matter.stringify(`\n${lines.join("\n")}`, { okf_version: OKF_VERSION });
}

function renderLog(entries: DocEntry[]): string {
  // Group by `updated` date, newest first. Entries with no usable date fall
  // under an "undated" bucket sorted last.
  const byDate = new Map<string, DocEntry[]>();
  for (const e of entries) {
    const key = e.updated || "undated";
    const bucket = byDate.get(key);
    if (bucket) bucket.push(e);
    else byDate.set(key, [e]);
  }
  const keys = [...byDate.keys()].sort((a, b) => {
    if (a === "undated") return 1;
    if (b === "undated") return -1;
    return a < b ? 1 : a > b ? -1 : 0; // descending
  });
  const lines = ["# Log", ""];
  for (const key of keys) {
    lines.push(`## ${key}`);
    for (const e of byDate.get(key) ?? []) {
      lines.push(`- [${e.title}](${bundleLink(e.relPath)})`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function exportBundle(
  vaultRoot: string,
  outDir: string,
  options: ExportOptions = {},
): Promise<Result<ExportResult, Error>> {
  const listed = await listFiles(vaultRoot);
  if (!listed.ok) return err(listed.error);

  const warnings: string[] = [];
  const entries: DocEntry[] = [];
  let skipped = 0;

  for (const relPath of listed.value) {
    if (options.collection !== undefined && collectionOf(relPath) !== options.collection) {
      continue;
    }

    const raw = await readFile(join(vaultRoot, relPath));
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

    const { frontmatter, content, raw: rawFm } = parsed.value;
    const okfFm = daftariToOkf(rawFm, frontmatter, content);
    const fileText = matter.stringify(content.startsWith("\n") ? content : `\n${content}`, okfFm);

    const targetPath = join(outDir, relPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, fileText, "utf-8");

    entries.push({
      relPath,
      title: typeof okfFm.title === "string" ? okfFm.title : relPath,
      description: deriveDescription(frontmatter, content),
      updated: frontmatter.updated,
    });
  }

  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  await mkdir(outDir, { recursive: true });

  // A vault doc named index.md / log.md at its root would occupy a reserved
  // path. Keep the author's content and skip generating that reserved file.
  const exportedPaths = new Set(entries.map((e) => e.relPath));
  for (const reserved of OKF_RESERVED_FILES) {
    if (exportedPaths.has(reserved)) {
      warnings.push(
        `vault contains a root '${reserved}' — kept as a concept doc, reserved file not generated`,
      );
      continue;
    }
    const text = reserved === OKF_INDEX_FILE ? renderIndex(entries) : renderLog(entries);
    await writeFile(join(outDir, reserved), text, "utf-8");
  }

  return ok({ outDir, documentCount: entries.length, skipped, warnings });
}
