// Open questions: what the vault raises and no document answers. Shared by the
// interview sheet and vault_question_candidates so "open" means one thing on
// both. Matching here is exact (normalized) by design; proposing rewordings is
// question-candidates.ts's job, and accepting one stays a curator's.

import type { LoadedDoc } from "./vault-docs.js";

// Statuses whose questions_raised no longer count as open: the doc has been
// retired, and its curiosity retired with it. Its questions_answered still
// count — an answer recorded anywhere stays an answer.
const RETIRED_STATUSES = new Set(["deprecated", "superseded", "archived"]);

// Whitespace/case normalization for matching a raised question against the
// vault's answered set. Exact semantics stay deterministic — no fuzzy match.
export function normalizeQuestion(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface OpenQuestion {
  key: string; // normalizeQuestion(text)
  text: string; // as first raised
  raisedBy: string[]; // every live raising doc, in walk order
}

export function collectOpenQuestions(docs: LoadedDoc[]): OpenQuestion[] {
  // An answer recorded anywhere counts, whatever the answering doc's status.
  const answered = new Set<string>();
  for (const doc of docs) {
    for (const q of doc.frontmatter.questions_answered) {
      answered.add(normalizeQuestion(q));
    }
  }

  // Duplicate raisings merge into one question with every raising doc as a
  // ref. Insertion order over the sorted file walk keeps the output stable.
  const raised = new Map<string, OpenQuestion>();
  for (const doc of docs) {
    if (RETIRED_STATUSES.has(doc.frontmatter.status)) continue;
    for (const q of doc.frontmatter.questions_raised) {
      const key = normalizeQuestion(q);
      if (key.length === 0 || answered.has(key)) continue;
      const existing = raised.get(key);
      if (existing) {
        if (!existing.raisedBy.includes(doc.path)) existing.raisedBy.push(doc.path);
      } else {
        raised.set(key, { key, text: q.trim(), raisedBy: [doc.path] });
      }
    }
  }
  return [...raised.values()];
}
