# Obsidian Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user adopt an existing Obsidian vault into Daftari in place via `daftari import obsidian <vault>`, an Obsidian-aware wrapper over the existing `backfill` machinery.

**Architecture:** Add two small pure transforms (inline `#tag` harvest, Web Clipper `source`→`sources[]`) that enrich derived frontmatter only when an `obsidian` flag is set. Thread that flag through `deriveProposed` → `generatePlan` → `runBackfill`. Add a thin `runImport` CLI adapter that parses `obsidian <vault>`, flips the flag on, and delegates to the existing backfill plan/apply flow. The non-obsidian path stays byte-identical, so all existing backfill tests remain green.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, gray-matter, `glob`, better-sqlite3. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-06-19-obsidian-adoption-design.md](docs/superpowers/specs/2026-06-19-obsidian-adoption-design.md)

---

## Design decisions locked by the spec (read before starting)

- **In-place only.** No `--target`/copy mode. `<vault>` is both source and target.
- **Never convert wikilinks.** `resolveLink` (`src/curation/vault-docs.ts:77`) already resolves them. Do nothing to wikilinks.
- **No merge logic.** `deriveProposed` already merges field-by-field (present preserved, missing filled). Reuse it; do not reimplement.
- **No `type` field.** Daftari has no such built-in.
- **Frontmatter fill is deliberate.** No auto-stamp, no watcher changes. The watcher already indexes new notes live; filling is a re-run of the adopt pass (already incremental via `classifyDoc`).
- **No new reindex code.** The server's startup freshness check + watcher already keep the index honest after an apply (same as `backfill` today). The import "Next steps" output points the user at `daftari --vault <vault> ...`, which reindexes on start.

## File structure

- **Create** `src/backfill/obsidian.ts` — two pure functions: `harvestInlineTags(body)`, `webClipperSources(raw)`. Obsidian-specific, no I/O.
- **Create** `test/backfill/obsidian.test.ts` — unit tests for the two pure functions.
- **Modify** `src/backfill/derive.ts` — add `obsidian?: boolean` to `DeriveInputs`; when set, union inline tags into `tags` and map `source`→`sources` (with honest derivation labels). Guarded so `obsidian` unset ⇒ identical output.
- **Modify** `test/backfill/derive.test.ts` — add obsidian-mode cases.
- **Modify** `src/backfill/plan.ts` — add `obsidian?: boolean` to `GeneratePlanOptions`; pass through to `deriveProposed`.
- **Modify** `test/backfill/plan.test.ts` — assert obsidian flag reaches the proposal.
- **Modify** `src/backfill/index.ts` — `runBackfill(argv, opts?)` gains `opts.obsidian` (threaded to `generatePlan`). No behavior change when `opts` omitted.
- **Create** `src/import/index.ts` — `runImport(argv)`: parse `obsidian <vault> [flags]`, own help, delegate to `runBackfill` with the obsidian flag on.
- **Create** `test/import/index.test.ts` — arg parsing + delegation + unsupported-type error.
- **Modify** `src/cli.ts` — route `argv[0] === "import"` to `runImport`; add to `USAGE`.
- **Modify** `test/cli.test.ts` (or wherever CLI routing is tested) — route assertion.
- **Modify** `CHANGELOG.md` — `[Unreleased]` entry. (Version bump + npm publish are Mihir's release step — do not bump or publish.)

---

## Task 1: Inline `#tag` harvester

**Files:**
- Create: `src/backfill/obsidian.ts`
- Test: `test/backfill/obsidian.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/backfill/obsidian.test.ts
import { describe, expect, it } from "vitest";
import { harvestInlineTags } from "../../src/backfill/obsidian.js";

describe("harvestInlineTags", () => {
  it("finds simple and nested tags, order-preserved and deduped", () => {
    expect(harvestInlineTags("intro #alpha then #beta/gamma and #alpha again")).toEqual([
      "alpha",
      "beta/gamma",
    ]);
  });
  it("ignores ATX headings (# followed by space)", () => {
    expect(harvestInlineTags("# Heading\n## Sub\n#realtag")).toEqual(["realtag"]);
  });
  it("ignores tags inside fenced code blocks", () => {
    expect(harvestInlineTags("```\n#notatag\n```\n#yes")).toEqual(["yes"]);
  });
  it("ignores tags inside inline code", () => {
    expect(harvestInlineTags("use `#define` in C, but #macro is a tag")).toEqual(["macro"]);
  });
  it("does not match a # in the middle of a word or URL", () => {
    expect(harvestInlineTags("see http://x.com/page#frag and foo#bar")).toEqual([]);
  });
  it("requires at least one letter (so #1234 is not a tag)", () => {
    expect(harvestInlineTags("#1234 #2026 #v2")).toEqual(["v2"]);
  });
  it("returns [] for a body with no tags", () => {
    expect(harvestInlineTags("plain text, no tags")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/backfill/obsidian.test.ts`
Expected: FAIL — `harvestInlineTags` not exported / module missing.

- [ ] **Step 3: Implement**

```typescript
// src/backfill/obsidian.ts
//
// Obsidian-specific derivation helpers used only by the `daftari import obsidian`
// path. Pure: no I/O. Kept out of derive.ts so the general backfill derivation
// stays Obsidian-agnostic.

// An Obsidian inline tag: "#tag" or "#parent/child". Rules encoded here:
//   - preceded by start-of-line or whitespace (so "foo#bar" and a URL
//     "page#frag" never match),
//   - NOT followed by a space (that is a Markdown ATX heading, "# Title"),
//   - chars are letters / digits / "_" / "-" / "/",
//   - must contain at least one ASCII letter (Obsidian rejects purely numeric
//     "#1234"; we use "has a letter" as a simple, safe approximation).
// Non-ASCII/unicode tags are not harvested in v1 (documented limitation).
const INLINE_TAG = /(?:^|\s)#([A-Za-z0-9_/-]*[A-Za-z][A-Za-z0-9_/-]*)/g;

export function harvestInlineTags(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    // Toggle fenced code state on ``` or ~~~ (allowing leading whitespace).
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Blank out inline code spans so `#notatag` inside backticks is ignored.
    const noCode = line.replace(/`[^`]*`/g, " ");
    for (const m of noCode.matchAll(INLINE_TAG)) {
      // Trim trailing "-"/"/" punctuation (e.g. "#tag/" → "tag").
      const tag = (m[1] as string).replace(/[/-]+$/, "");
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      found.push(tag);
    }
  }
  return found;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/backfill/obsidian.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backfill/obsidian.ts test/backfill/obsidian.test.ts
git commit -m "feat(import): inline #tag harvester for Obsidian adoption"
```

---

## Task 2: Web Clipper `source` → `sources[]` mapper

**Files:**
- Modify: `src/backfill/obsidian.ts`
- Test: `test/backfill/obsidian.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// add to test/backfill/obsidian.test.ts
import { webClipperSources } from "../../src/backfill/obsidian.js";

describe("webClipperSources", () => {
  it("returns [url] when raw.source is a URL string and sources is absent", () => {
    expect(webClipperSources({ source: "https://example.com/post" })).toEqual([
      "https://example.com/post",
    ]);
  });
  it("returns undefined when sources is already present and non-empty", () => {
    expect(
      webClipperSources({ source: "https://x.com", sources: ["already"] }),
    ).toBeUndefined();
  });
  it("returns undefined when there is no source", () => {
    expect(webClipperSources({})).toBeUndefined();
    expect(webClipperSources({ source: "" })).toBeUndefined();
    expect(webClipperSources({ source: 42 })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/backfill/obsidian.test.ts`
Expected: FAIL — `webClipperSources` not exported.

- [ ] **Step 3: Implement**

```typescript
// append to src/backfill/obsidian.ts

// Obsidian Web Clipper writes the captured page URL into a singular `source`
// frontmatter field. Daftari's equivalent is the plural `sources` array. Map it
// when `sources` is absent/empty; the original `source` key is left untouched
// (it survives as a custom field via serializeDocument's raw pass-through), so
// nothing is moved or lost — `sources` is additively populated.
export function webClipperSources(raw: Record<string, unknown>): string[] | undefined {
  const existing = raw.sources;
  if (Array.isArray(existing) && existing.length > 0) return undefined;
  const source = raw.source;
  if (typeof source === "string" && source.trim().length > 0) return [source.trim()];
  return undefined;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/backfill/obsidian.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backfill/obsidian.ts test/backfill/obsidian.test.ts
git commit -m "feat(import): map Web Clipper source to Daftari sources[]"
```

---

## Task 3: Thread `obsidian` into `deriveProposed`

**Files:**
- Modify: `src/backfill/derive.ts` (add field to `DeriveInputs`; enrich tags/sources)
- Test: `test/backfill/derive.test.ts`

Behavior when `obsidian: true`:
- **tags:** union of present frontmatter tags (first, order-preserved) and harvested inline tags (appended if not already present). Label: `"preserved"` if raw had tags; `"inline-tags"` if tags came only from the body; `"empty"` if neither.
- **sources:** if raw `sources` absent/empty and `webClipperSources` returns a URL, use it with label `"web-clipper-source"`; otherwise the existing `resolve("sources", …)` behavior.
- When `obsidian` is unset/false: **identical** to today (no inline scan, no source mapping).

- [ ] **Step 1: Write failing tests**

```typescript
// add to test/backfill/derive.test.ts
describe("deriveProposed — obsidian mode", () => {
  const base = {
    relPath: "notes/x.md",
    git: { created: null, updated: null, author: null },
    mtimeDate: "2026-06-19",
    identityMap: {},
    invoker: "human:tester",
  };

  it("unions inline #tags with frontmatter tags", () => {
    const { proposed, derivation } = deriveProposed({
      ...base,
      body: "body with #frombody and #shared",
      raw: { tags: ["fromfm", "shared"] },
      obsidian: true,
    });
    expect(proposed.tags).toEqual(["fromfm", "shared", "frombody"]);
    expect(derivation.tags).toBe("preserved");
  });

  it("harvests inline tags when frontmatter has none", () => {
    const { proposed, derivation } = deriveProposed({
      ...base,
      body: "see #alpha and #beta",
      raw: {},
      obsidian: true,
    });
    expect(proposed.tags).toEqual(["alpha", "beta"]);
    expect(derivation.tags).toBe("inline-tags");
  });

  it("maps Web Clipper source into sources[]", () => {
    const { proposed, derivation } = deriveProposed({
      ...base,
      body: "clip body",
      raw: { source: "https://example.com/post" },
      obsidian: true,
    });
    expect(proposed.sources).toEqual(["https://example.com/post"]);
    expect(derivation.sources).toBe("web-clipper-source");
  });

  it("is identical to default mode when obsidian is unset (no inline scan)", () => {
    const off = deriveProposed({ ...base, body: "#alpha", raw: {} });
    expect(off.proposed.tags).toEqual([]);
    expect(off.derivation.tags).toBe("empty");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/backfill/derive.test.ts`
Expected: FAIL — obsidian field unknown / tags not unioned.

- [ ] **Step 3: Implement**

In `src/backfill/derive.ts`:

1. Add import at top:
```typescript
import { harvestInlineTags, webClipperSources } from "./obsidian.js";
```

2. Add to `DeriveInputs` (after `invoker`):
```typescript
  // When true, apply Obsidian-aware enrichment: harvest inline #tags into
  // `tags` and map a Web Clipper `source` into `sources`. Default/false leaves
  // derivation byte-identical to the general backfill path.
  obsidian?: boolean;
```

3. In `deriveProposed`, **build on top of the existing `resolve()` results** — do NOT rebuild `tags`/`sources` from scratch. This is the critical correctness point: `resolve()` already preserves a present value verbatim (including a non-array `tags: "foo"`, which `test/backfill/derive.test.ts:238` asserts) and records the right derivation label. We only *append* inline tags / *substitute* a clipped source, and only in obsidian mode. Before building the `proposed` literal, add:

```typescript
  // Obsidian-aware tags: take resolve()'s value (present value preserved
  // verbatim — possibly a non-array — else []), then append harvested inline
  // tags ONLY when in obsidian mode and the base is an array. Never coerce or
  // rebuild: a non-array preserved value passes through untouched, so the
  // non-obsidian path and the malformed-tags test stay byte-identical.
  let tagsValue = resolve("tags", [], "empty"); // also sets derivation.tags
  const inlineTags = input.obsidian ? harvestInlineTags(body) : [];
  if (input.obsidian && Array.isArray(tagsValue) && inlineTags.length > 0) {
    const merged = [...tagsValue];
    for (const t of inlineTags) if (!merged.includes(t)) merged.push(t);
    tagsValue = merged;
    // If the base had no present tags, these came from the body. Otherwise
    // resolve() already labeled it "preserved" — leave that.
    if (!isPresent(raw, "tags")) derivation.tags = "inline-tags";
  }

  // Obsidian-aware sources: substitute a Web Clipper `source` only when no
  // sources are present. resolve() handles the present/empty paths and label;
  // we override to "web-clipper-source" only in the substitution case.
  let sourcesValue = resolve("sources", [], "empty"); // also sets derivation.sources
  const clipSources = input.obsidian ? webClipperSources(raw) : undefined;
  if (input.obsidian && !isPresent(raw, "sources") && clipSources) {
    sourcesValue = clipSources;
    derivation.sources = "web-clipper-source";
  }
```

Then in the `proposed` literal:
- replace `tags: resolve("tags", [], "empty"),` with `tags: tagsValue,`
- replace `sources: resolve("sources", [], "empty"),` with `sources: sourcesValue,`

> Why this is byte-identical when `obsidian` is unset: `inlineTags` is `[]` and `clipSources` is `undefined`, so both `if` blocks are skipped and `tagsValue`/`sourcesValue` are exactly `resolve(...)` — same value, same derivation label as today. The `Array.isArray` guard means a non-array `tags` (the `:238` test) is never touched even in obsidian mode.

- [ ] **Step 4: Run to verify it passes (and existing derive tests stay green)**

Run: `npx vitest run test/backfill/derive.test.ts`
Expected: PASS, including all pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/backfill/derive.ts test/backfill/derive.test.ts
git commit -m "feat(import): obsidian-aware tag union + source mapping in deriveProposed"
```

---

## Task 4: Thread `obsidian` through `generatePlan`

**Files:**
- Modify: `src/backfill/plan.ts`
- Test: `test/backfill/plan.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// add to test/backfill/plan.test.ts — use the suite's existing temp-vault helper.
it("harvests inline tags into the plan when obsidian mode is on", async () => {
  // Arrange: a non-conformant doc under a folder with an inline #tag in the body.
  // (Mirror the existing tests' fixture setup: write file, git init/commit, etc.)
  // ...write `notes/clip.md` with body "# Clip\n\nbody #harvested" and no frontmatter...
  const result = await generatePlan(vaultRoot, {
    identityMap: {},
    invoker: "human:tester",
    obsidian: true,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const entry = result.value.entries.find((e) => e.path === "notes/clip.md");
  expect(entry?.proposed.tags).toContain("harvested");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/backfill/plan.test.ts`
Expected: FAIL — `obsidian` not on `GeneratePlanOptions` / tags empty.

- [ ] **Step 3: Implement**

In `src/backfill/plan.ts`:
- Add to `GeneratePlanOptions`:
```typescript
  // Enable Obsidian-aware derivation (inline #tags, Web Clipper source). Used by
  // `daftari import obsidian`; backfill leaves it unset.
  obsidian?: boolean;
```
- In the `deriveProposed({ ... })` call (around line 120), add `obsidian: opts.obsidian,` to the argument object.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/backfill/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backfill/plan.ts test/backfill/plan.test.ts
git commit -m "feat(import): thread obsidian flag through generatePlan"
```

---

## Task 5: Accept `obsidian` option in `runBackfill`

**Files:**
- Modify: `src/backfill/index.ts`
- Test: existing `test/backfill/index.test.ts` (must stay green; add one delegation case if a harness exists)

Goal: `runBackfill(argv, opts?)` accepts `{ obsidian?: boolean }` and passes it to `generatePlan`. Omitting `opts` is unchanged behavior.

- [ ] **Step 1: Implement (behavior-preserving)**

- Change signature:
```typescript
export async function runBackfill(
  argv: string[],
  opts: { obsidian?: boolean } = {},
): Promise<number> {
```
- In the `wantPlan` branch, add `obsidian: opts.obsidian,` to the `generatePlan(vaultRoot, { ... })` options object.

- [ ] **Step 2: Run the full backfill suite to confirm no regression**

Run: `npx vitest run test/backfill`
Expected: PASS — all existing tests unaffected (default `opts = {}`).

- [ ] **Step 3: Commit**

```bash
git add src/backfill/index.ts
git commit -m "refactor(backfill): accept obsidian option in runBackfill"
```

---

## Task 6: `runImport` CLI adapter

**Files:**
- Create: `src/import/index.ts`
- Test: `test/import/index.test.ts`

`daftari import obsidian <vault> [--plan|--apply] [--scope <f>] [--yes] [--agent <id>]`

- `obsidian` is the only supported type in v1; any other type errors with the supported list (seam for future adapters).
- `<vault>` is an optional positional (the first non-flag arg after `obsidian`); defaults to `.`.
- **Vault-path validation (decision):** unlike `backfill` (which silently no-ops on a missing path), `import` is the adoption front door, so a typo'd vault should fail loudly. Validate the resolved `<vault>` is an existing directory before delegating; error with exit 1 otherwise. Use the existing `directoryExists` from `src/storage/local.ts:24` (async, returns boolean).
- Delegates to `runBackfill` by translating to backfill argv (`--vault <vault>` + passthrough flags) with `{ obsidian: true }`.
- **Output:** `runImport` itself prints only its own errors (unsupported type, missing/invalid vault) and `--help`; on the happy path all user-facing plan/apply output comes from the delegated `runBackfill` (mirrors backfill exactly, per the approved UX).

- [ ] **Step 1: Write failing tests**

```typescript
// test/import/index.test.ts
import { describe, expect, it, vi } from "vitest";

// Mock runBackfill to capture delegation without touching the filesystem.
vi.mock("../../src/backfill/index.js", () => ({
  runBackfill: vi.fn(async () => 0),
}));
import { runImport } from "../../src/import/index.js";
import { runBackfill } from "../../src/backfill/index.js";

describe("runImport", () => {
  it("rejects an unsupported import type", async () => {
    const code = await runImport(["notion", "./v", "--plan"]);
    expect(code).toBe(1);
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it("delegates obsidian import to runBackfill with the obsidian flag and --vault", async () => {
    // Use a real existing dir for the vault so the directoryExists check passes.
    await runImport(["obsidian", process.cwd(), "--plan", "--scope", "notes"]);
    expect(runBackfill).toHaveBeenCalledWith(
      expect.arrayContaining(["--vault", process.cwd(), "--plan", "--scope", "notes"]),
      { obsidian: true },
    );
  });

  it("defaults the vault to '.' when no positional path is given", async () => {
    // Note: '.' resolves against the test process cwd, which exists, so the
    // directoryExists check passes — this case is implicitly cwd-dependent.
    await runImport(["obsidian", "--plan"]);
    expect(runBackfill).toHaveBeenCalledWith(
      expect.arrayContaining(["--vault", "."]),
      { obsidian: true },
    );
  });

  it("errors (exit 1) and does not delegate when the vault dir does not exist", async () => {
    const code = await runImport(["obsidian", "/no/such/vault/path", "--plan"]);
    expect(code).toBe(1);
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it("prints help and returns 0 on --help", async () => {
    const code = await runImport(["--help"]);
    expect(code).toBe(0);
  });

  it("returns 1 with no args", async () => {
    expect(await runImport([])).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/import/index.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/import/index.ts
//
// `daftari import <type> <vault> [flags]` — adopt foreign content into a Daftari
// vault in place. v1 supports one type, "obsidian", which delegates to the
// backfill plan/apply flow with Obsidian-aware derivation enabled. The command
// mirrors backfill's two-step UX exactly (spec: 2026-06-19-obsidian-adoption).

import { resolve } from "node:path";
import { runBackfill } from "../backfill/index.js";
import { directoryExists } from "../storage/local.js";

const SUPPORTED = ["obsidian"] as const;

const HELP = `daftari import — adopt an existing vault into Daftari, in place.

Usage:
  daftari import obsidian <vault> --plan [--scope <folder>]
  daftari import obsidian <vault> --apply --scope <folder> [--yes]

Adopts an Obsidian vault *in place*: Daftari indexes and curates the same files
Obsidian authors. Mirrors 'daftari backfill' (two-step plan/apply, per-folder
ratification) and additionally harvests inline #tags and maps a Web Clipper
'source' into Daftari 'sources'. Wikilinks are left untouched — Daftari already
resolves them.

Flags (passed through to backfill):
  --scope <folder>   Folder to act on. Optional on --plan, required on --apply.
  --apply / --plan   Apply a ratified folder, or stage a dry-run plan.
  --yes              Skip the apply confirmation prompt.
  --agent <id>       Acting identity for the apply commit (default human:<user>).
  --help, -h         Show this help.
`;

export async function runImport(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    process.stderr.write(HELP);
    return 1;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const type = argv[0];
  if (!(SUPPORTED as readonly string[]).includes(type as string)) {
    process.stderr.write(
      `daftari import: unsupported type '${type}' — supported: ${SUPPORTED.join(", ")}\n`,
    );
    return 1;
  }

  // The vault is the first non-flag arg after the type; default to ".".
  const rest = argv.slice(1);
  let vault = ".";
  const passthrough: string[] = [];
  let tookVault = false;
  for (const a of rest) {
    if (!tookVault && !a.startsWith("-")) {
      vault = a;
      tookVault = true;
      continue;
    }
    passthrough.push(a);
  }

  // Adoption front door: a typo'd vault should fail loudly, not silently no-op
  // the way backfill does on a missing path.
  if (!(await directoryExists(resolve(vault)))) {
    process.stderr.write(`daftari import: vault directory not found: ${vault}\n`);
    return 1;
  }

  return runBackfill(["--vault", vault, ...passthrough], { obsidian: true });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/import/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/import/index.ts test/import/index.test.ts
git commit -m "feat(import): runImport adapter delegating to backfill (obsidian)"
```

---

## Task 7: Route `import` in the CLI

**Files:**
- Modify: `src/cli.ts` (route + USAGE)
- Test: `test/cli.test.ts` — add an import-routing case next to the existing "daftari audit subcommand" test at `test/cli.test.ts:110`, which drives routing via `run(["audit", "--help"])`. Mirror it with `run(["import", "--help"])` (exit 0) and `run(["import", "notion", "./x"])` (exit 1, unsupported type).

- [ ] **Step 1: Add the route**

In `src/cli.ts` `run()`, alongside the other subcommand checks (after the `consolidate` block):

```typescript
  if (argv[0] === "import") {
    const { runImport } = await import("./import/index.js");
    process.exitCode = await runImport(argv.slice(1));
    return;
  }
```

- [ ] **Step 2: Add to USAGE**

Add this line to the `USAGE` string, under the other subcommands:

```
  daftari import obsidian <v>        Adopt an Obsidian vault in place (see: daftari import --help)
```

- [ ] **Step 3: Verify routing manually**

Run: `npm run build && node dist/cli.js import --help`
Expected: prints the import help text, exit 0.

Run: `node dist/cli.js import notion ./x`
Expected: "unsupported type 'notion'" on stderr, exit 1.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts test/
git commit -m "feat(cli): route 'daftari import' to runImport"
```

---

## Task 8: End-to-end Obsidian adoption test + docs

**Files:**
- Create: `test/import/adoption.e2e.test.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write the e2e test**

Build a temp vault (mirror the git-fixture setup in `test/backfill/plan.test.ts` / `apply.test.ts`), then drive plan + apply through `runImport`-equivalent options (call `generatePlan(..., { obsidian: true })` then `applyPlan`, or shell `runImport` with a real temp dir). Assert:

```typescript
// Pseudocode of assertions — adapt to the suite's fixture helpers.
// 1. A Web Clipper clip keeps custom fields and gains sources + missing fields.
//    notes/clip.md frontmatter: { source, author, published, tags: [clippings] }, body has #idea
//    → proposed.sources === [source url]
//    → proposed.tags includes "clippings" AND "idea"
//    → author + published survive in the written file (raw pass-through)
//    → status/confidence/domain/provenance filled with backfill defaults
// 2. Wikilinks in the body are unchanged after apply (no conversion).
//    body "see [[Other Note]]" → file still contains "[[Other Note]]"
// 3. Idempotence: a second plan+apply over the same folder writes nothing new
//    (unchanged), and a re-plan drops the now-conformant doc.
// 4. Dotdir exclusion: a .trash/deleted.md and .obsidian/whatever.md never
//    appear in the plan entries. (Kill condition for the spec's glob hypothesis.)
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/import/adoption.e2e.test.ts`
Expected: PASS. (If the dotdir assertion fails, the glob is matching dotfiles — add `"**/.obsidian/**", "**/.trash/**"` to the `ignore` list in `src/storage/local.ts:54` and re-run. This is the spec's documented kill condition.)

- [ ] **Step 3: Run the entire suite**

Run: `npm test`
Expected: All pass (1093+ baseline plus new tests; watch for the known embedding-model flake — re-run `--failed` once before treating a search/embedding red as real).

- [ ] **Step 4: Update CHANGELOG**

Add under `## [Unreleased]`:

```markdown
### Added
- `daftari import obsidian <vault>` — adopt an Obsidian vault in place. An
  Obsidian-aware wrapper over `backfill`: harvests inline `#tags`, maps Web
  Clipper `source` → `sources[]`, preserves all existing/custom frontmatter,
  and leaves wikilinks untouched (Daftari already resolves them).
```

- [ ] **Step 5: Commit**

```bash
git add test/import/adoption.e2e.test.ts CHANGELOG.md
git commit -m "test(import): e2e Obsidian adoption + CHANGELOG"
```

---

## Out of scope (do not build)

- `--target` / copy-to-separate-vault mode.
- Wikilink conversion.
- A `type` frontmatter field.
- Auto-stamp-on-save / watcher mutation.
- A dedicated MCP "derive frontmatter" tool (v2 candidate).
- Version bump and `npm publish` (Mihir's release step — MFA/OTP).

## Verification checklist (run before declaring done)

- [ ] `npm run build` clean.
- [ ] `npm test` green (modulo the known embedding flake, re-run `--failed`).
- [ ] `node dist/cli.js import --help` and `import obsidian <tmp> --plan` behave.
- [ ] Existing `test/backfill/**` unchanged and green (proof the non-obsidian path is byte-identical).
- [ ] Run the pre-release-assumption-audit skill before calling it complete (per the project's adversarial-review-before-done practice).
