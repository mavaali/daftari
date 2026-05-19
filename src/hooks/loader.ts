// Loads vault-supplied hook modules via ESM dynamic import. Paths are
// declared relative to the vault root and are rejected if they escape the
// vault. The module's default export must be a function — anything else is
// a malformed hook declaration. Hooks are trusted code per the v1 trust
// model; see README "Vault hooks".

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { err, ok, type Result } from "../frontmatter/types.js";
import type {
  HookDeclaration,
  LoadedHook,
  LoadedTransformHook,
  PreWriteHook,
  PreWriteTransformHook,
} from "./types.js";

// Resolves a vault-relative hook path to an absolute filesystem path,
// rejecting any path that escapes the vault root via `..` segments or an
// absolute path. Matches the same trust boundary that resolveVaultPath
// enforces for document writes.
function resolveHookPath(vaultRoot: string, hookPath: string): Result<string, Error> {
  if (isAbsolute(hookPath)) {
    return err(new Error(`hook path must be vault-root-relative, got absolute path: ${hookPath}`));
  }
  const abs = resolve(vaultRoot, hookPath);
  const rel = relative(vaultRoot, abs);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    return err(new Error(`hook path escapes vault root: ${hookPath}`));
  }
  if (!existsSync(abs)) {
    return err(new Error(`hook file not found: ${hookPath}`));
  }
  return ok(abs);
}

// Imports a hook module and returns its default export, which must be a
// function — anything else returns Result.err. Shared by both the pre_write
// and pre_write_transform loaders: the import, path-escape, and
// default-is-function checks are identical; only the typed cast the caller
// applies differs. The function is not validated beyond being callable —
// TypeScript types are erased at runtime.
async function importHookDefault(
  vaultRoot: string,
  decl: HookDeclaration,
): Promise<Result<(...args: unknown[]) => unknown, Error>> {
  const resolved = resolveHookPath(vaultRoot, decl.path);
  if (!resolved.ok) return resolved;

  let mod: { default?: unknown };
  try {
    const { mtimeMs } = await stat(resolved.value);
    // [HYPOTHESIS] Append mtime as a query suffix so Node's ESM module cache
    // returns a fresh import after the hook file is edited. Kill condition: if
    // Node ever stops caching ESM modules by URL, the suffix is harmless overhead.
    const importUrl = `${pathToFileURL(resolved.value).href}?t=${Math.floor(mtimeMs)}`;
    mod = (await import(importUrl)) as { default?: unknown };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`failed to load hook '${decl.path}': ${reason}`));
  }

  if (typeof mod.default !== "function") {
    return err(
      new Error(`hook '${decl.path}' must export a default function, got ${typeof mod.default}`),
    );
  }

  return ok(mod.default as (...args: unknown[]) => unknown);
}

// Loads one pre_write hook module. The module's default export must be a
// function; anything else returns Result.err.
export async function loadHook(
  vaultRoot: string,
  decl: HookDeclaration,
): Promise<Result<LoadedHook, Error>> {
  const fn = await importHookDefault(vaultRoot, decl);
  if (!fn.ok) return fn;
  return ok({ declaration: decl, hook: fn.value as PreWriteHook });
}

// Loads one pre_write_transform hook module. Mirrors loadHook — same import,
// path-escape, and default-is-function checks — but the loaded function is
// typed as a transform hook (returns Partial<Frontmatter>, not issues).
export async function loadPreWriteTransformHook(
  vaultRoot: string,
  decl: HookDeclaration,
): Promise<Result<LoadedTransformHook, Error>> {
  const fn = await importHookDefault(vaultRoot, decl);
  if (!fn.ok) return fn;
  return ok({ declaration: decl, hook: fn.value as PreWriteTransformHook });
}

// Loads every declared hook in order. Returns Result.err on the first load
// failure — a vault with a broken hook declaration refuses to write, same
// as a malformed config.
export async function loadHooks(
  vaultRoot: string,
  declarations: HookDeclaration[],
): Promise<Result<LoadedHook[], Error>> {
  const loaded: LoadedHook[] = [];
  for (const decl of declarations) {
    const result = await loadHook(vaultRoot, decl);
    if (!result.ok) return result;
    loaded.push(result.value);
  }
  return ok(loaded);
}

// Loads every declared pre_write_transform hook in order. Fails fast on the
// first bad declaration, identical to loadHooks.
export async function loadPreWriteTransformHooks(
  vaultRoot: string,
  declarations: HookDeclaration[],
): Promise<Result<LoadedTransformHook[], Error>> {
  const loaded: LoadedTransformHook[] = [];
  for (const decl of declarations) {
    const result = await loadPreWriteTransformHook(vaultRoot, decl);
    if (!result.ok) return result;
    loaded.push(result.value);
  }
  return ok(loaded);
}
