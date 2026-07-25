// Top-level entry for `daftari interview` — the vault interrogates its
// principal.
//
//   daftari interview          print the question sheet (read-only): open
//                              tensions, expired canon, unanswered
//                              questions_raised — priority-ordered
//   daftari interview ask      conduct the interview at the terminal and
//                              record the verbatim answers as a vault doc
//
// Operator-only, like the court: the sheet reads the full tension log and
// every collection with no access context. Deterministic and LLM-free, like
// the circadian pass: nothing on this surface can spend.
//
// Exit codes (the audit convention):
//   0 — sheet printed / interview recorded (or nothing to ask)
//   2 — config/usage error (bad flag value)
//   3 — runtime error (IO failure)

import { writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { gatherQuestions, type InterviewQuestion, renderSheet } from "./questions.js";
import {
  DEFAULT_INTERVIEW_COLLECTION,
  type InterviewAnswer,
  isValidCollectionName,
  writeTranscript,
} from "./transcript.js";

const HELP = `daftari interview — the vault interrogates its principal.

The sheet is assembled from what the vault already knows is unclear: open
tensions (contested first, longest-carried first), canonical accumulation
docs past their ttl_days (largest overshoot first), and questions_raised
entries that no document's questions_answered covers. Deterministic, LLM-free.

Usage:
  daftari interview [--vault <path>] [--limit <n>] [--output <md>] [--output-json <json>]
  daftari interview ask [--vault <path>] [--limit <n>] [--collection <name>] [--by <identity>]
  daftari interview --help

Sheet (default, read-only):
  --limit        Cap the sheet at the n highest-priority questions.
  --output       Write the sheet to a file instead of stdout.
  --output-json  Also write the questions as JSON.

Interview (ask):
  Each question is put to you in turn. Your answer is recorded VERBATIM.
  An empty answer skips the question; 'q' (or end-of-input) ends the
  session. Answered questions become a transcript document in the vault —
  tier: source, provenance: direct — committed like any other write.

  --collection   Collection the transcript lands in (default: interviews).
                 One path segment: letters, digits, '-', '_'.
                 Note: the transcript quotes claims from every collection
                 the sheet touched. Under the template config only roles
                 with read: ["*"] can read a new collection; granting a
                 narrower role read here exposes those quotes to it.
  --by           Identity recorded as updated_by and commit author
                 (default: human:<os username>).

Recording testimony resolves nothing. The transcript is evidence: close a
tension with 'daftari court rule <id> --references <transcript>', freshen a
stale doc with a re-verified write.

Exit codes:
  0 — sheet printed / interview recorded
  2 — config/usage error
  3 — runtime error (IO failure)
`;

function readStringArg(argv: string[], flag: string): string | undefined {
  const raw = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (raw === undefined) return undefined;
  const idx = argv.indexOf(raw);
  return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : argv[idx + 1];
}

const VALUE_FLAGS = ["--vault", "--limit", "--output", "--output-json", "--collection", "--by"];

function findPositionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) continue;
    const prev = i > 0 ? argv[i - 1] : undefined;
    if (prev !== undefined && VALUE_FLAGS.includes(prev)) continue;
    out.push(a);
  }
  return out;
}

// The ask loop's terminal seam. Tests inject a scripted io; production wires
// stdin/stdout through readline. `ask` resolves null on end-of-input.
export interface InterviewIo {
  ask(prompt: string): Promise<string | null>;
  write(text: string): void;
  close(): void;
}

function terminalIo(): InterviewIo {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<null>((res) => rl.once("close", () => res(null)));
  return {
    ask: (prompt) => Promise.race([new Promise<string>((res) => rl.question(prompt, res)), closed]),
    write: (text) => process.stdout.write(text),
    close: () => rl.close(),
  };
}

function questionBlock(q: InterviewQuestion, total: number): string {
  const n = Number.parseInt(q.id.slice(2), 10);
  return (
    `\n[${n}/${total}] ${q.id} — ${q.kind}\n` +
    `${q.question}\n` +
    `(asked because: ${q.context})\n` +
    `(empty answer skips; 'q' ends the session)\n`
  );
}

async function runAsk(
  vaultRoot: string,
  questions: InterviewQuestion[],
  argv: string[],
  collection: string,
  io: InterviewIo,
): Promise<number> {
  const answers: InterviewAnswer[] = [];
  try {
    for (const q of questions) {
      io.write(questionBlock(q, questions.length));
      const raw = await io.ask("> ");
      if (raw === null) break; // end-of-input
      const answer = raw.trim();
      if (answer.length === 0) continue; // skip
      if (answer === "q" || answer === "quit") break;
      answers.push({ question: q, answer });
    }
  } finally {
    io.close();
  }

  if (answers.length === 0) {
    io.write("\nNo answers recorded — nothing written.\n");
    return 0;
  }

  const meta = {
    date: new Date().toISOString().slice(0, 10),
    by: readStringArg(argv, "--by") ?? `human:${userInfo().username}`,
    collection,
  };
  const written = await writeTranscript(vaultRoot, answers, meta);
  if (!written.ok) {
    process.stderr.write(`daftari interview: ${written.error.message}\n`);
    return 3;
  }

  const lines = [
    `\nRecorded ${answers.length} answer${answers.length === 1 ? "" : "s"} → ${written.value.relPath}`,
  ];
  if (written.value.commitHash) lines.push(`Committed as ${written.value.commitHash}.`);
  if (written.value.warning) lines.push(`Warning: ${written.value.warning}`);

  // Testimony is evidence, not resolution — point at the acts that remain.
  const tensionIds = answers
    .filter((a) => a.question.kind === "tension")
    .map((a) => a.question.refs[0]);
  if (tensionIds.length > 0) {
    lines.push("");
    lines.push("Answers touch open tensions. A ruling is still yours to make:");
    for (const id of tensionIds) {
      lines.push(`  daftari court rule ${id} --kind <kind> --references ${written.value.relPath}`);
    }
  }
  if (answers.some((a) => a.question.kind === "stale")) {
    lines.push("");
    lines.push(
      "Answers touch stale docs. The transcript does not freshen them — " +
        "re-verify and rewrite each doc to renew its promise.",
    );
  }
  io.write(`${lines.join("\n")}\n`);
  return 0;
}

export async function runInterview(argv: string[], io?: InterviewIo): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const vaultRoot = resolve(readStringArg(argv, "--vault") ?? ".");

  let limit: number | undefined;
  const rawLimit = readStringArg(argv, "--limit");
  if (rawLimit !== undefined) {
    limit = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(limit) || limit < 1) {
      process.stderr.write(`daftari interview: --limit must be a positive integer\n`);
      return 2;
    }
  }

  const gathered = await gatherQuestions(vaultRoot, { limit });
  if (!gathered.ok) {
    process.stderr.write(`daftari interview: ${gathered.error.message}\n`);
    return 3;
  }
  const questions = gathered.value;

  if (findPositionals(argv)[0] === "ask") {
    // Validated before a single question is put to the principal: the
    // collection lands in both the transcript's frontmatter and its on-disk
    // path, so a bad flag must fail here, not after the testimony is given.
    const collection = readStringArg(argv, "--collection") ?? DEFAULT_INTERVIEW_COLLECTION;
    if (!isValidCollectionName(collection)) {
      process.stderr.write(
        "daftari interview: --collection must be a single path segment " +
          "(letters, digits, '-', '_') and not a reserved name like node_modules\n",
      );
      return 2;
    }
    if (questions.length === 0) {
      process.stdout.write(
        "Nothing is unclear: no open tensions, no expired canon, no unanswered questions_raised.\n",
      );
      return 0;
    }
    return runAsk(vaultRoot, questions, argv, collection, io ?? terminalIo());
  }

  const sheet = renderSheet(questions, new Date().toISOString().slice(0, 10));
  const outputMd = readStringArg(argv, "--output");
  const outputJson = readStringArg(argv, "--output-json");
  try {
    if (outputMd) {
      await writeFile(resolve(outputMd), sheet, "utf-8");
    } else {
      process.stdout.write(sheet);
    }
    if (outputJson) {
      await writeFile(resolve(outputJson), `${JSON.stringify(questions, null, 2)}\n`, "utf-8");
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`daftari interview: write failed: ${reason}\n`);
    return 3;
  }

  return 0;
}
