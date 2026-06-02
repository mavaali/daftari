// src/eval/storage.ts
// JSON I/O under .daftari/eval/. No business logic — just paths, schemas,
// rotation. Read paths are read-only-compatible per spec §12 resolution 5.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import {
  type CortexEvalError,
  type EvalRun,
  HISTORY_RETENTION,
  type HistoryEntry,
  type HistoryFile,
  type QuestionSet,
  type Score,
} from "./types.js";

const EVAL_DIR = (vault: string) => join(vault, ".daftari", "eval");
const QS_DIR = (vault: string) => join(EVAL_DIR(vault), "questions");
const RES_DIR = (vault: string) => join(EVAL_DIR(vault), "results");
const SCORE_DIR = (vault: string) => join(EVAL_DIR(vault), "scores");
const HIST_FILE = (vault: string) => join(EVAL_DIR(vault), "history.json");

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

function writeJson<T>(path: string, value: T): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(path: string): Promise<Result<T, CortexEvalError>> {
  try {
    const raw = await readFile(path, "utf8");
    return ok(JSON.parse(raw) as T);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err({ kind: "runtime", message: `read ${path}: ${msg}` });
  }
}

export async function writeQuestionSet(vault: string, qs: QuestionSet): Promise<void> {
  await ensureDir(QS_DIR(vault));
  await writeJson(join(QS_DIR(vault), `${qs.id}.json`), qs);
}

export function readQuestionSet(
  vault: string,
  id: string,
): Promise<Result<QuestionSet, CortexEvalError>> {
  return readJson<QuestionSet>(join(QS_DIR(vault), `${id}.json`));
}

export async function writeResults(vault: string, run: EvalRun): Promise<void> {
  await ensureDir(RES_DIR(vault));
  await writeJson(join(RES_DIR(vault), `${run.id}.json`), run);
}

export function readResults(vault: string, id: string): Promise<Result<EvalRun, CortexEvalError>> {
  return readJson<EvalRun>(join(RES_DIR(vault), `${id}.json`));
}

export async function writeScore(vault: string, score: Score): Promise<void> {
  await ensureDir(SCORE_DIR(vault));
  await writeJson(join(SCORE_DIR(vault), `${score.results_id}.json`), score);
}

export async function appendHistory(vault: string, entry: HistoryEntry): Promise<void> {
  await ensureDir(EVAL_DIR(vault));
  const current = await readHistory(vault);
  const runs: HistoryEntry[] = current.ok ? [...current.value.runs, entry] : [entry];
  const trimmed = runs.slice(-HISTORY_RETENTION);
  const out: HistoryFile = { version: 1, runs: trimmed };
  await writeJson(HIST_FILE(vault), out);
}

export async function readHistory(vault: string): Promise<Result<HistoryFile, CortexEvalError>> {
  const path = HIST_FILE(vault);
  if (!existsSync(path)) return ok({ version: 1, runs: [] });
  const r = await readJson<HistoryFile>(path);
  if (!r.ok) return r;
  if (typeof r.value.version === "number" && r.value.version > 1) {
    process.stderr.write(
      `daftari eval: history.json version ${r.value.version} is newer than supported (1); leaving untouched\n`,
    );
    return ok({ version: 1, runs: [] });
  }
  return r;
}
