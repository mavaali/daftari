// Cross-vault federation: mount loading and alias-path dispatch (#297, spec
// 2026-08-15).
//
// Federation is read composition over sovereign vaults. Each referenced vault
// keeps its own policy (its config's `federation.principals` block grants
// access by authenticated principal, deny-all-guest default), its derived
// state stays private (nothing is ever created, opened-for-write, or WAL-
// opened under a referenced root), and the canonical process pays the full
// cost of its own view. A mount takes NO process lock: a federated reader
// only reads markdown files, which is what any editor or `grep` does today.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canRead, GUEST_ROLE } from "../access/rbac.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { directoryExists, listFiles } from "../storage/local.js";
import {
  configPath,
  type FederationConfig,
  type IndexedFieldDeclaration,
  loadConfig,
  type RoleConfig,
  type SchemaExtension,
} from "../utils/config.js";
import { clearIndexDirOverrides, setIndexDirOverride } from "./index-location.js";

export type MountState = "ok" | "unavailable";

export interface LoadedMount {
  alias: string;
  // Realpath'd mount root; null when the mount is optional and absent.
  root: string | null;
  state: MountState;
  // The role the referenced vault's `federation.principals` grants THIS
  // process's authenticated user, resolved against the referenced vault's own
  // `roles`. Null is the deny-all guest — unmapped principals are denied,
  // never granted. Only the `read` list is ever consulted (the mount is
  // read-only structurally, not by role configuration).
  role: RoleConfig | null;
  roleName: string;
  // The referenced vault's declared schema extensions — one of exactly two
  // things read from its config (with the policy surface). Used for the
  // advisory validation report on federated reads.
  schemaExtensions: SchemaExtension[];
  indexedFields: IndexedFieldDeclaration[];
  indexMode: "full" | "lexical";
}

export interface MountRegistry {
  mounts: Map<string, LoadedMount>;
}

// A caller path parsed as federated: `<alias>:<relPath>` where the prefix
// before the FIRST ':' exactly matches a declared alias.
export interface FederatedPath {
  alias: string;
  relPath: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Alias-path dispatch
// ---------------------------------------------------------------------------

// Collision safety is enforced, not assumed: ':' is a legal POSIX filename
// character, so dispatch never trusts the filesystem to keep the shapes
// apart. A path is federated ONLY when its first-':' prefix matches a
// declared alias; every other ':'-containing path stays a plain canonical
// path. The one ambiguous shape — a canonical file literally named
// `<alias>:...` — is excluded by the mount-time scan below plus the
// server-layer refusal of alias-prefixed paths on write tools.
export function parseFederatedPath(path: string, registry: MountRegistry): FederatedPath | null {
  const colon = path.indexOf(":");
  if (colon <= 0) return null;
  const alias = path.slice(0, colon);
  if (!registry.mounts.has(alias)) return null;
  const relPath = path.slice(colon + 1);
  return { alias, relPath, raw: path };
}

// Renders a mount-relative path back into its addressable `alias:path` form —
// the round-trip property: any path a federated tool returns is directly
// usable as the path argument to any federated read tool.
export function federatedPathOf(alias: string, relPath: string): string {
  return `${alias}:${relPath}`;
}

// ---------------------------------------------------------------------------
// Process-global registry
// ---------------------------------------------------------------------------

// One registry per process, set at startup — the same lifetime contract as the
// access identity and the embedding provider (setProvider). Null means no
// federation configured: every path is canonical and no refusal scan runs.
let activeRegistry: MountRegistry | null = null;

export function setMountRegistry(registry: MountRegistry | null): void {
  activeRegistry = registry;
}

export function getMountRegistry(): MountRegistry | null {
  return activeRegistry;
}

// Test-only hook, mirroring clearConfigCache: suites that mount fixture
// vaults must not leak the registry across cases. Index-dir overrides are
// registered per mount, so they clear with the registry.
export function clearMountRegistry(): void {
  activeRegistry = null;
  clearIndexDirOverrides();
}

// Where a mount's derived index lives: the CANONICAL vault's
// `.daftari/federation/<alias>/` (spec Decision 3). Registered as an
// index-location override at mount load, so every openIndexDb/reindex call
// against the mount root lands here by construction.
export function mountIndexDir(canonicalRoot: string, alias: string): string {
  return join(canonicalRoot, ".daftari", "federation", alias);
}

// ---------------------------------------------------------------------------
// Mount loading
// ---------------------------------------------------------------------------

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// True when `a` equals `b` or sits inside it.
function isWithin(a: string, b: string): boolean {
  const rel = relative(b, a);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Loads and validates the canonical vault's declared mounts. Everything here
// fails loud (the malformed-RBAC precedent): a missing required mount, a
// non-vault directory, nesting with the canonical root, a duplicate real
// path, or a canonical file shadowing a declared alias prefix all refuse
// startup. `notice` receives operator-facing lines (stderr, never tool
// output) — the deny-all-guest resolution notices and grant warnings.
export async function loadMounts(
  vaultRoot: string,
  federation: FederationConfig,
  user: string,
  notice: (line: string) => void,
): Promise<Result<MountRegistry, Error>> {
  const canonicalReal = realpathSync(resolve(vaultRoot));
  const mounts = new Map<string, LoadedMount>();
  const seenRealPaths = new Map<string, string>(); // realpath -> alias

  for (const decl of federation.mounts) {
    const target = resolve(canonicalReal, expandTilde(decl.path));

    if (!(await directoryExists(target))) {
      if (decl.optional) {
        mounts.set(decl.alias, {
          alias: decl.alias,
          root: null,
          state: "unavailable",
          role: null,
          roleName: GUEST_ROLE,
          schemaExtensions: [],
          indexedFields: [],
          indexMode: decl.index,
        });
        notice(`mount "${decl.alias}" is unavailable (${decl.path} not found) — optional, skipped`);
        continue;
      }
      return err(
        new Error(
          `mount "${decl.alias}": path not found: ${target} — create it, ` +
            `mark the mount optional: true, or remove the mount`,
        ),
      );
    }

    const real = realpathSync(target);

    // Nesting either direction is a startup error: a mount inside the
    // canonical vault would index the same files twice under two addresses,
    // and a canonical vault inside a mount would make the mount's "read-only"
    // promise cover its own writer.
    if (isWithin(real, canonicalReal) || isWithin(canonicalReal, real)) {
      return err(
        new Error(
          `mount "${decl.alias}": ${real} nests with the canonical vault ` +
            `${canonicalReal} — mounts must be disjoint directories`,
        ),
      );
    }
    const priorAlias = seenRealPaths.get(real);
    if (priorAlias !== undefined) {
      return err(
        new Error(
          `mount "${decl.alias}": ${real} is already mounted as "${priorAlias}" — ` +
            `the same vault cannot be mounted twice`,
        ),
      );
    }
    seenRealPaths.set(real, decl.alias);

    // A directory without a config is not a daftari vault: there is no policy
    // to govern reads of it, and deny-all-guest would make the mount silently
    // useless.
    if (!(await directoryExists(join(real, ".daftari")))) {
      return err(
        new Error(
          `mount "${decl.alias}": ${real} is not a daftari vault ` +
            `(no .daftari/config.yaml) — run daftari --init there, or remove the mount`,
        ),
      );
    }

    // The referenced vault's own config decides what this identity sees of
    // it. Exactly two things are read from it: the policy surface (roles +
    // federation.principals) and schema_extensions. Its hooks are NEVER
    // loaded or executed — vault-supplied modules from a mounted vault would
    // execute foreign code in the canonical process.
    const refConfig = loadConfig(real);
    if (!refConfig.ok) {
      return err(new Error(`mount "${decl.alias}": ${refConfig.error.message}`));
    }

    const grant = refConfig.value.federation?.principals?.[user];
    let role: RoleConfig | null = null;
    let roleName = GUEST_ROLE;
    if (grant === undefined) {
      // Unmapped ⇒ guest ⇒ deny-all. The mount then contributes nothing —
      // which, under omission, is indistinguishable from an empty vault.
      // Correct (no existence leak), but also the misconfiguration trap, so
      // the operator's stderr says so. Deliberately NOT a startup refusal:
      // that would make this process's boot contingent on a foreign vault's
      // policy file (spec Decision 2).
      notice(
        `mount "${decl.alias}" resolved to guest (deny-all): add a ` +
          `federation.principals entry for "${user}" in ` +
          `${configPath(decl.path)}`,
      );
    } else {
      const granted = refConfig.value.roles[grant.role];
      if (granted === undefined) {
        notice(
          `mount "${decl.alias}": principals entry for "${user}" names ` +
            `unknown role '${grant.role}' — resolved to guest (deny-all)`,
        );
      } else {
        role = granted;
        roleName = grant.role;
        // Only the granted role's `read` list is consulted; write-shaped
        // bits are confusing, not dangerous — the mount is read-only
        // structurally.
        if (granted.write.length > 0 || granted.promote || granted.ratify) {
          notice(
            `mount "${decl.alias}": role '${grant.role}' carries write/promote/ratify ` +
              `grants — ignored; mounts are read-only`,
          );
        }
      }
    }

    // Redirect the mount's derived index into the canonical tree BEFORE any
    // code path could open an index for this root.
    setIndexDirOverride(real, mountIndexDir(canonicalReal, decl.alias));

    mounts.set(decl.alias, {
      alias: decl.alias,
      root: real,
      state: "ok",
      role,
      roleName,
      schemaExtensions: refConfig.value.schemaExtensions,
      indexedFields: refConfig.value.indexedFields,
      indexMode: decl.index,
    });
  }

  // Mount-time collision scan (spec Decision 5): a canonical file whose path
  // begins with a declared alias plus ':' would be ambiguous with the
  // addressing scheme. The scan is against declared aliases only — ordinary
  // ':'-containing POSIX filenames remain untouched.
  const canonicalFiles = await listFiles(vaultRoot);
  if (!canonicalFiles.ok) return canonicalFiles;
  for (const relPath of canonicalFiles.value) {
    for (const alias of mounts.keys()) {
      if (relPath.startsWith(`${alias}:`)) {
        return err(
          new Error(
            `mount "${alias}": canonical vault contains "${relPath}", which ` +
              `shadows the mount's path prefix — rename the file or the alias`,
          ),
        );
      }
    }
  }

  return ok({ mounts });
}

// Read gate for a federated document, from the mount's principal-resolved
// role against the referenced vault's collection vocabulary. Kept here so
// every federated read surface applies the same rule.
export function mountCanRead(mount: LoadedMount, collection: string): boolean {
  return canRead(mount.role, collection);
}
