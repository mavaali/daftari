// Question-set generation for the cortex quality metric.
//
// Given a sampled subgraph, ask the generator LLM for multi-hop questions
// across three tiers, then validate/filter the output: drop questions whose
// expected_sources escape the subgraph, and drop trivial yes/no answers. If the
// generator under-produces any tier, make ONE focused top-up call (spec §5.3) —
// remaining imbalance is accepted and recorded, not treated as an error.
// Finally, augment the contradiction tier from logged tension edges.

import { createHash } from "node:crypto";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { LlmClient } from "./llm.js";
import { GENERATOR_PROMPT, PROMPT_VERSION } from "./prompts.js";
import type { Subgraph } from "./subgraph.js";
import {
  type CortexEvalError,
  type Question,
  type QuestionSet,
  QuestionSetSchema,
  TIERS,
  type Tier,
} from "./types.js";

export interface GenerateOptions {
  n: number; // total target across tiers; floor(n/3) per tier
  model: string;
  vaultHash?: string;
  seed?: string;
}

export async function generateQuestions(
  subgraph: Subgraph,
  llm: LlmClient,
  opts: GenerateOptions,
): Promise<Result<QuestionSet, CortexEvalError>> {
  const perTier = Math.floor(opts.n / TIERS.length);
  const tierCountsRequested: Record<Tier, number> = {
    retrieval: perTier,
    cross_reference: perTier,
    contradiction: perTier,
  };

  const validNodes = new Set(subgraph.nodes.map((n) => n.path));

  // [FIRST GENERATION] full per-tier counts. A failure here is fatal.
  const firstRes = await llm.completeJson({
    model: opts.model,
    system: GENERATOR_PROMPT,
    user: renderUserPrompt(subgraph, tierCountsRequested),
    schema: QuestionSetSchema,
  });
  if (!firstRes.ok) return firstRes;
  const firstRaw = extractQuestions(firstRes.value.parsed);
  if (firstRaw === null) {
    return err({
      kind: "llm",
      message: "generator returned non-conforming JSON",
      retryable: false,
    });
  }
  const generated = validateAndMap(firstRaw, validNodes);

  // [TOP-UP] Shortfall is measured on GENERATOR output only (pre-augmentation).
  const shortfall = computeShortfall(tierCountsRequested, generated);
  let merged = generated;
  if (hasShortfall(shortfall)) {
    // Exactly ONE top-up call. A failure or non-conforming output is non-fatal:
    // we swallow it (zero additional questions) and accept the imbalance.
    const topUpRes = await llm.completeJson({
      model: opts.model,
      system: GENERATOR_PROMPT,
      user: renderTopUpPrompt(subgraph, shortfall),
      schema: QuestionSetSchema,
    });
    if (topUpRes.ok) {
      const topUpRaw = extractQuestions(topUpRes.value.parsed);
      if (topUpRaw !== null) {
        const topUp = validateAndMap(topUpRaw, validNodes);
        merged = dedupeById(generated, topUp);
      }
    }
  }

  // [AUGMENT] Additive contradiction questions from tension edges, deduped by id.
  const augmented = augmentFromTensions(subgraph, tierCountsRequested.contradiction);
  const all = dedupeById(merged, augmented);

  const tierCountsProduced = countByTier(all);
  const ts = "2026-01-01T00:00:00Z"; // placeholder; the caller overwrites this.
  const vaultHash = opts.vaultHash ?? "";
  const seed = opts.seed ?? "";

  return ok({
    id: `${vaultHash}-${seed}-${ts}`,
    vault_hash: vaultHash,
    seed,
    timestamp: ts,
    subgraph: {
      seed_doc: subgraph.seed_doc,
      nodes: subgraph.nodes.map((n) => n.path),
      edges: subgraph.edges,
    },
    questions: all,
    generator_model: opts.model,
    prompt_version: PROMPT_VERSION,
    tier_counts_requested: tierCountsRequested,
    tier_counts_produced: tierCountsProduced,
  });
}

// Pulls the `questions` array out of parsed generator JSON, or null if the
// shape is non-conforming (missing/!array). The element shapes are validated
// later by validateAndMap.
function extractQuestions(parsed: unknown): unknown[] | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  // biome-ignore lint/suspicious/noExplicitAny: structural access to parsed JSON
  const questions = (parsed as any).questions;
  if (!Array.isArray(questions)) return null;
  return questions;
}

// Validates each raw question and maps survivors to `Question` records with a
// stable id and origin "generated". Reused for both the first call and the
// top-up call. Rejects: bad tier, empty question/answer, empty or
// out-of-subgraph expected_sources, trivial answers (see isTrivial), and
// intra-call duplicates — two byte-identical questions from one generator
// call hash to the same id, and both surviving would inflate
// tier_counts_produced (#102).
function validateAndMap(rawQuestions: unknown[], validNodes: Set<string>): Question[] {
  const out: Question[] = [];
  const seen = new Set<string>();
  for (const raw of rawQuestions) {
    if (typeof raw !== "object" || raw === null) continue;
    // biome-ignore lint/suspicious/noExplicitAny: structural access to parsed JSON
    const q = raw as any;
    const tier = q.tier;
    if (!isTier(tier)) continue;
    const question = q.question;
    const answer = q.expected_answer;
    if (typeof question !== "string" || question.trim().length === 0) continue;
    if (typeof answer !== "string" || answer.trim().length === 0) continue;
    const sources = q.expected_sources;
    if (!Array.isArray(sources) || sources.length === 0) continue;
    if (!sources.every((s) => typeof s === "string" && validNodes.has(s))) continue;
    if (isTrivial(tier, answer)) continue;
    const expectedSources = sources as string[];
    const id = questionId(tier, question, expectedSources);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      tier,
      question,
      expected_answer: answer,
      expected_sources: expectedSources,
      origin: "generated",
    });
  }
  return out;
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

// Per-tier shortfall against the requested counts, measured on the supplied
// (generator-only) question set. Never negative.
function computeShortfall(
  requested: Record<Tier, number>,
  produced: Question[],
): Record<Tier, number> {
  const counts = countByTier(produced);
  const shortfall: Record<Tier, number> = {
    retrieval: 0,
    cross_reference: 0,
    contradiction: 0,
  };
  for (const tier of TIERS) {
    shortfall[tier] = Math.max(0, requested[tier] - counts[tier]);
  }
  return shortfall;
}

function hasShortfall(shortfall: Record<Tier, number>): boolean {
  return TIERS.some((tier) => shortfall[tier] > 0);
}

function countByTier(questions: Question[]): Record<Tier, number> {
  const counts: Record<Tier, number> = {
    retrieval: 0,
    cross_reference: 0,
    contradiction: 0,
  };
  for (const q of questions) counts[q.tier] += 1;
  return counts;
}

// Merges `base` with `extra`, dropping any `extra` whose id already appears in
// `base` (or earlier in `extra`). Identical-text/source questions within a tier
// hash to the same id and collapse to one.
function dedupeById(base: Question[], extra: Question[]): Question[] {
  const seen = new Set(base.map((q) => q.id));
  const out = [...base];
  for (const q of extra) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    out.push(q);
  }
  return out;
}

function renderUserPrompt(sg: Subgraph, counts: Record<Tier, number>): string {
  const docs = sg.nodes.map((n) => `## ${n.path}\n\n${n.body}\n`).join("\n");
  return `Subgraph docs:\n\n${docs}\n\nProduce exactly ${counts.retrieval} retrieval, ${counts.cross_reference} cross_reference, and ${counts.contradiction} contradiction questions.`;
}

// Top-up prompt: lists ONLY the under-produced tiers and their shortfall counts.
// Tiers with shortfall 0 are omitted entirely.
function renderTopUpPrompt(sg: Subgraph, shortfall: Record<Tier, number>): string {
  const docs = sg.nodes.map((n) => `## ${n.path}\n\n${n.body}\n`).join("\n");
  const wanted = TIERS.filter((tier) => shortfall[tier] > 0)
    .map((tier) => `${shortfall[tier]} more ${tier}`)
    .join(" and ");
  return `Subgraph docs:\n\n${docs}\n\nYou previously produced too few of some tiers. Produce exactly ${wanted} questions, same rules. Do not produce any other tiers.`;
}

// Bare yes/no answers are trivial on every tier. The length floor is
// tier-aware (#102): retrieval questions legitimately have short factual
// answers ("3", "$5", "EU") that a flat < 3 cutoff silently discarded, while
// cross_reference/contradiction answers that short cannot possibly relate two
// documents and keep the stricter floor.
function isTrivial(tier: Tier, answer: string): boolean {
  const a = answer.trim().toLowerCase();
  if (a === "yes" || a === "no") return true;
  if (tier === "retrieval") return false;
  return a.length < 3;
}

function questionId(tier: string, question: string, sources: string[]): string {
  const h = createHash("sha256");
  h.update(`${tier}\x00${question}\x00${[...sources].sort().join("\x00")}`);
  return h.digest("hex").slice(0, 16);
}

// Additive contradiction questions seeded from logged tension edges in the
// subgraph: max(1, floor(0.2 × contradictionBudget)) of them, capped by how many
// tension edges exist. Origin "augmented" (no generator LLM involved).
function augmentFromTensions(sg: Subgraph, contradictionBudget: number): Question[] {
  const tensionEdges = sg.edges.filter((e) => e.kind === "tension");
  if (tensionEdges.length === 0) return [];
  const count = Math.max(1, Math.floor(0.2 * contradictionBudget));
  return tensionEdges.slice(0, count).map((e) => {
    const q = `${e.from} and ${e.to} appear to disagree on a specific point. Read both docs, identify the disagreement, and cite the position each takes. Cite both docs in your answer.`;
    const sources = [e.from, e.to];
    return {
      id: questionId("contradiction", q, sources),
      tier: "contradiction" as const,
      question: q,
      expected_answer: `A correct answer identifies the substantive contradiction between ${e.from} and ${e.to} and cites both source paths.`,
      expected_sources: sources,
      origin: "augmented" as const,
    };
  });
}
