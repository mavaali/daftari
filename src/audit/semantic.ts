// src/audit/semantic.ts
// Opt-in (--semantic) LLM drift check for doc-to-code bindings. For each
// resolvable `describes` edge it reads the declaring doc and the described code
// file (guarded by readtext.ts) and asks the model whether the doc still
// accurately describes the code. Reference integrity (checks/describes_refs.ts)
// already covers missing files; this catches the harder case — the file exists
// but the doc lies about it.
//
// The module never imports the Anthropic SDK: the LlmClient and the reader are
// injected, so it is fully unit-testable and the default (non-semantic) audit
// never pulls in the SDK.

import { addTension } from "../curation/tension.js";
import type { LlmClient } from "../eval/llm.js";
import { readTextFile } from "./readtext.js";
import type { DescribesEdge, RepoSnapshot } from "./types.js";

export const SEMANTIC_VERDICTS = ["coherent", "drifted", "contradicted", "skipped"] as const;
export type SemanticVerdict = (typeof SEMANTIC_VERDICTS)[number];

export interface SemanticFinding {
  source: { repo: string; path: string };
  target: { repo: string; path: string; symbol: string | null };
  raw: string;
  verdict: SemanticVerdict;
  contradictions: string[];
  reason?: string; // why skipped, or a short model summary
}

export interface SemanticDeps {
  llm: LlmClient;
  model: string;
  maxBytes?: number;
  maxSemantic?: number; // cap on LLM calls; default 200
  readText?: typeof readTextFile;
  onCap?: (dropped: number) => void; // called when edges are dropped by the cap
}

export const DEFAULT_MAX_SEMANTIC = 200;

const SYSTEM_PROMPT = `You audit whether a documentation file accurately describes a source code
file. You are given the documentation and the code it claims to describe.
Compare the doc's specific claims (function names, signatures, parameters,
behavior, error handling) against the code.

Return a verdict:
  coherent     — the doc accurately describes the code
  drifted      — the doc is partially out of date; some claims no longer match
  contradicted — the doc makes claims the code directly contradicts

List the specific claims in the doc that no longer hold (empty when coherent).`;

// Verdict shape the model is asked to return.
const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "contradictions"],
  properties: {
    verdict: { enum: ["coherent", "drifted", "contradicted"] },
    contradictions: { type: "array", items: { type: "string" } },
  },
} as const;

function buildUser(docPath: string, docText: string, codePath: string, codeText: string): string {
  return [
    `Documentation file: ${docPath}`,
    "```markdown",
    docText,
    "```",
    "",
    `Source code file: ${codePath}`,
    "```",
    codeText,
    "```",
  ].join("\n");
}

function parseVerdict(
  parsed: unknown,
): { verdict: Exclude<SemanticVerdict, "skipped">; contradictions: string[] } | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = (parsed as { verdict?: unknown }).verdict;
  const c = (parsed as { contradictions?: unknown }).contradictions;
  if (v !== "coherent" && v !== "drifted" && v !== "contradicted") return null;
  const contradictions = Array.isArray(c)
    ? c.filter((x): x is string => typeof x === "string")
    : [];
  return { verdict: v, contradictions };
}

export async function runSemanticCheck(
  edges: DescribesEdge[],
  snapshots: RepoSnapshot[],
  deps: SemanticDeps,
): Promise<SemanticFinding[]> {
  const readText = deps.readText ?? readTextFile;
  const maxSemantic = deps.maxSemantic ?? DEFAULT_MAX_SEMANTIC;

  const byRepo = new Map<string, RepoSnapshot>();
  for (const snap of snapshots) byRepo.set(snap.config.name, snap);

  // Only edges whose target file actually exists are semantic candidates —
  // missing targets are reference-integrity findings (#119), not drift.
  const resolvable = edges.filter((e) => byRepo.get(e.targetRepo)?.docs.has(e.targetPath));

  const toProcess = resolvable.slice(0, maxSemantic);
  if (resolvable.length > toProcess.length) {
    deps.onCap?.(resolvable.length - toProcess.length);
  }

  const findings: SemanticFinding[] = [];
  for (const e of toProcess) {
    const sourceDoc = byRepo.get(e.sourceRepo)?.docs.get(e.sourcePath);
    const targetFile = byRepo.get(e.targetRepo)?.docs.get(e.targetPath);
    const base = {
      source: { repo: e.sourceRepo, path: e.sourcePath },
      target: { repo: e.targetRepo, path: e.targetPath, symbol: e.symbol },
      raw: e.raw,
    };
    const skip = (reason: string): SemanticFinding => ({
      ...base,
      verdict: "skipped",
      contradictions: [],
      reason,
    });

    if (!sourceDoc || !targetFile) {
      findings.push(skip("source or target snapshot unavailable"));
      continue;
    }

    const codeRead = await readText(targetFile.absPath, { maxBytes: deps.maxBytes });
    if (!codeRead.ok) {
      findings.push(skip(`code unreadable: ${codeRead.error.reason}`));
      continue;
    }
    const docRead = await readText(sourceDoc.absPath, { maxBytes: deps.maxBytes });
    if (!docRead.ok) {
      findings.push(skip(`doc unreadable: ${docRead.error.reason}`));
      continue;
    }

    const res = await deps.llm.completeJson({
      model: deps.model,
      system: SYSTEM_PROMPT,
      user: buildUser(e.sourcePath, docRead.value.text, e.targetPath, codeRead.value.text),
      schema: VERDICT_SCHEMA,
    });
    if (!res.ok) {
      findings.push(skip(`llm error: ${res.error.message}`));
      continue;
    }
    const verdict = parseVerdict(res.value.parsed);
    if (!verdict) {
      findings.push(skip("llm returned an unparseable verdict"));
      continue;
    }
    findings.push({ ...base, verdict: verdict.verdict, contradictions: verdict.contradictions });
  }

  return findings;
}

// --auto-tension: record drift/contradiction verdicts in the vault's tension
// log (the same store backing vault_tension_log). Coherent and skipped verdicts
// are not tensions. Logging is advisory and never edits a doc; a failed append
// is collected, not thrown.
export async function logSemanticTensions(
  findings: SemanticFinding[],
  vaultRoot: string,
  loggedBy: string,
): Promise<{ logged: number; errors: string[] }> {
  let logged = 0;
  const errors: string[] = [];
  for (const f of findings) {
    if (f.verdict !== "drifted" && f.verdict !== "contradicted") continue;
    const target = `${f.target.repo}/${f.target.path}`;
    const res = await addTension(vaultRoot, {
      title: `Doc-code ${f.verdict}: ${f.source.path} ↔ ${target}`,
      kind: "factual",
      sourceA: f.source.path,
      claimA:
        f.contradictions.length > 0
          ? f.contradictions.join("; ")
          : "doc may no longer match the code it describes",
      sourceB: target,
      claimB: `current implementation (audit verdict: ${f.verdict})`,
      loggedBy,
    });
    if (res.ok) logged++;
    else errors.push(res.error.message);
  }
  return { logged, errors };
}
