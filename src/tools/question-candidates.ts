// vault_question_candidates — proposes the documents that may answer each open
// question (#647). Read-only and advisory; see curation/question-candidates.ts.
//
// Its own tool rather than a lint section: lint is index-free and already too
// large (#644), and 273 questions at three candidates each needs paging. Not
// under `daftari interview` either: embedding can spend on a paid provider, and
// nothing on that surface may.

import type { AccessContext } from "../access/rbac.js";
import {
  type EmbedFn,
  type RankedQuestions,
  rankQuestionCandidates,
} from "../curation/question-candidates.js";
import { collectOpenQuestions, normalizeQuestion } from "../curation/questions.js";
import { sourceReadable } from "../curation/tension-access.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { embed, getProvider } from "../search/vector.js";
import { canonicalRel } from "../utils/paths.js";
import type { ToolDefinition } from "./read.js";
import { openIndexForAccessOrNull } from "./search.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_TOP = 3;
const MAX_TOP = 5;

// Paging through open questions embeds the same corpus on every call, and a
// paid provider bills each one. Titles and questions are short and few, so a
// flat memo is enough; the cap only bounds a long-lived server. Entries are
// partitioned by read scope because a hit is measurably faster than a miss:
// shared across roles, that latency would confirm text in documents the caller
// cannot read (2026-07-14 spec: no existence leak).
const EMBED_MEMO_MAX = 20_000;
const embedMemo = new Map<string, Float32Array>();

export function __resetQuestionEmbeddingMemo(): void {
  embedMemo.clear();
}

// Visibility is decided by the role's read list alone, so that list is the
// scope. No access context means RBAC is unconfigured: everything is readable.
function readScope(access: AccessContext | undefined): string {
  if (!access) return "*";
  return JSON.stringify([...(access.role?.read ?? [])].sort());
}

const memoizedEmbed =
  (scope: string): EmbedFn =>
  async (texts) => {
    const provider = getProvider().id;
    const memoKey = (text: string): string => `${scope}\0${provider}\0${text}`;
    const misses = texts.filter((t) => !embedMemo.has(memoKey(t)));
    const embedded = await embed(misses);
    if (!embedded.ok || embedded.value.length !== misses.length) return embedded;
    const fresh = new Map(misses.map((t, i) => [t, embedded.value[i] as Float32Array]));
    const out = texts.map((t) => fresh.get(t) ?? (embedMemo.get(memoKey(t)) as Float32Array));
    if (embedMemo.size + misses.length > EMBED_MEMO_MAX) embedMemo.clear();
    for (const [t, vec] of fresh) embedMemo.set(memoKey(t), vec);
    return ok(out);
  };

interface ParsedArgs {
  question: string | undefined;
  path: string | undefined;
  limit: number;
  offset: number;
  top: number;
}

function intArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): Result<number, Error> {
  const value = args[name];
  if (value === undefined) return ok(fallback);
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return err(
      new Error(`vault_question_candidates: '${name}' must be an integer in ${min}..${max}`),
    );
  }
  return ok(value);
}

function stringArg(args: Record<string, unknown>, name: string): Result<string | undefined, Error> {
  const value = args[name];
  if (value === undefined || typeof value === "string") return ok(value);
  return err(new Error(`vault_question_candidates: '${name}' must be a string`));
}

function parseArgs(args: Record<string, unknown>): Result<ParsedArgs, Error> {
  const question = stringArg(args, "question");
  if (!question.ok) return question;
  const path = stringArg(args, "path");
  if (!path.ok) return path;
  const limit = intArg(args, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (!limit.ok) return limit;
  const offset = intArg(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  if (!offset.ok) return offset;
  const top = intArg(args, "top", DEFAULT_TOP, 1, MAX_TOP);
  if (!top.ok) return top;
  return ok({
    question: question.value,
    path: path.value,
    limit: limit.value,
    offset: offset.value,
    top: top.value,
  });
}

export interface QuestionCandidatesResult extends RankedQuestions {
  total: number; // open questions matching the filters, across all pages
}

export async function vaultQuestionCandidates(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<QuestionCandidatesResult, Error>> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return parsed;
  const { question, path, limit, offset, top } = parsed.value;

  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;

  // Everything computes from the caller's vantage, as in lint: an unreadable
  // document neither raises a question, nor answers one, nor appears as a
  // candidate, and no count of what was hidden is reported (2026-07-14 spec).
  const db = access ? openIndexForAccessOrNull(vaultRoot) : null;
  let docs = loaded.value;
  try {
    if (access) docs = docs.filter((d) => sourceReadable(db, access, d.path));
  } finally {
    db?.close();
  }

  const wantKey = question === undefined ? undefined : normalizeQuestion(question);
  const wantPath = path === undefined ? undefined : canonicalRel(path);
  const open = collectOpenQuestions(docs).filter(
    (q) =>
      (wantKey === undefined || q.key === wantKey) &&
      (wantPath === undefined || q.raisedBy.includes(wantPath)),
  );

  const ranked = await rankQuestionCandidates(open.slice(offset, offset + limit), docs, {
    top,
    embed: memoizedEmbed(readScope(access)),
  });
  return ok({ total: open.length, ...ranked });
}

const candidateSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    title: { type: "string" },
    status: { type: "string" },
    score: { type: "number" },
    matchedField: { type: "string", enum: ["title", "questions_answered"] },
    matchedText: { type: "string" },
  },
  required: ["path", "title", "status", "score", "matchedField", "matchedText"],
  additionalProperties: false,
};

export const questionCandidatesTools: ToolDefinition[] = [
  {
    name: "vault_question_candidates",
    title: "Propose answers to open questions",
    annotations: { readOnlyHint: true },
    description:
      "For each open question (a questions_raised entry whose exact text is " +
      "in no document's questions_answered), list the documents touched since " +
      "it was raised whose title or questions_answered read closest in " +
      "meaning. Advisory: nothing is closed or written. To accept a candidate, " +
      "add the question's exact text to that document's questions_answered. " +
      "Paged: `total` counts every matching open question, `limit` and " +
      "`offset` walk them. `vectorUsed: false` means embeddings were " +
      "unavailable and scores are term overlap, not meaning. Scores are " +
      "comparable within a call only.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Only this open question (whitespace and case are ignored).",
        },
        path: {
          type: "string",
          description: "Only questions raised by this vault-relative document.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Open questions per page (default ${DEFAULT_LIMIT}).`,
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Open questions to skip (default 0).",
        },
        top: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TOP,
          description: `Candidates per question (default ${DEFAULT_TOP}).`,
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "integer" },
        vectorUsed: { type: "boolean" },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              raisedBy: { type: "array", items: { type: "string" } },
              candidates: { type: "array", items: candidateSchema },
            },
            required: ["question", "raisedBy", "candidates"],
            additionalProperties: false,
          },
        },
      },
      required: ["total", "vectorUsed", "questions"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultQuestionCandidates(vaultRoot, args, access),
  },
];
