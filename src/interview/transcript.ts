// Interview transcript — the fold-back half of `daftari interview`.
//
// Answers are the principal's words, verbatim, and the transcript is a
// first-class vault document so the testimony joins the corpus: indexed,
// searchable, citable as a reference in a court ruling. Frontmatter posture
// (see the 2026-07-25 design spec):
//
//   tier: source        — verbatim human words are raw source material;
//                         the body is immutable to every writer (#141)
//   provenance: direct  — the principal's own statement, not a synthesis
//   ttl_days: null      — a record of what was said on a date never expires
//   sources             — the tension ids / doc paths that prompted each
//                         question, so testimony traces back to its signals
//   questions_answered  — the question texts, so a later sheet never
//                         re-asks what a transcript already answered
//
// Recording testimony resolves nothing. Tensions close only through a
// ruling; stale docs freshen only through a re-verified write.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { resolveVaultPath } from "../storage/local.js";
import { loadConfig } from "../utils/config.js";
import { commit } from "../utils/git.js";
import type { InterviewQuestion } from "./questions.js";

export const DEFAULT_INTERVIEW_COLLECTION = "interviews";

// The collection name travels into both the transcript's frontmatter and its
// on-disk path, so it is allow-listed rather than escaped: one path segment,
// no separators, no `.` (rules out `..`), nothing YAML-significant. The same
// frontmatter-vs-path collection confusion was hardened on the MCP write
// path (S1, 2026-07-01) — the CLI flag gets the same treatment.
export const COLLECTION_NAME_RE = /^[A-Za-z0-9_-]+$/;

// Segments listFiles hard-ignores that the regex alone would admit (its other
// ignores — .daftari, .obsidian, .trash — are already blocked by the no-dot
// rule). A transcript under one of these would be written and committed but
// invisible to every vault-wide scan: staleness, lint, reindex, a later
// interview sheet. Fail loudly here instead.
const RESERVED_COLLECTION_NAMES = new Set(["node_modules"]);

export function isValidCollectionName(name: string): boolean {
  return COLLECTION_NAME_RE.test(name) && !RESERVED_COLLECTION_NAMES.has(name);
}

export interface InterviewAnswer {
  question: InterviewQuestion;
  answer: string; // verbatim — never trimmed beyond the terminal's own line
}

export interface TranscriptMeta {
  date: string; // YYYY-MM-DD
  by: string; // human:<username> — recorded as updated_by and commit author
  collection: string;
}

export function renderTranscript(answers: InterviewAnswer[], meta: TranscriptMeta): string {
  const sources = [...new Set(answers.flatMap((a) => a.question.refs))];

  // Serialized with matter.stringify (js-yaml), the same path vault_write and
  // the OKF bridge use — arbitrary strings (quoted claims, verbatim answers)
  // can never produce malformed YAML. Insertion order is the emitted order.
  const frontmatter: Record<string, unknown> = {
    title: `Interview — ${meta.date}`,
    domain: "accumulation",
    collection: meta.collection,
    status: "canonical",
    confidence: "high",
    created: meta.date,
    updated: meta.date,
    updated_by: meta.by,
    provenance: "direct",
    tier: "source",
    sources,
    superseded_by: null,
    ttl_days: null,
    tags: ["interview"],
    questions_answered: answers.map((a) => a.question.question),
    questions_raised: [],
  };

  const body = [
    `# Interview — ${meta.date}`,
    "",
    "Answers are the principal's words, verbatim. Recording testimony",
    "resolves nothing: tensions close only through a ruling (`daftari court",
    "rule`), and stale documents freshen only through a re-verified write.",
    "",
  ];
  for (const { question, answer } of answers) {
    body.push(`## ${question.id} — ${question.kind}`);
    body.push("");
    body.push(`**Q:** ${question.question}`);
    body.push("");
    body.push(`- **Asked because:** ${question.context}`);
    body.push(`- **Refs:** ${question.refs.join(", ")}`);
    body.push("");
    body.push(`**A:** ${answer}`);
    body.push("");
  }

  return matter.stringify(`\n${body.join("\n")}`, frontmatter);
}

// Allocates a collision-free vault-relative path for today's transcript:
// interviews/2026-07-25-interview.md, then -2, -3, … if the principal sits
// for more than one session a day.
export function transcriptRelPath(vaultRoot: string, collection: string, date: string): string {
  const base = `${collection}/${date}-interview`;
  let rel = `${base}.md`;
  for (let n = 2; existsSync(join(vaultRoot, rel)); n++) {
    rel = `${base}-${n}.md`;
  }
  return rel;
}

export interface WriteTranscriptResult {
  relPath: string;
  commitHash: string | null; // null when auto_commit is off or commit failed
  warning?: string; // set when the write landed but the commit did not
}

// Writes the transcript into the vault and auto-commits, honoring the
// vault's `auto_commit` and `git_dir` config exactly like the MCP write
// path. A failed commit is a warning, not a failure — the file is on disk
// and durable either way (the initVault convention).
export async function writeTranscript(
  vaultRoot: string,
  answers: InterviewAnswer[],
  meta: TranscriptMeta,
): Promise<Result<WriteTranscriptResult, Error>> {
  if (answers.length === 0) {
    return err(new Error("writeTranscript requires at least one answer"));
  }
  if (!isValidCollectionName(meta.collection)) {
    return err(
      new Error(
        `invalid collection name '${meta.collection}' — one path segment matching ` +
          `${COLLECTION_NAME_RE}, not a reserved name`,
      ),
    );
  }

  const content = renderTranscript(answers, meta);
  // Refuse to persist testimony the vault could not read back: the rendered
  // document must round-trip the same parser every read uses, cleanly.
  const roundTrip = parseDocument(content);
  if (!roundTrip.ok) {
    return err(new Error(`refusing to write a malformed transcript: ${roundTrip.error.message}`));
  }
  if (!roundTrip.value.validation.valid) {
    const issues = roundTrip.value.validation.issues
      .map((i) => `${i.field}: ${i.message}`)
      .join("; ");
    return err(new Error(`refusing to write an invalid transcript: ${issues}`));
  }

  // Vault confinement, same gate as every other write path. The allow-list
  // above already rules out traversal; this keeps the invariant structural
  // rather than an accident of the regex.
  const resolved = resolveVaultPath(
    vaultRoot,
    transcriptRelPath(vaultRoot, meta.collection, meta.date),
  );
  if (!resolved.ok) return resolved;
  const relPath = resolved.value.relPath;

  try {
    await mkdir(dirname(resolved.value.absPath), { recursive: true });
    await writeFile(resolved.value.absPath, content, "utf-8");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot write transcript: ${reason}`));
  }

  const config = loadConfig(vaultRoot);
  const autoCommit = config.ok ? config.value.autoCommit : true;
  const gitDir = config.ok ? config.value.gitDir : undefined;

  if (!autoCommit) {
    return ok({ relPath, commitHash: null });
  }

  const committed = await commit(
    vaultRoot,
    [relPath],
    `Record interview ${meta.date} (${answers.length} answer${answers.length === 1 ? "" : "s"})`,
    meta.by,
    { gitDir },
  );
  if (!committed.ok) {
    return ok({
      relPath,
      commitHash: null,
      warning: `transcript written but not committed: ${committed.error.message}`,
    });
  }
  return ok({ relPath, commitHash: committed.value.hash });
}
