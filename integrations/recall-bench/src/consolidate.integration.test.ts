// End-to-end consolidation smoke test for the recall-bench adapter.
//
// Gating: skipped unless BOTH RB_INTEGRATION AND OPENROUTER_API_KEY are set.
//
// Fixture: 2 days, ~2-3 notes total, with a DELIBERATE CONTRADICTION across
// the days (day1 "we decided to use Postgres", day2 "switching to SQLite,
// Postgres is out") so consolidation has something to link (related) AND
// contest (tension).
//
// Cost note: authoring uses agentMaxIterations:6 (one round per tool) to bound
// note count. Estimated ~3-6 notes total → 120-240 projected LLM calls at
// haiku pricing. Cap is set to 160 so a bug cannot runaway-spend; consolidation
// will budget-stop gracefully (rc=0) having processed whatever it can afford.
// Approximate spend: ~$0.04-0.15 at haiku rates.

import { describe, it, expect, afterEach } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDaftariAdapter, projectedConsolidateCalls } from "./adapter.js";
import type { DaftariAdapter } from "./adapter.js";
import type { DayMetadata } from "./types.js";

const RUN =
  !!process.env.RB_INTEGRATION && !!process.env.OPENROUTER_API_KEY;

// ---------------------------------------------------------------------------
// Fixture: 2-day engineering decision log with a deliberate contradiction.
// Day 1 chooses Postgres; Day 2 reverses to SQLite.
// ---------------------------------------------------------------------------

const DAY1_CONTENT = `
# Engineering Notes — Day 1

- Kicked off the backend storage design discussion with the team.
- **Decision: we will use Postgres as our primary database.** Rationale: mature
  ecosystem, strong JSONB support, team already has operational experience.
- Action item: set up Postgres staging instance (owner: Diego, due Friday).
- Noted that SQLite was briefly considered but ruled out due to concurrency
  limitations for our expected write volume.
- Next step: Diego to send schema draft by end of week.
`.trim();

const DAY2_CONTENT = `
# Engineering Notes — Day 2

- Revisited the database decision after load-testing results came in.
- **Decision reversed: we are switching to SQLite. Postgres is out.**
  The load tests showed our write volume is far lower than projected; SQLite's
  simplicity wins at this scale and removes operational overhead.
- Diego's Postgres staging instance work is cancelled; effort redirected.
- Team alignment confirmed: all members agree SQLite is the right call now.
- Action item: update the architecture doc to reflect SQLite (owner: Diego).
`.trim();

function meta(n: number): DayMetadata {
  return {
    dayNumber: n,
    date: `2026-06-${String(n).padStart(2, "0")}`,
    personaId: "persona-eng",
    activeArcs: ["database-decision", "backend-design"],
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!RUN)(
  "consolidate end-to-end smoke (real haiku via OpenRouter, write+consolidate)",
  () => {
    let adapter: DaftariAdapter | null = null;
    let vaultRoot: string | null = null;

    afterEach(async () => {
      if (adapter !== null) {
        await adapter.teardown().catch(() => {
          /* best-effort */
        });
        adapter = null;
        vaultRoot = null;
      }
    });

    it(
      "ingests 2 days with a contradiction, consolidates, finds edges/tensions",
      async () => {
        // In practice the authoring agent writes ~8-12 notes across 2 days.
        // NOTE_COUNT_ESTIMATE is a conservative lower bound used only to
        // verify the projected-call log line is emitted; actual projected
        // calls will be higher (adapter uses priorDayPaths.length). Cap at
        // 160 so a bug cannot runaway-spend; consolidation stops gracefully.
        const NOTE_COUNT_ESTIMATE = 3;
        const MAX_LLM_CALLS = 160;
        const projected = projectedConsolidateCalls(NOTE_COUNT_ESTIMATE);

        // Capture console.error output to verify the projected-call line is printed.
        // console.error does NOT necessarily go through process.stderr.write
        // in Node.js (it uses an internal console stream), so we intercept
        // console.error directly instead of patching process.stderr.write.
        const stderrLines: string[] = [];
        const origConsoleError = console.error.bind(console);
        console.error = (...args: unknown[]) => {
          stderrLines.push(args.map((a) => String(a)).join(" "));
          origConsoleError(...args);
        };

        try {
          adapter = await createDaftariAdapter(
            {
              answererModel: "anthropic/claude-haiku-4.5",
              answererTransport: "openrouter",
              compile: "write+consolidate",
              // 24 iterations: matches the compiler smoke test's known-working
              // value. The authoring procedure (read WIKI → read index →
              // search → write note(s) → update index → update log → done)
              // needs more than 12 rounds in practice with a real LLM.
              // Consolidation is budget-capped at maxLlmCalls to bound spend.
              agentMaxIterations: 24,
              maxLlmCalls: MAX_LLM_CALLS,
            },
            {}, // no injected LLM — real OpenRouter
          );

          vaultRoot = await adapter.setup();
          expect(typeof vaultRoot).toBe("string");
          expect(vaultRoot.length).toBeGreaterThan(0);

          // Ingest both days. Day 2 contradicts Day 1's database decision.
          await adapter.ingestDay(1, DAY1_CONTENT, meta(1));
          await adapter.ingestDay(2, DAY2_CONTENT, meta(2));

          // finalizeIngestion: reindex → enableRealConsolidation → runConsolidate
          // → re-reindex. This is where edges and tensions are written.
          await adapter.finalizeIngestion();

        } finally {
          // Restore console.error.
          console.error = origConsoleError;
        }

        // ------------------------------------------------------------------
        // ASSERTION 1: Projected-call line was emitted to stderr.
        // ------------------------------------------------------------------
        const projectedLine = stderrLines.find((l) => l.includes("projected consolidate LLM calls"));
        expect(
          projectedLine,
          "Expected console.error to include 'projected consolidate LLM calls' before the run",
        ).toBeTruthy();

        // Verify the cap in the line matches our setting.
        expect(
          projectedLine,
          `Expected projected-call line to mention the cap (${MAX_LLM_CALLS})`,
        ).toContain(String(MAX_LLM_CALLS));

        console.log(
          `[consolidate.integration] projected LLM calls: ~${projected}, cap: ${MAX_LLM_CALLS}`,
        );
        console.log("[consolidate.integration] projected line:", projectedLine?.trim());

        // ------------------------------------------------------------------
        // ASSERTION 2: At least ONE of {a real edge, a tension} was written.
        //
        // Edges → .daftari/edges.jsonl (non-empty)
        // Tensions → .daftari/tensions.md (non-empty content beyond header)
        //
        // Either proves consolidation actually ran and produced structure.
        // ------------------------------------------------------------------
        const edgesPath = join(resolve(vaultRoot!), ".daftari", "edges.jsonl");
        const tensionsPath = join(resolve(vaultRoot!), ".daftari", "tensions.md");

        let edgesContent = "";
        let tensionsContent = "";

        try {
          edgesContent = await readFile(edgesPath, "utf8");
        } catch {
          // File doesn't exist — no edges written.
        }

        try {
          tensionsContent = await readFile(tensionsPath, "utf8");
        } catch {
          // File doesn't exist — no tensions written.
        }

        // An edges.jsonl file is non-trivial if it contains at least one JSON
        // line (each line is one edge record).
        const hasRealEdge = edgesContent.trim().split("\n").some((line) => {
          try {
            const obj = JSON.parse(line);
            return obj !== null && typeof obj === "object";
          } catch {
            return false;
          }
        });

        // A tensions.md is non-trivial if it contains more than just a header
        // (i.e., there is actual content beyond whitespace).
        const hasRealTension =
          tensionsContent.trim().length > 0 &&
          // Exclude the degenerate case: only a YAML-style header or empty file.
          tensionsContent.trim() !== "# Tensions";

        const edgeCount = hasRealEdge
          ? edgesContent.trim().split("\n").filter((l) => {
              try { JSON.parse(l); return true; } catch { return false; }
            }).length
          : 0;

        console.log("[consolidate.integration] edges.jsonl exists:", edgesContent.length > 0);
        console.log("[consolidate.integration] edge records:", edgeCount);
        console.log("[consolidate.integration] tensions.md exists:", tensionsContent.length > 0);
        console.log(
          "[consolidate.integration] tensions.md preview:",
          tensionsContent.slice(0, 300) || "(empty)",
        );
        console.log(
          "[consolidate.integration] edges.jsonl first line:",
          edgesContent.split("\n")[0]?.slice(0, 200) || "(empty)",
        );

        expect(
          hasRealEdge || hasRealTension,
          "CONSOLIDATION PRODUCED NO STRUCTURE.\n" +
            `edges.jsonl (${edgeCount} parsed records): ${edgesContent.slice(0, 400) || "(not found)"}\n` +
            `tensions.md: ${tensionsContent.slice(0, 400) || "(not found)"}\n` +
            "At least one real edge OR one tension entry must be present after consolidation " +
            "on a 2-day fixture with a deliberate Postgres→SQLite contradiction.",
        ).toBe(true);

        // ------------------------------------------------------------------
        // ASSERTION 3: Teardown removes the tmp vault.
        // ------------------------------------------------------------------
        const rootSnapshot = resolve(vaultRoot!);
        await adapter!.teardown();
        adapter = null; // prevent afterEach double-teardown

        let vaultGone = false;
        try {
          await stat(rootSnapshot);
        } catch {
          vaultGone = true;
        }
        expect(
          vaultGone,
          `Expected tmp vault to be removed after teardown, but ${rootSnapshot} still exists`,
        ).toBe(true);
      },
      // 15 minutes: 2 days × up to 24 authoring rounds + consolidation pass
      // (budget-capped at 160 consolidation LLM calls; observed ~580 s).
      900_000,
    );
  },
);
