// Vault hooks: vault-owner-supplied code that participates in pre-write
// validation. See README "Vault hooks" for the trust model. v1 is sync,
// advisory-as-issues (issues block writes the same way built-in schema
// validation does), and runs in declared order with every hook always called.

import type { Frontmatter, ValidationIssue } from "../frontmatter/types.js";

// The operation the write tool is about to perform. Matches the action that
// will be recorded in provenance and the auto-commit message. v1 fires hooks
// on the three frontmatter-author operations only; vault_promote and
// vault_deprecate change frontmatter in narrowly defined ways and bypass
// hooks. See issue #29 for the rationale.
export type HookOperation = "create" | "update" | "append";

// Read-only context handed to every pre-write hook. The vault path is
// relative to the vault root. The hook receives the frontmatter as it stands
// AFTER built-in schema validation has filled defaults — hooks never see a
// half-validated frontmatter.
export interface HookContext {
  path: string;
  operation: HookOperation;
}

// A pre-write hook signature. Synchronous: the write lock is held while
// hooks run, so any I/O would extend the critical section. Hooks return
// ValidationIssue[]; an empty array means no findings. A hook that throws
// is converted into a single synthetic ValidationIssue at error severity
// (severity does not exist in the v1 type — see #29 for the dialogue).
export type PreWriteHook = (
  frontmatter: Record<string, unknown>,
  context: HookContext,
) => ValidationIssue[];

// A pre-write *transform* hook. Runs BEFORE built-in schema validation, so it
// can derive or override frontmatter fields the validator would otherwise
// reject as missing or wrong. Returns a Partial<Frontmatter> patch — the
// runner merges it Object.assign-style (shallow, last-writer-wins) into the
// candidate frontmatter before validation. A transform hook refuses by
// throwing; it does NOT return ValidationIssue[]. See README "Transform
// hooks".
export type PreWriteTransformHook = (
  frontmatter: Record<string, unknown>,
  context: HookContext,
) => Partial<Frontmatter>;

// One declaration in .daftari/config.yaml under `hooks.pre_write` or
// `hooks.pre_write_transform`. The path is vault-root-relative; the loader
// rejects any path that escapes the vault. Both hook surfaces share this
// declaration shape — only the phase the hook runs in differs.
export interface HookDeclaration {
  path: string;
}

// The parsed `hooks` block from .daftari/config.yaml. Ordering is
// significant within each list: hooks run in declared order. Across phases
// the order is fixed regardless of config layout — every pre_write_transform
// hook runs before validation, every pre_write hook runs after it.
export interface HookConfig {
  preWrite: HookDeclaration[];
  preWriteTransform: HookDeclaration[];
}

// The result of loading a hook module: either a callable hook or a load-time
// error. Load failures are themselves loud — a malformed hooks block fails
// the write loudly, matching the loud-config contract.
export interface LoadedHook {
  declaration: HookDeclaration;
  hook: PreWriteHook;
}

// The result of loading a pre-write transform hook module. Parallel to
// LoadedHook; the only difference is the hook's call signature.
export interface LoadedTransformHook {
  declaration: HookDeclaration;
  hook: PreWriteTransformHook;
}
