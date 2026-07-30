# The Daftari speaks — the ledger-keeper voice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `vault_lint`'s human-facing (`content`-channel) output an optional ledger-keeper voice — dry, third-century margin notes — selected by a `lint_voice` config key. The machine-readable structured payload is unchanged; the voice is a deterministic, templated re-rendering of the same findings. No LLM.

**Architecture:** A `lint_voice` config key (`plain` default | `ledger_keeper`) resolved at config-load to `config.lintVoice`. A new pure module `src/curation/lint-voice.ts` renders a `VaultLintResult` into the ledger-keeper register via per-check string templates. `src/tools/curation.ts` selects `summarizeLint` (today's compact summary) vs the new `summarizeLintLedgerKeeper` for the tool's `content` channel based on `config.lintVoice`. The structured JSON channel (`VaultLintResult`) is untouched, so no machine consumer sees any change.

**Tech Stack:** TypeScript (ESM/NodeNext), vitest, js-yaml (already a config.ts dep). No new runtime deps. No network, no LLM.

**Spec:** [docs/superpowers/specs/2026-07-30-ledger-keeper-voice-design.md](docs/superpowers/specs/2026-07-30-ledger-keeper-voice-design.md)

---

## Conventions (every task)
- ESM/NodeNext: local imports use `.js`. No classes; pure functions; `Result<T,E>` (never throw from tool handlers).
- vitest. Templates are pure, so tests are exact-match snapshots.
- Git hygiene: `git add` ONLY the files each task changes. Never `git add .`.
- Branch is `docs/specs-ledger-voice-and-divorce-kit` (already checked out — do NOT switch/create branches).
- **Invariant to preserve in every task:** the voice may change *wording only*. It must never add, drop, reorder-by-severity, or re-classify a finding, and must never touch the structured `VaultLintResult`.

## File structure
- **Modify** `src/utils/config.ts` — add `lintVoice: "plain" | "ledger_keeper"` to `DaftariConfig` (interface ~line 179, `emptyConfig()` ~line 259); a `resolveLintVoice` validator mirroring `resolveGitDir` (~line 950); parse `lint_voice` in `loadConfig` (~line 1004).
- **New** `src/curation/lint-voice.ts` — `renderLedgerKeeper(report: VaultLintResult): string`, plus per-check template functions.
- **Modify** `src/tools/curation.ts` — a `summarizeLintLedgerKeeper` (or a `voice` param on the content-channel formatter); select it by `config.lintVoice` where `summarizeLint` (~line 960) is wired to the tool's `content` output.
- **Tests**: `test/utils/config.test.ts`, new `test/curation/lint-voice.test.ts`, `test/tools/curation.test.ts` (voice selection + JSON-unchanged assertion).
- **Modify** `CHANGELOG.md`.

---

## Task 1: Config — parse, validate `lint_voice`

**Files:** Modify `src/utils/config.ts`; Test `test/utils/config.test.ts`

- [ ] **Step 1: Read context**
Read `src/utils/config.ts`: `DaftariConfig` (~line 179), `emptyConfig()` (~line 259, note `autoCommit: true` default), `resolveGitDir` (~line 950) as the validator precedent, and the `loadConfig` parse block (~line 1004–1066). Confirm the file's temp-vault + `writeFileSync(configPath, …)` test helper names in `test/utils/config.test.ts`.

- [ ] **Step 2: Write failing tests** (add to `test/utils/config.test.ts`, mirroring existing helpers)
```typescript
it("defaults lintVoice to 'plain' when lint_voice is absent", () => {
  const cfg = loadConfig(vaultRoot);
  expect(cfg.ok && cfg.value.lintVoice).toBe("plain");
});
it("accepts lint_voice: ledger_keeper", () => {
  writeFileSync(configPathFor(vaultRoot), "lint_voice: ledger_keeper\n");
  const cfg = loadConfig(vaultRoot);
  expect(cfg.ok && cfg.value.lintVoice).toBe("ledger_keeper");
});
it("accepts an explicit lint_voice: plain", () => {
  writeFileSync(configPathFor(vaultRoot), "lint_voice: plain\n");
  expect(loadConfig(vaultRoot)).toMatchObject({ ok: true, value: { lintVoice: "plain" } });
});
it("rejects an unknown lint_voice (loud error)", () => {
  writeFileSync(configPathFor(vaultRoot), "lint_voice: fez\n");
  expect(loadConfig(vaultRoot).ok).toBe(false);
});
```
Run `npx vitest run test/utils/config.test.ts` → new cases FAIL.

- [ ] **Step 3: Implement** in `src/utils/config.ts`
  - Add to `DaftariConfig` (after `autoCommit`): `lintVoice: "plain" | "ledger_keeper";`
  - In `emptyConfig()`: `lintVoice: "plain",`
  - Add a validator near `resolveGitDir`:
```typescript
const LINT_VOICES = ["plain", "ledger_keeper"] as const;
type LintVoice = (typeof LINT_VOICES)[number];
function resolveLintVoice(raw: unknown): Result<LintVoice, Error> {
  if (raw === undefined || raw === null) return ok("plain");
  if (typeof raw !== "string" || !(LINT_VOICES as readonly string[]).includes(raw)) {
    return err(new Error(`malformed config: 'lint_voice' must be one of: ${LINT_VOICES.join(", ")}`));
  }
  return ok(raw as LintVoice);
}
```
  - In `loadConfig`, parse `raw.lint_voice` through `resolveLintVoice`, threading the error out loudly (mirror how `git_dir`/`resolveGitDir` propagates).

- [ ] **Step 4: Verify** — `npx vitest run test/utils/config.test.ts` green; `npm run build` clean.

---

## Task 2: The renderer — `src/curation/lint-voice.ts`

**Files:** New `src/curation/lint-voice.ts`; Test `test/curation/lint-voice.test.ts`

- [ ] **Step 1: Read context**
Read `src/tools/curation.ts` `VaultLintResult` (~line 347) and `summarizeLint` (~line 960) — the renderer mirrors the summary's structure and must cover the SAME checks. Read the CURRENT `LINT_CHECKS` and `TIER0_LINT_CHECKS` (curation.ts ~line 945: `brokenSourceRefs`, `lifecycleConflicts`, `schemaInvalid`, `domainLeaks`, plus the advisory checks in `src/curation/lint.ts` `LINT_CHECKS`). **Every check must have a template — the spec's illustrative table is a subset.** Read `TensionHealth` (`src/curation/lint.ts` ~line 99) for the contradiction/aging copy.

- [ ] **Step 2: Write failing tests** (`test/curation/lint-voice.test.ts`)
  - A golden fixture `VaultLintResult` with at least one finding per check (tier-0 + advisory) and non-zero tension health. Assert `renderLedgerKeeper(fixture)` matches an inline expected string (exact — templates are deterministic).
  - **Coverage test:** for a fixture that puts a finding under *every* `LINT_CHECKS` entry, assert the rendered output contains a line for each check (no check silently unrendered).
  - **Invariance test:** the set of `path` strings appearing in the ledger output equals the set of `path` strings across `fixture.checks` — the voice surfaces exactly the same documents.
  - **Empty test:** a clean report renders a short "nothing to report" ledger line, not an empty string.
Run → FAIL (module doesn't exist).

- [ ] **Step 3: Implement** `renderLedgerKeeper(report: VaultLintResult): string`
  - Pure function. A `const LEDGER_TEMPLATES: Record<LintCheckName, (f: LintFinding) => string>` covering **all** checks; a `tensionLine(health: TensionHealth): string` for the contradiction/aging register; a preamble and a closing tally line.
  - Tier-0 findings lead (mirror `summarizeLint`'s tier-0-first ordering) so severity ordering is identical to `plain`.
  - No randomness, no dates beyond `report.generatedAt`, no I/O. Copy stays within the finding (no invented cause/blame) per the spec.

- [ ] **Step 4: Verify** — `npx vitest run test/curation/lint-voice.test.ts` green; `npm run build` clean.

---

## Task 3: Wire voice selection into `vault_lint`

**Files:** Modify `src/tools/curation.ts`; Test `test/tools/curation.test.ts`

- [ ] **Step 1: Read context**
Find where `summarizeLint` (~line 960) is attached to the `vault_lint` tool's `content` channel (tool registration ~line 1176, `outputSchema` ~line 1208). Confirm how `vaultLint`/the tool wrapper obtains config (it takes `vaultRoot`; load config via the same `loadConfig` the other tools use, or thread `config.lintVoice` from the caller — match the existing pattern).

- [ ] **Step 2: Write failing tests** (`test/tools/curation.test.ts`)
  - With `config.lintVoice === "plain"` (or absent), the `content` string equals today's `summarizeLint` output (regression-lock a snapshot).
  - With `config.lintVoice === "ledger_keeper"`, the `content` string is the `renderLedgerKeeper` output.
  - **JSON-unchanged assertion:** for the same vault, `VaultLintResult` (the structured channel) is byte-identical under both voices.
Run → FAIL.

- [ ] **Step 3: Implement**
  - Add `summarizeLintLedgerKeeper(value) = renderLedgerKeeper(value as VaultLintResult)`.
  - At the content-channel formatting site, branch on `config.lintVoice`: `ledger_keeper` → `summarizeLintLedgerKeeper`, else `summarizeLint`. The structured `VaultLintResult` return is untouched.

- [ ] **Step 4: Verify** — `npx vitest run test/tools/curation.test.ts` green; full `npx vitest run` green; `npm run build` clean.

---

## Task 4: Docs + changelog

**Files:** Modify `CHANGELOG.md`; docs mention of the `lint_voice` config key.

- [ ] Add a CHANGELOG entry under Unreleased: optional `lint_voice: ledger_keeper` for `vault_lint`; default `plain`; structured output unchanged.
- [ ] Document the config key wherever `auto_commit`/`git_dir` config keys are listed.
- [ ] **Do NOT** make the voice default-discoverable in marketing/help beyond a factual config note until the spec's release-gate kill condition (≥3 outside readers) clears. Leave a note in the CHANGELOG/PR that default-on is gated on that user test.

---

## Manual verification (post-merge, gates the fez)
Run `vault_lint` with `lint_voice: ledger_keeper` on a real vault with live findings; have ≥3 people who did not build it read it in that context. Ship default-discoverable only if it lands as "keep it on." Otherwise revert copy to `plain`-only (the renderer indirection stays; it's harmless).
