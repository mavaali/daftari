# Regression Suite Tier 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the CO2 staleness pilot and the native-shape lexical retrieval check into a hermetic, PR-gating vitest suite under `test/regression/`, diffed against committed per-query/per-instance golden baselines.

**Architecture:** Two vitest suites (`test/regression/staleness/`, `test/regression/retrieval/`) over pinned fixtures in `test/regression/fixtures/`, plus a small baseline load/diff/update helper. Invariants (never-stale, dead-end abstention, lexical purity, document-arm validity) assert unconditionally; goldens diff against `test/regression/baselines/*.json` and fail on ANY difference. `npm run regression:update-baseline` regenerates baselines and refuses to run on a dirty tree. One new `regression` job in `ci.yml`.

**Tech Stack:** vitest (already runs `integrations/*/src` tests from the root config, so cross-package TS imports work), better-sqlite3 index via `reindexVault` with a stub embedding provider (no MiniLM, no network), consensus-bench arm modules imported from source.

**Spec:** `docs/superpowers/specs/2026-07-07-regression-suite-design.md` (Tier 1 only — Tiers 2–3 are separable follow-ups)

**Key facts (verified against the code on 2026-07-07 — don't re-derive):**

- Root `vitest.config.ts` uses default includes minus `**/.claude/**`, so `npm test` already picks up `integrations/consensus-bench/src/*.test.ts` AND will pick up `test/regression/**/*.test.ts`. Tests import TS sources with `.js` specifiers; vitest resolves them. No `npm run build` needed for the CI job.
- Pilot numbers reproduce from committed fixtures (ran 2026-07-07): `runPilot(box, diffs)` over `trump-current-consensus.wikitext` + `trump-instance-diffs.json` → `{total: 14, scorable: 12, armAFailBefore: 12, armAPassAfter: 12, armCGoverning: 7}`. The 5 scorable non-governing rows classify `armC === "unscorable"` (reason: "no inline consensus marker in diff window") — the results doc called these "abstains"; code says `unscorable`. The 2 non-scorable rows are `reason: "multi-hunk"`.
- Dead-ends derived from the box fixture: 6 items (`[4, 8, 10, 15, 16, 20]`) are non-active and unresolved by `resolveCurrent`. The results doc said "5/5" (probe subset); the invariant must be corpus-derived (all of them), with a non-vacuity guard (`> 0`), not a hardcoded count.
- `armC(items, {citedNum}, passage, diffHtml)` (consensus-arm-c.ts) returns `{answer?, classification: "governing"|"abstain"|"unscorable", reason?}`. `answer` is set ONLY on `"governing"` and equals `passage.governingText`. Unresolved item → `"abstain"` BEFORE the scorability check, so a dead-end abstains even with a scorable passage.
- `setProviderForTests(provider)` / `resetProviderForTests()` (src/search/vector.ts) install a fake `EmbeddingProvider` `{id, dim, warm(), embed(texts)}`; `embed` must return one `Float32Array(dim)` per input. `reindexVault` then embeds with the stub — no MiniLM load. `hybridSearch(db, q, {weights: {bm25: 1, vector: 0}})` skips `embedQuery` when vector weight is 0 and reports `vectorUsed: false`.
- `reindexVault(vaultRoot)` opens the index via `openIndexForActiveProvider` (uses `getProvider().dim`), so `openIndexDb(vault, dim)` afterwards must pass the SAME stub dim. `ReindexResult` has `{documentCount, chunkCount, skipped, invalidFrontmatter, ...}` — assert `skipped` and `invalidFrontmatter` empty (invalid frontmatter is indexed with coerced defaults, silently corrupting the corpus otherwise).
- The native vault generator (`integrations/recall-bench/gen-native-vault.mjs`) is fully deterministic (everything derives from the doc index): 100 docs, 3 field-isolated zero-padded tokens each (`titletok0NN` / `tagtok0NN` / `bodytok0NN`), 300 queries. Tokens are fixed-width because `buildMatchQuery` appends `*` (prefix match).
- Post-#157 (tiered combine, default flipped to chunk in v1.29.0) the chunk arm is title/tag-safe — expect chunk hit rates near 1.0, NOT the June results-doc 0.0 (that predates the fix). Baselines capture actuals at generation time; do not hand-write them.
- Repo style: no classes, `Result<T, E>` returns, biome (double quotes, `npm run lint` covers `src test`), tests mirror structure. Commit style: `feat(scope): ...` / `test(scope): ...` / `ci: ...`.

**Layout being built:**

```
test/regression/
  helpers/baseline.ts               load/diff/update-mode write
  fixtures/
    consensus/trump-current-consensus.wikitext    (pinned copy)
    consensus/trump-instance-diffs.json           (pinned copy)
    native-vault/vault/native-000.md … native-099.md
    native-vault/queries.jsonl
  baselines/
    staleness.json                  per-revid {citedNum, scorable, reason?, armC}
    retrieval.json                  per-query {type, docHit1, docHit5, chunkHit1, chunkHit5}
  staleness/staleness.test.ts
  retrieval/retrieval.test.ts
scripts/
  gen-regression-vault.mjs          deterministic fixture generator (run once, output committed)
  regression-update-baseline.mjs    dirty-tree guard + REGRESSION_UPDATE=1 vitest run
```

---

## Task 0: Branch

- [ ] **Step 1:** From clean `main`, create the working branch:

```bash
git checkout -b feat/regression-suite-tier1
```

---

## Task 1: Baseline helper

**Files:**
- Create: `test/regression/helpers/baseline.ts`
- Test: `test/regression/helpers/baseline.test.ts`

The helper is the golden-diff mechanism both suites share. Contract: `diffBaseline(absPath, actual)` returns `[]` when `actual` deep-equals the committed JSON; otherwise one human-readable message per differing/missing/extra key. When `process.env.REGRESSION_UPDATE === "1"` it writes `actual` (sorted keys, 2-space indent, trailing newline) and returns `[]`. A missing baseline file outside update mode is itself a diff (tells the dev to run the update script), not a crash.

- [ ] **Step 1: Write the failing test**

```ts
// test/regression/helpers/baseline.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffBaseline } from "./baseline.js";

describe("diffBaseline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-baseline-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.REGRESSION_UPDATE;
  });

  const file = () => join(dir, "b.json");
  const write = (obj: unknown) => writeFileSync(file(), `${JSON.stringify(obj, null, 2)}\n`);

  it("returns [] when actual matches the committed baseline", () => {
    write({ a: { hit: true }, b: { hit: false } });
    expect(diffBaseline(file(), { a: { hit: true }, b: { hit: false } })).toEqual([]);
  });

  it("names changed, missing, and extra entries", () => {
    write({ a: { hit: true }, gone: { hit: true } });
    const diffs = diffBaseline(file(), { a: { hit: false }, fresh: { hit: true } });
    expect(diffs.some((d) => d.includes("a"))).toBe(true);
    expect(diffs.some((d) => d.includes("gone"))).toBe(true);
    expect(diffs.some((d) => d.includes("fresh"))).toBe(true);
    expect(diffs).toHaveLength(3);
  });

  it("reports a missing baseline file as a diff, not a crash", () => {
    const diffs = diffBaseline(file(), { a: { hit: true } });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("regression:update-baseline");
  });

  it("update mode writes the baseline with sorted keys and returns []", () => {
    process.env.REGRESSION_UPDATE = "1";
    expect(diffBaseline(file(), { b: { hit: true }, a: { hit: false } })).toEqual([]);
    const raw = readFileSync(file(), "utf8");
    expect(raw.indexOf('"a"')).toBeLessThan(raw.indexOf('"b"'));
    expect(raw.endsWith("\n")).toBe(true);
    // and a subsequent non-update diff against what was written is clean
    delete process.env.REGRESSION_UPDATE;
    expect(diffBaseline(file(), { a: { hit: false }, b: { hit: true } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run test/regression/helpers` → FAIL (cannot resolve `./baseline.js`).

- [ ] **Step 3: Implement**

```ts
// test/regression/helpers/baseline.ts
// Golden-baseline diff for the Tier 1 regression suites. Baselines are
// committed JSON objects keyed by a stable id (revid, query id) mapping to a
// per-entry outcome object. Any difference — better or worse — is a failure:
// behavior changes must travel with a re-committed baseline in the same PR
// (docs/superpowers/specs/2026-07-07-regression-suite-design.md).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Entry = Record<string, unknown>;
export type Baseline = Record<string, Entry>;

function sortedStringify(obj: Baseline): string {
  const out: Baseline = {};
  for (const k of Object.keys(obj).sort()) {
    const entry: Entry = {};
    for (const f of Object.keys(obj[k]).sort()) entry[f] = obj[k][f];
    out[k] = entry;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

// Returns [] on match. In update mode (REGRESSION_UPDATE=1) writes `actual`
// and returns []. A missing baseline file is reported as a single diff line.
export function diffBaseline(path: string, actual: Baseline): string[] {
  if (process.env.REGRESSION_UPDATE === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, sortedStringify(actual));
    return [];
  }
  if (!existsSync(path)) {
    return [`${path}: baseline missing — run \`npm run regression:update-baseline\` and commit it`];
  }
  const expected = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  const diffs: string[] = [];
  for (const k of Object.keys(expected)) {
    if (!(k in actual)) {
      diffs.push(`${k}: in baseline but not produced by this run`);
    } else if (JSON.stringify(actual[k], Object.keys(actual[k]).sort()) !== JSON.stringify(expected[k], Object.keys(expected[k]).sort())) {
      diffs.push(`${k}: ${JSON.stringify(expected[k])} → ${JSON.stringify(actual[k])}`);
    }
  }
  for (const k of Object.keys(actual)) {
    if (!(k in expected)) diffs.push(`${k}: new entry not in baseline`);
  }
  return diffs;
}
```

Note the field-order-insensitive compare: `JSON.stringify(value, sortedKeys)` on both sides. Keep it exactly as written.

- [ ] **Step 4: Run tests, verify pass** — `npx vitest run test/regression/helpers` → 4 pass.
- [ ] **Step 5: Lint** — `npm run lint` (biome covers `test/`); fix any format complaints with `npm run lint:fix`.
- [ ] **Step 6: Commit**

```bash
git add test/regression/helpers/
git commit -m "test(regression): golden-baseline diff helper with update mode"
```

---

## Task 2: Pin consensus fixtures + staleness suite

**Files:**
- Create: `test/regression/fixtures/consensus/trump-current-consensus.wikitext` (copy)
- Create: `test/regression/fixtures/consensus/trump-instance-diffs.json` (copy)
- Test: `test/regression/staleness/staleness.test.ts`

Fixtures are COPIED, not referenced: the bench's `__fixtures__` may evolve with bench work; the gate's fixtures are pinned and only change deliberately.

- [ ] **Step 1: Pin the fixtures**

```bash
mkdir -p test/regression/fixtures/consensus
cp integrations/consensus-bench/src/__fixtures__/trump-current-consensus.wikitext test/regression/fixtures/consensus/
cp integrations/consensus-bench/src/__fixtures__/trump-instance-diffs.json test/regression/fixtures/consensus/
```

- [ ] **Step 2: Write the suite** (fails at the golden step until the baseline exists — that's expected; invariants must pass immediately)

```ts
// test/regression/staleness/staleness.test.ts
// Tier 1 PR gate: supersession/staleness properties over the pinned CO2 corpus
// (docs/superpowers/results/2026-06-28-corpus-b-co2-pilot.md).
//
// Invariants fail unconditionally — a violation means the product promise
// ("never return a stale value as current") broke, regardless of history.
// Goldens diff against baselines/staleness.json — a flip means behavior
// changed and the PR must re-commit the baseline to prove it was intended.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { armC } from "../../../integrations/consensus-bench/src/consensus-arm-c.js";
import { loadDiffsFromFile } from "../../../integrations/consensus-bench/src/consensus-content.js";
import { parseConsensus } from "../../../integrations/consensus-bench/src/consensus-parse.js";
import { parsePassage } from "../../../integrations/consensus-bench/src/consensus-passage.js";
import { runPilot } from "../../../integrations/consensus-bench/src/consensus-pilot.js";
import { resolveCurrent } from "../../../integrations/consensus-bench/src/consensus-resolve.js";
import { type Baseline, diffBaseline } from "../helpers/baseline.js";

const FIXTURES = resolve("test/regression/fixtures/consensus");
const BASELINE = resolve("test/regression/baselines/staleness.json");

const box = parseConsensus(readFileSync(resolve(FIXTURES, "trump-current-consensus.wikitext"), "utf8"));
const diffs = loadDiffsFromFile(resolve(FIXTURES, "trump-instance-diffs.json"));

describe("staleness invariants (never baseline-diffed)", () => {
  it("corpus is intact: 14 pinned instances, non-empty consensus box", () => {
    expect(diffs).toHaveLength(14);
    expect(box.length).toBeGreaterThan(0);
  });

  it("never stale: Arm C's answer, when present, is the governing text — never the stale text", () => {
    for (const d of diffs) {
      const passage = parsePassage(d.diffHtml);
      const c = armC(box, d, passage, d.diffHtml);
      expect(["governing", "abstain", "unscorable"]).toContain(c.classification);
      if (c.answer !== undefined) {
        expect(c.answer).toBe(passage.governingText);
        expect(c.answer).not.toBe(passage.staleText);
      }
    }
  });

  it("abstain on dead-ends: every unresolvable box item abstains, even with a scorable passage", () => {
    const deadEnds = box.filter((i) => i.status !== "active" && !resolveCurrent(box, i.num).resolved);
    expect(deadEnds.length).toBeGreaterThan(0); // non-vacuous: corpus must contain dead-ends
    const scorableDiff = diffs.find((d) => parsePassage(d.diffHtml).scorable);
    if (scorableDiff === undefined) throw new Error("corpus has no scorable diff");
    const passage = parsePassage(scorableDiff.diffHtml);
    for (const item of deadEnds) {
      const c = armC(box, { citedNum: item.num }, passage, scorableDiff.diffHtml);
      expect(c.classification).toBe("abstain");
      expect(c.answer).toBeUndefined();
    }
  });
});

describe("staleness goldens (baseline-diffed)", () => {
  it("per-instance Arm C classification and scorability match baselines/staleness.json", () => {
    const { rows } = runPilot(box, diffs);
    const actual: Baseline = {};
    for (const r of rows) {
      actual[String(r.revid)] = {
        citedNum: r.citedNum,
        scorable: r.scorable,
        reason: r.reason ?? null,
        armC: r.armC,
      };
    }
    expect(diffBaseline(BASELINE, actual)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run in update mode to generate the baseline, then verify clean**

```bash
REGRESSION_UPDATE=1 npx vitest run test/regression/staleness
npx vitest run test/regression/staleness
```

Both → all tests pass. Inspect `test/regression/baselines/staleness.json`: 14 entries; 7 `"governing"`, 5 `"unscorable"` with scorable=true (marker-miss), 2 `"unscorable"` with scorable=false / reason "multi-hunk". These match the CO2 results doc (7/12 governing). If they don't, STOP — the fixtures or arm code drifted; investigate before pinning.

- [ ] **Step 4: Lint** — `npm run lint`.
- [ ] **Step 5: Commit**

```bash
git add test/regression/fixtures/consensus test/regression/staleness test/regression/baselines/staleness.json
git commit -m "test(regression): staleness PR gate — CO2 invariants + per-instance goldens"
```

---

## Task 3: Native-vault retrieval fixtures

**Files:**
- Create: `scripts/gen-regression-vault.mjs`
- Create (generated, committed): `test/regression/fixtures/native-vault/vault/native-000.md` … `native-099.md`, `test/regression/fixtures/native-vault/queries.jsonl`

- [ ] **Step 1: Port the generator.** Copy `integrations/recall-bench/gen-native-vault.mjs` to `scripts/gen-regression-vault.mjs` with exactly two changes — output paths repo-relative, and a header note:

```js
// At the top, replace the /tmp constants:
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "test/regression/fixtures/native-vault");
const VAULT = join(OUT, "vault");
const QFILE = join(OUT, "queries.jsonl");
const N = 100;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(VAULT, { recursive: true });
```

Keep the doc template, token scheme, and query emission byte-identical to the recall-bench original (it's deterministic; the committed output IS the fixture — the script exists so the fixture can be regenerated/inspected, not because it runs in CI).

- [ ] **Step 2: Generate and sanity-check**

```bash
node scripts/gen-regression-vault.mjs
ls test/regression/fixtures/native-vault/vault | wc -l    # expect 100
wc -l test/regression/fixtures/native-vault/queries.jsonl # expect 300
```

- [ ] **Step 3: Commit**

```bash
git add scripts/gen-regression-vault.mjs test/regression/fixtures/native-vault
git commit -m "test(regression): commit pinned native-shape vault fixture (100 docs, 300 queries)"
```

---

## Task 4: Retrieval suite

**Files:**
- Test: `test/regression/retrieval/retrieval.test.ts`

Hermetic port of `integrations/recall-bench/native-regression-runner.mjs`: stub embedding provider (no MiniLM), fixture copied to an OS temp dir (reindex writes `.daftari/index.db` into the vault; the committed fixture must stay pristine), lexical-only weights.

- [ ] **Step 1: Write the suite**

```ts
// test/regression/retrieval/retrieval.test.ts
// Tier 1 PR gate: lexical BM25 hit@1/hit@5 on the native-shape vault, both
// granularity arms, per-query goldens. Hermetic: a stub embedding provider
// replaces MiniLM (no model load, no network); reindex runs on a throwaway
// copy of the committed fixture. Vector-weighted retrieval is Tier 2's job.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ok, type Result } from "../../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../../src/search/embedding-provider.js";
import { hybridSearch } from "../../../src/search/hybrid.js";
import { reindexVault } from "../../../src/search/reindex.js";
import { resetProviderForTests, setProviderForTests } from "../../../src/search/vector.js";
import { type IndexDb, openIndexDb } from "../../../src/storage/index-db.js";
import { type Baseline, diffBaseline } from "../helpers/baseline.js";

const FIXTURE = resolve("test/regression/fixtures/native-vault");
const BASELINE = resolve("test/regression/baselines/retrieval.json");
const LEX = { bm25: 1, vector: 0 };

// Stub provider: reindex embeds every chunk through this instead of loading
// MiniLM. Zero vectors are fine — the suite never ranks by vector (weight 0).
const STUB_DIM = 8;
const stubProvider: EmbeddingProvider = {
  id: "regression-stub",
  dim: STUB_DIM,
  async warm(): Promise<Result<void, Error>> {
    return ok(undefined);
  },
  async embed(texts: string[]): Promise<Result<Float32Array[], Error>> {
    return ok(texts.map(() => new Float32Array(STUB_DIM)));
  },
};

interface Query {
  id: string;
  type: string;
  query: string;
  relevantPath: string;
}

const queries: Query[] = readFileSync(join(FIXTURE, "queries.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Query);

describe("retrieval regression (lexical BM25, native-shape vault)", () => {
  let vault: string;
  let db: IndexDb;
  const outcomes: Baseline = {};
  // Populated per query by the beforeAll sweep; invariant + golden tests read it.
  const docHit1: Record<string, boolean> = {};

  beforeAll(async () => {
    setProviderForTests(stubProvider);
    vault = mkdtempSync(join(tmpdir(), "daftari-regression-"));
    cpSync(join(FIXTURE, "vault"), vault, { recursive: true });
    const reindexed = await reindexVault(vault);
    if (!reindexed.ok) throw reindexed.error;
    // Corpus validity: every doc indexed, none coerced. A silently-coerced
    // fixture makes every downstream number meaningless.
    expect(reindexed.value.skipped).toEqual([]);
    expect(reindexed.value.invalidFrontmatter).toEqual([]);
    expect(reindexed.value.documentCount).toBe(100);
    const opened = openIndexDb(vault, STUB_DIM);
    if (!opened.ok) throw opened.error;
    db = opened.value;

    for (const q of queries) {
      const arms: Record<string, { hit1: boolean; hit5: boolean }> = {};
      for (const granularity of ["document", "chunk"] as const) {
        const res = await hybridSearch(db, q.query, {
          limit: 5,
          weights: LEX,
          lexicalGranularity: granularity,
        });
        if (!res.ok) throw res.error;
        // Lexical purity: a vector-touching lexical gate is a broken gate.
        expect(res.value.vectorUsed).toBe(false);
        const hits = res.value.hits;
        arms[granularity] = {
          hit1: hits[0]?.path === q.relevantPath,
          hit5: hits.slice(0, 5).some((h) => h.path === q.relevantPath),
        };
      }
      docHit1[q.id] = arms.document.hit1;
      outcomes[q.id] = {
        type: q.type,
        docHit1: arms.document.hit1,
        docHit5: arms.document.hit5,
        chunkHit1: arms.chunk.hit1,
        chunkHit5: arms.chunk.hit5,
      };
    }
  }, 120_000);

  afterAll(() => {
    db?.close();
    if (vault) rmSync(vault, { recursive: true, force: true });
    resetProviderForTests();
  });

  it("validity invariant: the document arm finds every field-isolated token at hit@1", () => {
    // The document arm indexes title+tags+body, so a miss means the corpus or
    // ground truth is broken (prefix collision, tokenization) — numbers invalid.
    const misses = queries.filter((q) => !docHit1[q.id]).map((q) => q.id);
    expect(misses).toEqual([]);
  });

  it("goldens: per-query hit@1/hit@5 under both granularities match baselines/retrieval.json", () => {
    expect(Object.keys(outcomes)).toHaveLength(300);
    expect(diffBaseline(BASELINE, outcomes)).toEqual([]);
  });
});
```

- [ ] **Step 2: Generate the baseline, then verify clean**

```bash
REGRESSION_UPDATE=1 npx vitest run test/regression/retrieval
npx vitest run test/regression/retrieval
```

Both → pass. Inspect `test/regression/baselines/retrieval.json`: 300 entries; expect `docHit1`/`docHit5` all true, and chunk-arm values near-uniformly true (post-#157 tiered combine — the June 0.0 title/tag numbers predate the fix). If chunk title/tag are false across the board, STOP and check you're on v1.29.0+ source, not `dist/`.

- [ ] **Step 3: Run the whole regression tree + existing suite to check nothing broke**

```bash
npx vitest run test/regression
npm test
```

- [ ] **Step 4: Lint** — `npm run lint`.
- [ ] **Step 5: Commit**

```bash
git add test/regression/retrieval test/regression/baselines/retrieval.json
git commit -m "test(regression): lexical retrieval PR gate — per-query goldens, stub provider"
```

---

## Task 5: Baseline update script

**Files:**
- Create: `scripts/regression-update-baseline.mjs`
- Modify: `package.json` (add script)

- [ ] **Step 1: Write the script**

```js
// scripts/regression-update-baseline.mjs
// Regenerate test/regression/baselines/*.json from current behavior.
// Refuses to run on a dirty tree so the baseline delta is attributable to the
// committed change that caused it and travels alone in the next commit
// (docs/superpowers/specs/2026-07-07-regression-suite-design.md).
import { execFileSync, spawnSync } from "node:child_process";

const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (dirty !== "") {
  console.error("regression:update-baseline: working tree is dirty — commit or stash first.");
  console.error("The baseline delta must be the only change, attributable to the last commit.");
  console.error(dirty);
  process.exit(1);
}

const run = spawnSync("npx", ["vitest", "run", "test/regression"], {
  stdio: "inherit",
  env: { ...process.env, REGRESSION_UPDATE: "1" },
});
if (run.status !== 0) process.exit(run.status ?? 1);

const changed = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (changed === "") {
  console.log("Baselines unchanged — current behavior already matches the committed goldens.");
} else {
  console.log("Updated baselines (review and commit with your PR):");
  console.log(changed);
}
```

- [ ] **Step 2: Add the npm script** to `package.json` `scripts`:

```json
"regression:update-baseline": "node scripts/regression-update-baseline.mjs"
```

- [ ] **Step 3: Verify both paths.** On the clean tree (commit everything first if needed): `npm run regression:update-baseline` → runs, reports "Baselines unchanged". Then `touch /tmp-check.md`-style dirty check: make any trivial edit (e.g. add a blank line to this plan file), run again → refuses with the dirty-tree message, exit 1. Revert the edit.

- [ ] **Step 4: Commit**

```bash
git add scripts/regression-update-baseline.mjs package.json
git commit -m "feat(regression): update-baseline script with dirty-tree guard"
```

---

## Task 6: CI job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the job.** The regression tests also run inside `npm test` (root vitest include) — that's acceptable duplication; the dedicated job is the named, required PR gate with a clean signal. Append:

```yaml
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx vitest run test/regression
```

- [ ] **Step 2: Validate the YAML** — `npx yaml-lint .github/workflows/ci.yml` if available, else a Node one-liner with `js-yaml` (already a dependency):

```bash
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('yaml ok')"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: regression PR gate — hermetic staleness + retrieval goldens"
```

---

## Task 7: Suite README + final verification

**Files:**
- Create: `test/regression/README.md`

- [ ] **Step 1: Write the README** (the operating manual for whoever hits a red X):

```markdown
# Tier 1 regression suite (PR gate)

Hermetic vitest suites that gate every PR: committed fixtures, no network, no
model loads, no `/tmp` paths. Design:
`docs/superpowers/specs/2026-07-07-regression-suite-design.md`.

## Two kinds of red

**Invariant failure** — a property assertion broke (`never stale`,
`dead-end abstention`, `lexical purity`, `document-arm validity`). This is
never expected. Do not update baselines; fix the regression.

**Golden failure** — behavior differs from `baselines/*.json`. If your PR
intended the change: commit your code, then
`npm run regression:update-baseline` (requires a clean tree) and commit the
baseline delta in the same PR — the reviewer sees exactly which
instances/queries flipped. If you didn't intend it, it's a regression.

## Suites

- `staleness/` — CO2 stale-trap corpus (14 pinned Wikipedia revert diffs +
  consensus box). Invariants: Arm C never answers with the stale passage;
  every dead-end abstains. Goldens: per-instance classification
  (`baselines/staleness.json`).
- `retrieval/` — 100-doc native-shape vault, 300 field-isolated token
  queries, lexical BM25 under document and chunk granularity. Goldens:
  per-query hit@1/hit@5 (`baselines/retrieval.json`).

Fixtures are pinned copies — they do not track
`integrations/consensus-bench/src/__fixtures__/`. Regenerate the native vault
with `node scripts/gen-regression-vault.mjs` (deterministic).

Tiers 2–3 (nightly vector/hybrid bench, pre-release LLM-judge) are follow-ups
per the design spec; this directory is Tier 1 only.
```

- [ ] **Step 2: Full verification**

```bash
npm run lint && npm run build && npm test
```

All green. `npm test` includes the regression tree; `npm run build` proves no TS breakage leaked into `src/`.

- [ ] **Step 3: Commit**

```bash
git add test/regression/README.md
git commit -m "docs(regression): tier 1 suite operating manual"
```

- [ ] **Step 4: Finish.** Use superpowers:finishing-a-development-branch — verify, then merge/PR per Mihir's call. Suggested PR title: `feat: Tier 1 regression suite — hermetic PR gate over CO2 staleness + native retrieval goldens`.

---

## Out of scope (deliberately)

- **Tiers 2–3** (`bench/` promotion, `bench.yml`, nightly tolerance bands, Tier 3 LLM-judge) — separable follow-ups per the spec.
- **Diff-window widening** (the 7→10 governing-coverage refinement) — deferred in the CO2 results doc; when it lands, its PR re-commits `staleness.json` and the golden shows exactly which 3 instances flipped. That's the suite working as designed.
- **De-hardcoding `integrations/recall-bench/` runners** — Tier 2 work; the Tier 1 retrieval suite supersedes `native-regression-runner.mjs` for gate purposes but the runner stays put until the bench promotion.
