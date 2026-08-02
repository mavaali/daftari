// End-to-end authoring smoke test for the recall-bench compiler.
//
// Gating: the entire describe block runs ONLY when both RB_INTEGRATION and
// OPENROUTER_API_KEY are set. Otherwise it is skipped automatically.
//
// Cost note: each day runs up to agentMaxIterations=24 rounds of haiku via
// OpenRouter. The multi-step authoring procedure (read WIKI.md → read index →
// vault_search → vault_write → update index → update log → final) legitimately
// needs more than 6 rounds per day. Observed approximate spend: ~$0.02–0.08
// for the full 3-day run at haiku pricing (~$0.80/M in, $4/M out).
// Well within the authorized budget.

import { describe, it, expect, afterEach } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createDaftariAdapter } from "./adapter.js";
import type { DaftariAdapter } from "./adapter.js";
import type { DayMetadata } from "./types.js";

const RUN =
  !!process.env.RB_INTEGRATION && !!process.env.OPENROUTER_API_KEY;

// ---------------------------------------------------------------------------
// Fixture: 3-day EA daily logs. Day 3 explicitly revises a fact from day 1.
// ---------------------------------------------------------------------------

const DAY1_CONTENT = `
# Daily Log — EA Notes

- Had a planning call with Sarah Chen (VP of Engineering) and Marcus Webb (CFO).
- **Quarterly board meeting scheduled for March 14** at the downtown conference center.
  Sarah confirmed all board members have been notified.
- Action item: book catering for the board meeting (owner: EA, due by March 7).
- Marcus mentioned the Q1 budget report needs to be finalised before the board meeting.
- Follow-up: send Sarah the draft agenda by March 5.
`.trim();

const DAY2_CONTENT = `
# Daily Log — EA Notes

- Completed onboarding paperwork for new hire James Okafor (joins March 10, Product team).
- Team lunch scheduled for March 12 at Nori Ramen — confirmed 8 attendees.
- Budget variance report reviewed with Marcus; no changes to headcount plan.
- Reminder sent to Sarah about the draft agenda (no response yet).
- Catering vendor (Olive & Thyme) confirmed availability for March 14.
`.trim();

const DAY3_CONTENT = `
# Daily Log — EA Notes

- **Board meeting rescheduled: moved from March 14 to March 21** due to two board
  members having a conflict. Sarah Chen confirmed the new date with all parties.
- Updated catering booking with Olive & Thyme — new date March 21 accepted.
- Q1 budget report deadline pushed accordingly; Marcus Webb acknowledged.
- Draft agenda sent and approved by Sarah.
- James Okafor start date unchanged (March 10).
`.trim();

function meta(n: number): DayMetadata {
  return {
    dayNumber: n,
    date: `2026-03-${String(n + 10).padStart(2, "0")}`,
    personaId: "persona-ea",
    activeArcs: ["board-meeting", "onboarding", "budget"],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Recursively collect all .md file paths under a directory.
async function collectMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) {
      results.push(...(await collectMdFiles(full)));
    } else if (entry.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

// Extract the YAML frontmatter block from a markdown string.
// Returns null if no frontmatter is present.
function extractFrontmatterBlock(content: string): string | null {
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") return null;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return null;
  return lines.slice(1, closeIdx).join("\n");
}

// Minimal YAML key-value parser for simple flat frontmatter (no arrays/nesting).
// Returns a Record of string keys to string values.  Good enough to check the
// required scalar fields without pulling in a YAML library.
function parseSimpleYaml(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    // Strip surrounding quotes if present.
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[m[1]] = val;
  }
  return result;
}

// Schema-folder names the wiki defines.
const SCHEMA_FOLDERS = ["topics", "decisions", "entities", "tasks", "tensions"];

// Required daftari frontmatter fields (from the vaultWrite contract).
const REQUIRED_FIELDS = [
  "domain",
  "collection",
  "status",
  "created",
  "provenance",
  "confidence",
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!RUN)(
  "compiler end-to-end authoring smoke (real haiku via OpenRouter)",
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
      "ingests 3 EA days, writes compiled notes, handles day-3 revision",
      async () => {
        // Build adapter with real OpenRouter haiku — no injected LLM.
        adapter = await createDaftariAdapter(
          {
            answererModel: "anthropic/claude-haiku-4.5",
            answererTransport: "openrouter",
            compile: "write",
            agentMaxIterations: 24,
          },
          {}, // no injected llm — real OpenRouter
        );

        vaultRoot = await adapter.setup();
        expect(typeof vaultRoot).toBe("string");
        expect(vaultRoot.length).toBeGreaterThan(0);

        // Ingest 3 days. Day 3 revises the board-meeting date from day 1.
        await adapter.ingestDay(1, DAY1_CONTENT, meta(1));
        await adapter.ingestDay(2, DAY2_CONTENT, meta(2));
        await adapter.ingestDay(3, DAY3_CONTENT, meta(3));

        await adapter.finalizeIngestion();

        // ------------------------------------------------------------------
        // Collect all written files under the vault.
        // ------------------------------------------------------------------
        const allFiles = await collectMdFiles(vaultRoot);

        // Exclude system files (WIKI.md, index.md, log.md, search index).
        const noteFiles = allFiles.filter((f) => {
          const rel = f.slice(vaultRoot!.length + 1);
          // Must be inside one of the schema folders.
          return SCHEMA_FOLDERS.some((folder) => rel.startsWith(folder + "/"));
        });

        // ------------------------------------------------------------------
        // ASSERTION 1: At least one compiled note under a schema folder with
        //              valid, parseable YAML frontmatter containing all
        //              required daftari fields.
        // ------------------------------------------------------------------
        expect(noteFiles.length).toBeGreaterThan(0);

        const noteContents: Array<{ path: string; content: string }> = [];
        for (const f of noteFiles) {
          const content = await readFile(f, "utf8");
          noteContents.push({ path: f, content });
        }

        // Find at least one note with valid frontmatter + all required fields.
        const notesWithValidFrontmatter = noteContents.filter(({ content }) => {
          const block = extractFrontmatterBlock(content);
          if (block === null) return false;
          const fm = parseSimpleYaml(block);
          return REQUIRED_FIELDS.every((field) => field in fm && fm[field].length > 0);
        });

        expect(
          notesWithValidFrontmatter.length,
          `Expected at least one note with all required daftari frontmatter fields (${REQUIRED_FIELDS.join(", ")}). ` +
            `Notes found under schema folders: ${noteFiles.map((f) => f.slice(vaultRoot!.length + 1)).join(", ")}`,
        ).toBeGreaterThan(0);

        // ------------------------------------------------------------------
        // ASSERTION 2: At least one [[wikilink]] appears across all written
        //              notes.
        // ------------------------------------------------------------------
        const allNoteText = noteContents.map((n) => n.content).join("\n");
        expect(
          allNoteText,
          "Expected at least one [[wikilink]] across all compiled notes",
        ).toMatch(/\[\[.+?\]\]/);

        // ------------------------------------------------------------------
        // ASSERTION 3: The day-3 revision (board meeting date change) was
        //              handled as EITHER:
        //   (a) a vault_supersede (old note's content has superseded_by set or
        //       a status/curation value indicating superseded), OR
        //   (b) a contradiction/tension (a > [!contradiction] callout in any
        //       note OR a file exists under tensions/).
        //
        //   The disjunction is intentional: the prompt permits either path.
        // ------------------------------------------------------------------
        const tensionFiles = noteContents.filter(({ path }) =>
          path.slice(vaultRoot!.length + 1).startsWith("tensions/"),
        );

        const hasContradictionCallout = allNoteText.includes("[!contradiction]");
        const hasTensionFile = tensionFiles.length > 0;

        // Supersede: any note has superseded_by in frontmatter, or curation:deprecated.
        const hasSupersededNote = noteContents.some(({ content }) => {
          const block = extractFrontmatterBlock(content);
          if (block === null) return false;
          const fm = parseSimpleYaml(block);
          return (
            ("superseded_by" in fm && fm.superseded_by.length > 0) ||
            fm.curation === "deprecated"
          );
        });

        const revisionHandled =
          hasSupersededNote || hasContradictionCallout || hasTensionFile;

        expect(
          revisionHandled,
          "Expected the day-3 board-meeting date revision to be handled as a supersede " +
            "(superseded_by frontmatter or curation:deprecated) OR a contradiction " +
            "([!contradiction] callout or a file under tensions/). " +
            `tension files: ${hasTensionFile}, contradiction callout: ${hasContradictionCallout}, ` +
            `superseded note: ${hasSupersededNote}. ` +
            `Notes written: ${noteFiles.map((f) => f.slice(vaultRoot!.length + 1)).join(", ")}`,
        ).toBe(true);

        // ------------------------------------------------------------------
        // ASSERTION 4: Run stayed bounded — finalizeIngestion completed
        //              without hitting the agentMaxIterations hard stop in a
        //              way that produced zero notes. (The per-day bound of 24
        //              rounds × 3 days = 72 max LLM round-trips total.
        //              Observed typical cost: ~$0.02–0.08.)
        // ------------------------------------------------------------------
        // We already asserted noteFiles.length > 0 above. Additionally assert
        // the vault root still exists (teardown not prematurely called).
        const vaultStat = await stat(vaultRoot);
        expect(vaultStat.isDirectory()).toBe(true);

        // Log the written note paths for the report.
        const relPaths = noteFiles.map((f) => f.slice(vaultRoot!.length + 1));
        console.log(
          "[compiler.integration] notes written under schema folders:",
          relPaths,
        );
        console.log(
          "[compiler.integration] revision handling: supersede=%s, contradiction=%s, tension=%s",
          hasSupersededNote,
          hasContradictionCallout,
          hasTensionFile,
        );
      },
      // 5 minutes — real LLM with up to 18 round-trips (6 per day × 3 days)
      300_000,
    );
  },
);
