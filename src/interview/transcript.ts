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
import { err, ok, type Result } from "../frontmatter/types.js";
import { loadConfig } from "../utils/config.js";
import { commit } from "../utils/git.js";
import type { InterviewQuestion } from "./questions.js";

export const DEFAULT_INTERVIEW_COLLECTION = "interviews";

export interface InterviewAnswer {
  question: InterviewQuestion;
  answer: string; // verbatim — never trimmed beyond the terminal's own line
}

export interface TranscriptMeta {
  date: string; // YYYY-MM-DD
  by: string; // human:<username> — recorded as updated_by and commit author
  collection: string;
}

// YAML double-quoted scalar. Question texts quote tension claims, so plain
// scalars are not an option.
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlStringList(items: string[], key: string): string {
  if (items.length === 0) return `${key}: []`;
  return `${key}:\n${items.map((s) => `  - ${yamlQuote(s)}`).join("\n")}`;
}

export function renderTranscript(answers: InterviewAnswer[], meta: TranscriptMeta): string {
  const sources = [...new Set(answers.flatMap((a) => a.question.refs))];
  const questionTexts = answers.map((a) => a.question.question);

  const frontmatter = [
    "---",
    `title: ${yamlQuote(`Interview — ${meta.date}`)}`,
    "domain: accumulation",
    `collection: ${meta.collection}`,
    "status: canonical",
    "confidence: high",
    `created: ${meta.date}`,
    `updated: ${meta.date}`,
    `updated_by: ${yamlQuote(meta.by)}`,
    "provenance: direct",
    "tier: source",
    yamlStringList(sources, "sources"),
    "superseded_by: null",
    "ttl_days: null",
    "tags: [interview]",
    yamlStringList(questionTexts, "questions_answered"),
    "questions_raised: []",
    "---",
  ].join("\n");

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

  return `${frontmatter}\n\n${body.join("\n")}`;
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

  const relPath = transcriptRelPath(vaultRoot, meta.collection, meta.date);
  const content = renderTranscript(answers, meta);

  try {
    await mkdir(dirname(join(vaultRoot, relPath)), { recursive: true });
    await writeFile(join(vaultRoot, relPath), content, "utf-8");
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
