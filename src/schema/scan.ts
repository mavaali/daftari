import { stat } from "node:fs/promises";
import { isAbsolute, posix, relative } from "node:path";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import type { RawFrontmatterDocument } from "./infer.js";

export interface SchemaScanIssue {
  path: string;
  message: string;
}

export interface SchemaScan {
  filesScanned: number;
  documents: RawFrontmatterDocument[];
  issues: SchemaScanIssue[];
}

export function normalizeSchemaScope(scope: string | undefined): Result<string | undefined, Error> {
  if (scope === undefined) return ok(undefined);
  const trimmed = scope.trim().replaceAll("\\", "/");
  if (trimmed.length === 0) return err(new Error("scope cannot be empty"));
  if (isAbsolute(trimmed) || posix.isAbsolute(trimmed) || /^[A-Za-z]:\//.test(trimmed)) {
    return err(new Error(`scope escapes vault root: ${scope}`));
  }
  if (trimmed.split("/").includes("..")) {
    return err(new Error(`scope escapes vault root: ${scope}`));
  }
  const normalized = posix.normalize(trimmed).replace(/^\.\//, "").replace(/\/$/, "");
  return ok(normalized === "." ? undefined : normalized);
}

export async function scanVaultFrontmatter(
  vaultRoot: string,
  scope?: string,
): Promise<Result<SchemaScan, Error>> {
  const normalizedScope = normalizeSchemaScope(scope);
  if (!normalizedScope.ok) return normalizedScope;

  try {
    if (!(await stat(vaultRoot)).isDirectory()) {
      return err(new Error(`vault root is not a directory: ${vaultRoot}`));
    }
  } catch {
    return err(new Error(`vault root is not a directory: ${vaultRoot}`));
  }

  let canonicalScope: string | undefined;
  if (normalizedScope.value) {
    const resolvedScope = resolveVaultPath(vaultRoot, normalizedScope.value);
    if (!resolvedScope.ok) return err(new Error(`scope is not a directory: ${scope}`));
    try {
      if (!(await stat(resolvedScope.value.absPath)).isDirectory()) {
        return err(new Error(`scope is not a directory: ${scope}`));
      }
    } catch {
      return err(new Error(`scope is not a directory: ${scope}`));
    }
    canonicalScope = resolvedScope.value.relPath;
  }

  const listed = await listFiles(vaultRoot);
  if (!listed.ok) return listed;
  const selected = normalizedScope.value
    ? listed.value.filter((path) => path.startsWith(`${normalizedScope.value}/`))
    : listed.value;

  const documents: RawFrontmatterDocument[] = [];
  const issues: SchemaScanIssue[] = [];
  const seenCanonicalPaths = new Set<string>();
  for (const path of selected) {
    const resolved = resolveVaultPath(vaultRoot, path);
    if (!resolved.ok) {
      issues.push({ path, message: resolved.error.message });
      continue;
    }
    if (canonicalScope) {
      const fromScope = relative(canonicalScope, resolved.value.relPath);
      if (fromScope === "" || fromScope.startsWith("..") || isAbsolute(fromScope)) {
        issues.push({ path, message: `path escapes schema scope: ${path}` });
        continue;
      }
    }
    if (seenCanonicalPaths.has(resolved.value.relPath)) {
      issues.push({
        path,
        message: `duplicate canonical document skipped: ${resolved.value.relPath}`,
      });
      continue;
    }
    seenCanonicalPaths.add(resolved.value.relPath);
    const source = await readFile(resolved.value.absPath);
    if (!source.ok) {
      issues.push({ path, message: source.error.message });
      continue;
    }
    const parsed = parseDocument(source.value);
    if (!parsed.ok) {
      issues.push({ path, message: parsed.error.message });
      continue;
    }
    documents.push({ path: resolved.value.relPath, frontmatter: parsed.value.raw });
  }

  return ok({ filesScanned: selected.length, documents, issues });
}
