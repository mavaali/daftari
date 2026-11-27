// Candidate answers for open questions (#647). A question closes only when its
// exact text lands in some document's questions_answered, so an answer worded
// differently leaves it open forever. This proposes, for each open question,
// the later documents whose title or questions_answered read closest to it.
//
// Advisory like the rest of the curation engine: nothing here writes, and a
// curator accepts a candidate by copying the question into that document.
//
// Why not hybridSearch: questions_answered is frontmatter and never reaches the
// FTS or chunk tables, so the field the issue is about is invisible to it. The
// corpus is built in memory instead and embedded through the same provider.
// Body text stays out on purpose: bodies reward documents that DISCUSS a
// question, the raiser above all, and offer no phrasing to compare.

import type { Result } from "../frontmatter/types.js";
import { tokenize } from "../search/bm25.js";
import { cosineSimilarity } from "../search/vector.js";
import { normalizeQuestion, type OpenQuestion } from "./questions.js";
import type { LoadedDoc } from "./vault-docs.js";

export type EmbedFn = (texts: string[]) => Promise<Result<Float32Array[], Error>>;

export interface QuestionCandidate {
  path: string;
  title: string;
  status: string;
  score: number;
  matchedField: "title" | "questions_answered";
  matchedText: string;
}

export interface RankedQuestion {
  question: string;
  raisedBy: string[];
  candidates: QuestionCandidate[];
}

export interface RankedQuestions {
  vectorUsed: boolean;
  questions: RankedQuestion[];
}

export interface RankOptions {
  top: number;
  embed: EmbedFn;
}

interface Entry {
  field: QuestionCandidate["matchedField"];
  text: string;
  tokens: Set<string>;
}

interface ScoredDoc {
  doc: LoadedDoc;
  entry: Entry;
  score: number;
  lexical: number;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

// tokenize() drops generic stopwords; these are the words every question shares
// and that would otherwise make any two questions look alike.
const QUESTION_WORDS = new Set([
  "can",
  "could",
  "did",
  "do",
  "does",
  "how",
  "our",
  "should",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "would",
]);

function questionTokens(text: string): Set<string> {
  return new Set(tokenize(text).filter((t) => !QUESTION_WORDS.has(t)));
}

// Share of the question's terms the entry contains: the degraded score, and the
// tiebreak under embeddings.
function overlap(question: Set<string>, entry: Set<string>): number {
  if (question.size === 0) return 0;
  let shared = 0;
  for (const t of question) if (entry.has(t)) shared++;
  return shared / question.size;
}

// questions_answered first, so a title that ties loses: the entry a curator can
// compare against the question is the more useful evidence.
function entriesFor(doc: LoadedDoc): Entry[] {
  const fm = doc.frontmatter;
  const entries: Entry[] = [];
  for (const q of fm.questions_answered) {
    const text = q.trim();
    if (text) entries.push({ field: "questions_answered", text, tokens: questionTokens(text) });
  }
  if (fm.title) entries.push({ field: "title", text: fm.title, tokens: questionTokens(fm.title) });
  return entries;
}

// Embeds every distinct text once. Any failure, including a provider breaking
// its one-vector-per-input contract, degrades to lexical (null).
async function embedAll(
  texts: string[],
  embed: EmbedFn,
): Promise<Map<string, Float32Array> | null> {
  const unique = [...new Set(texts)];
  const embedded = await embed(unique);
  if (!embedded.ok || embedded.value.length !== unique.length) return null;
  return new Map(unique.map((t, i) => [t, embedded.value[i] as Float32Array]));
}

function earliestRaising(question: OpenQuestion, byPath: Map<string, LoadedDoc>): string | null {
  const days = question.raisedBy
    .map((p) => byPath.get(p)?.frontmatter.created ?? "")
    .filter((d) => ISO_DAY.test(d))
    .sort();
  return days[0] ?? null;
}

// A later document is one touched on or after the question was first raised:
// answers get added on edits, so `updated`, and day granularity makes ties
// inclusive. An undateable side stays eligible; dropping it would be a silent
// miss, and the curator can reject a false candidate but never sees an omitted
// one. A retired document stays eligible too (an answer anywhere stays an
// answer), but any document raising the question cannot be its own answer.
function eligible(doc: LoadedDoc, key: string, since: string | null): boolean {
  const fm = doc.frontmatter;
  if (fm.questions_raised.some((q) => normalizeQuestion(q) === key)) return false;
  return since === null || !ISO_DAY.test(fm.updated) || fm.updated >= since;
}

function bestEntry(
  tokens: Set<string>,
  queryVec: Float32Array | undefined,
  entries: Entry[],
  vectors: Map<string, Float32Array> | null,
): Omit<ScoredDoc, "doc"> | null {
  let best: Omit<ScoredDoc, "doc"> | null = null;
  for (const entry of entries) {
    const lexical = overlap(tokens, entry.tokens);
    const entryVec = vectors?.get(entry.text);
    const score = queryVec && entryVec ? cosineSimilarity(queryVec, entryVec) : lexical;
    if (score > (best?.score ?? 0)) best = { entry, score, lexical };
  }
  return best;
}

function compareScored(a: ScoredDoc, b: ScoredDoc): number {
  return (
    b.score - a.score ||
    b.lexical - a.lexical ||
    b.doc.frontmatter.updated.localeCompare(a.doc.frontmatter.updated) ||
    a.doc.path.localeCompare(b.doc.path)
  );
}

function toCandidate({ doc, entry, score }: ScoredDoc): QuestionCandidate {
  return {
    path: doc.path,
    title: doc.frontmatter.title,
    status: doc.frontmatter.status,
    score: Math.round(score * 10_000) / 10_000,
    matchedField: entry.field,
    matchedText: entry.text,
  };
}

// Ranks each question against `docs`, which must already be scoped to what the
// caller may read: this module neither knows nor imports RBAC.
export async function rankQuestionCandidates(
  questions: OpenQuestion[],
  docs: LoadedDoc[],
  opts: RankOptions,
): Promise<RankedQuestions> {
  if (questions.length === 0) return { vectorUsed: false, questions: [] };

  const corpus = docs.map((doc) => ({ doc, entries: entriesFor(doc) }));
  const vectors = await embedAll(
    [...questions.map((q) => q.text), ...corpus.flatMap((c) => c.entries.map((e) => e.text))],
    opts.embed,
  );
  const byPath = new Map(docs.map((d) => [d.path, d]));

  return {
    vectorUsed: vectors !== null,
    questions: questions.map((question) => {
      const since = earliestRaising(question, byPath);
      const tokens = questionTokens(question.text);
      const queryVec = vectors?.get(question.text);
      const scored: ScoredDoc[] = [];
      for (const { doc, entries } of corpus) {
        if (!eligible(doc, question.key, since)) continue;
        const best = bestEntry(tokens, queryVec, entries, vectors);
        if (best) scored.push({ doc, ...best });
      }
      return {
        question: question.text,
        raisedBy: question.raisedBy,
        candidates: scored.sort(compareScored).slice(0, opts.top).map(toCandidate),
      };
    }),
  };
}
