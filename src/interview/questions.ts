// Interview questions — the deterministic half of `daftari interview`.
//
// The design steal is the companion interview on a "living summary" page:
// after an assistant compiles a corpus of someone's positions, its highest-
// value next move is not more compilation — it is to ask the principal about
// the places the corpus is unclear, and fold the verbatim answers back in as
// first-class source material.
//
// Daftari already computes "unclear" three ways, so the sheet is assembled
// from existing signals and costs nothing:
//
//   tension        — two docs disagree and neither superseded the other
//   stale          — a canonical accumulation doc has outlived its ttl_days
//   open_question  — a questions_raised entry no doc's questions_answered
//                    covers
//
// LLM-FREE by design (the circadian precedent from `daftari sleep`): no flag
// on this surface can spend. This module is operator-only and takes no access
// context — the court convention; see the 2026-07-25 design spec.

import { computeStaleness } from "../curation/staleness.js";
import { agingTier, listTensions, type TensionEntry } from "../curation/tension.js";
import { parseDocument } from "../frontmatter/parser.js";
import type { Frontmatter } from "../frontmatter/types.js";
import { ok, type Result } from "../frontmatter/types.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";

export const QUESTION_KINDS = ["tension", "stale", "open_question"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface InterviewQuestion {
  id: string; // sheet-local: q-001, q-002, …
  kind: QuestionKind;
  question: string; // the text put to the principal
  context: string; // why the sheet is asking (which signal, and its state)
  refs: string[]; // tension ids and vault-relative doc paths
}

// Statuses whose questions_raised no longer count as open: the doc has been
// retired, and its curiosity retired with it. Its questions_answered still
// count — an answer recorded anywhere stays an answer.
const RETIRED_STATUSES = new Set(["deprecated", "superseded", "archived"]);

// Whitespace/case normalization for matching a raised question against the
// vault's answered set. Exact semantics stay deterministic — no fuzzy match.
export function normalizeQuestion(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

interface WalkedDoc {
  path: string;
  frontmatter: Frontmatter;
}

async function walkDocs(vaultRoot: string): Promise<Result<WalkedDoc[], Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  const docs: WalkedDoc[] = [];
  for (const relPath of list.value) {
    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) continue;
    const file = await readFile(resolved.value.absPath);
    if (!file.ok) continue;
    const parsed = parseDocument(file.value);
    if (!parsed.ok) continue;
    docs.push({ path: relPath, frontmatter: parsed.value.frontmatter });
  }
  return ok(docs);
}

// Aging-tier priority for tension questions: the disputes the vault has
// carried longest are asked first. Unresolved entries never tier to null
// (that carve-out is for accepted resolutions), but rank it last defensively.
const TIER_RANK: Record<string, number> = { stale: 0, aging: 1, fresh: 2 };

function tensionQuestions(entries: TensionEntry[], now: Date): InterviewQuestion[] {
  const open = entries.filter(
    (e) =>
      !e.resolved &&
      e.id !== undefined &&
      // Legacy `unspecified` entries cannot be ruled through the tools, and
      // `inter-proposal` conflicts close through vault_ratify, not testimony.
      e.kind !== "unspecified" &&
      e.kind !== "inter-proposal",
  );
  open.sort((a, b) => {
    const tierA = TIER_RANK[agingTier(a, now) ?? ""] ?? 3;
    const tierB = TIER_RANK[agingTier(b, now) ?? ""] ?? 3;
    if (tierA !== tierB) return tierA - tierB;
    return a.date.localeCompare(b.date);
  });
  return open.map((e) => ({
    id: "", // assigned after the kinds are concatenated
    kind: "tension" as const,
    question:
      `Two documents disagree (${e.kind}): ${e.sourceA} says "${e.claimA}" ` +
      `while ${e.sourceB} says "${e.claimB}". Which claim reflects your ` +
      `current position — or do both stand?`,
    context: `open tension ${e.id} (${agingTier(e, now) ?? "unaged"}), logged ${e.date}`,
    refs: [e.id as string, e.sourceA, e.sourceB],
  }));
}

function staleQuestions(docs: WalkedDoc[], now: Date): InterviewQuestion[] {
  const candidates: { doc: WalkedDoc; overshootDays: number; ttlDays: number }[] = [];
  for (const doc of docs) {
    const fm = doc.frontmatter;
    // Sleep's domain split: generative docs going stale is expected — never
    // asked about. Only canonical accumulation docs made a freshness promise.
    if (fm.domain !== "accumulation" || fm.status !== "canonical") continue;
    const staleness = computeStaleness({ updated: fm.updated, ttl_days: fm.ttl_days }, now);
    if (!staleness.expired || staleness.ttlDays === null) continue;
    candidates.push({
      doc,
      overshootDays: staleness.ageDays - staleness.ttlDays,
      ttlDays: staleness.ttlDays,
    });
  }
  candidates.sort(
    (a, b) => b.overshootDays - a.overshootDays || a.doc.path.localeCompare(b.doc.path),
  );
  return candidates.map(({ doc, overshootDays, ttlDays }) => ({
    id: "",
    kind: "stale" as const,
    question:
      `"${doc.frontmatter.title}" (${doc.path}) is ${overshootDays} days past ` +
      `its ${ttlDays}-day freshness window. Is it still accurate — and if ` +
      `not, what changed?`,
    context: `stale: updated ${doc.frontmatter.updated}, ttl ${ttlDays} days`,
    refs: [doc.path],
  }));
}

function openQuestions(docs: WalkedDoc[]): InterviewQuestion[] {
  // An answer recorded anywhere counts, whatever the answering doc's status.
  const answered = new Set<string>();
  for (const doc of docs) {
    for (const q of doc.frontmatter.questions_answered) {
      answered.add(normalizeQuestion(q));
    }
  }

  // Duplicate raisings merge into one question with every raising doc as a
  // ref. Insertion order over the sorted file walk keeps the sheet stable.
  const raised = new Map<string, { text: string; refs: string[] }>();
  for (const doc of docs) {
    if (RETIRED_STATUSES.has(doc.frontmatter.status)) continue;
    for (const q of doc.frontmatter.questions_raised) {
      const norm = normalizeQuestion(q);
      if (norm.length === 0 || answered.has(norm)) continue;
      const existing = raised.get(norm);
      if (existing) {
        if (!existing.refs.includes(doc.path)) existing.refs.push(doc.path);
      } else {
        raised.set(norm, { text: q.trim(), refs: [doc.path] });
      }
    }
  }

  return [...raised.values()].map(({ text, refs }) => ({
    id: "",
    kind: "open_question" as const,
    question:
      `An open question no document answers: "${text}" (raised by ` +
      `${refs.join(", ")}). What is your current answer — even a partial one?`,
    context: `questions_raised with no matching questions_answered anywhere in the vault`,
    refs,
  }));
}

export interface GatherOptions {
  now?: Date;
  limit?: number; // cap on the sheet length, applied after ordering
}

// Assembles the priority-ordered question sheet: contested first (the vault
// is actively carrying a disagreement), then broken freshness promises, then
// open curiosity.
export async function gatherQuestions(
  vaultRoot: string,
  opts: GatherOptions = {},
): Promise<Result<InterviewQuestion[], Error>> {
  const now = opts.now ?? new Date();

  const tensions = await listTensions(vaultRoot);
  if (!tensions.ok) return tensions;
  const docs = await walkDocs(vaultRoot);
  if (!docs.ok) return docs;

  let questions = [
    ...tensionQuestions(tensions.value, now),
    ...staleQuestions(docs.value, now),
    ...openQuestions(docs.value),
  ];
  if (opts.limit !== undefined) questions = questions.slice(0, opts.limit);

  return ok(questions.map((q, i) => ({ ...q, id: `q-${String(i + 1).padStart(3, "0")}` })));
}

// The read-only sheet, as markdown. Printed by the default `daftari
// interview` invocation (court convention: the default surface never writes).
export function renderSheet(questions: InterviewQuestion[], generatedAt: string): string {
  const lines = [
    `# Interview sheet — ${generatedAt}`,
    "",
    `${questions.length} question${questions.length === 1 ? "" : "s"}. ` +
      `Order: contested first, then stale canon, then open questions. ` +
      `Answer them with \`daftari interview ask\`.`,
    "",
  ];
  for (const q of questions) {
    lines.push(`## ${q.id} — ${q.kind}`);
    lines.push("");
    lines.push(q.question);
    lines.push("");
    lines.push(`- **Asked because:** ${q.context}`);
    lines.push(`- **Refs:** ${q.refs.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
