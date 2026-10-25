// Cross-vault leak ledger (U2) — the session-level record that lets a later
// write-time gate (U3) know whether the CURRENT agent run read any
// private-visibility source, correlated ACROSS the two OS processes a
// household session can span (a private-owner process and a shared-canonical
// process, each serving its own vault). The existing per-vault read log
// (read-log.ts) cannot answer that: it lives inside one vault's `.daftari/`
// and a process serving vault B never sees vault A's log.
//
// Location: ONE file OUTSIDE any vault, on the shared local filesystem both
// canonical processes can reach (single-box household assumption — see U2
// plan). It is a raw fs append, not a `vault_write` — the private-owner
// process cannot write into the shared vault, and a neutral OS-level path is
// the only place both sides can land an entry.
//
// Mechanics mirror read-log.ts exactly: append-only JSONL, best-effort (a
// ledger-append failure must NEVER fail the read that triggered it — same
// contract as recordRead), corrupt lines skipped on read back.

import { accessSync, constants, mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { VaultVisibility } from "../utils/config.js";

export interface LeakLedgerEntry {
  timestamp: string; // ISO 8601
  tool: string; // the serving tool, e.g. "vault_read" or "vault_search"
  // Deliberately NOT a document path. The scan (privateReadsForRun/Strict)
  // only needs run_id + visibility + source_vault + a count — it must never
  // need or store WHICH private document was read (matches the gate's own
  // no-path discipline, and closes the ledger-privacy hole where the file
  // it read from a PRIVATE vault sat in a ledger that lives outside any
  // vault's access control).
  // The correlating run. Entries are only ever written when the caller
  // passed one — a read with no run_id cannot be joined to a later write and
  // is therefore never appended (see the instrumented call sites).
  run_id?: string;
  // The authenticated identity the server runs as, when present (§11.6).
  principal?: string;
  // The visibility of the VAULT THAT SERVED this read, per its own
  // `config.visibility` at serve time — not a property of the document.
  visibility: VaultVisibility;
  // Identifies the serving vault (its resolved root). Deliberately NOT a
  // document path or any other content-bearing detail: privateReadsForRun
  // reports presence/count only, never which private document was read.
  source_vault: string;
}

// Default ledger location: `$XDG_STATE_HOME/daftari/leak-ledger.jsonl` when
// XDG_STATE_HOME is set, else `~/.daftari/leak-ledger.jsonl`. Overridable via
// `leak_gate.session_ledger_path` in either process's config.
export function defaultLeakLedgerPath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? join(xdg, "daftari") : join(homedir(), ".daftari");
  return join(base, "leak-ledger.jsonl");
}

// Resolves the configured path (if any) against the default. Kept as a tiny
// pure function so call sites don't repeat the `?? defaultLeakLedgerPath()`
// fallback inline.
export function leakLedgerPath(configured: string | undefined): string {
  return configured && configured.length > 0 ? configured : defaultLeakLedgerPath();
}

// The stable id for "which vault served this" — the resolved (absolute)
// vault root. Not a content-bearing detail; safe to carry in the ledger.
export function sourceVaultId(vaultRoot: string): string {
  return resolve(vaultRoot);
}

// PREVENTION for the fail-open hole this module used to have: a silently
// swallowed append failure (unwritable dir, ENOSPC) meant the private read
// was never journaled, so a later shared write's ledger SCAN saw ENOENT and
// read it as "nothing recorded" — count 0 — ALLOW. That is indistinguishable
// from a genuinely clean run.
//
// Callers with an ACTIVE gate (leak_gate.mode !== "off") must call this
// BEFORE recording a read/search and refuse to serve (return an error) if it
// fails — so a read that matters to the gate is either journaled or never
// served, and the write-time scan's "nothing recorded" always means what it
// claims. mkdirSync ensures the parent exists (mirroring the append path)
// before checking writability, so a not-yet-created ledger directory is
// still correctly reported as writable.
export function ensureLedgerWritable(ledgerPath: string): Result<void, Error> {
  const dir = dirname(ledgerPath);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return ok(undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`leak ledger directory '${dir}' is not writable: ${reason}`));
  }
}

// Appends one ledger record. Best-effort like recordRead: the caller (a
// read-path tool) must never fail because the ledger append failed. Callers
// are expected to gate on `run_id` being present BEFORE calling this — a
// read with no run_id joins nothing and should never reach here.
export async function recordLeakLedgerEntry(
  ledgerPath: string,
  entry: Omit<LeakLedgerEntry, "timestamp"> & { timestamp?: string },
): Promise<Result<LeakLedgerEntry, Error>> {
  const full: LeakLedgerEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    tool: entry.tool,
    ...(entry.run_id ? { run_id: entry.run_id } : {}),
    ...(entry.principal ? { principal: entry.principal } : {}),
    visibility: entry.visibility,
    source_vault: entry.source_vault,
  };
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    await appendFile(ledgerPath, `${JSON.stringify(full)}\n`);
    return ok(full);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot append to leak ledger: ${reason}`));
  }
}

// Batch variant, mirroring recordReads: many serve records in ONE append
// (and one timestamp). Used by the search-path tools, which can log many
// hits per call — paying a separate fs append per hit would serialize N
// small writes into the request's latency path for no benefit (every hit in
// one call shares the same serving vault, so the same visibility/source).
export async function recordLeakLedgerEntries(
  ledgerPath: string,
  entries: Array<Omit<LeakLedgerEntry, "timestamp"> & { timestamp?: string }>,
): Promise<Result<LeakLedgerEntry[], Error>> {
  if (entries.length === 0) return ok([]);
  const now = new Date().toISOString();
  const full = entries.map(
    (entry): LeakLedgerEntry => ({
      timestamp: entry.timestamp ?? now,
      tool: entry.tool,
      ...(entry.run_id ? { run_id: entry.run_id } : {}),
      ...(entry.principal ? { principal: entry.principal } : {}),
      visibility: entry.visibility,
      source_vault: entry.source_vault,
    }),
  );
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    await appendFile(ledgerPath, `${full.map((e) => JSON.stringify(e)).join("\n")}\n`);
    return ok(full);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot append to leak ledger: ${reason}`));
  }
}

// Reads the ledger back, oldest first. A missing ledger is not an error
// (nothing has been recorded yet, or this process never writes); malformed
// lines are skipped, matching read-log.ts's corrupt-line contract.
export async function readLeakLedger(
  ledgerPath: string,
): Promise<Result<LeakLedgerEntry[], Error>> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read leak ledger: ${reason}`));
  }
  const entries: LeakLedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LeakLedgerEntry;
      if (
        typeof parsed.timestamp === "string" &&
        typeof parsed.source_vault === "string" &&
        (parsed.visibility === "private" || parsed.visibility === "shared")
      ) {
        entries.push(parsed);
      }
    } catch {
      // Skip a corrupt line; the ledger is append-only and best-effort.
    }
  }
  return ok(entries);
}

// Whether the given run read anything from a "private" vault, anywhere
// across the ledger (i.e. across every process that appended to it).
// Returns no source paths — a later write-time refusal (U3) must not leak
// WHICH private document was read, only that one was. Best-effort like the
// rest of this module: a ledger read failure (including "never written")
// degrades to "nothing seen", the same fail-open posture recordRead already
// uses for its own log. U3 should treat this call's absence of evidence
// deliberately (see the leak-ledger unit's report) rather than assume it is
// evidence of absence.
export async function privateReadsForRun(
  ledgerPath: string,
  runId: string,
): Promise<{ count: number; principals: string[] }> {
  const scanned = await privateReadsForRunStrict(ledgerPath, runId);
  // Fail-open: a ledger read error degrades to "nothing seen" for THIS
  // caller. Fine for advisory consumers (search/read instrumentation, warn
  // mode); a `leak_gate.mode: refuse` write-time check must NOT use this
  // function — it needs privateReadsForRunStrict's error to fail closed
  // instead (see write.ts's checkLeakGate).
  if (!scanned.ok) return { count: 0, principals: [] };
  return scanned.value;
}

// Error-surfacing variant of privateReadsForRun, for callers that must fail
// CLOSED on a broken ledger rather than silently reading "no private reads"
// (the write-time refusal gate, U3). A ledger read error here is returned as
// an error, not swallowed — the caller decides what "cannot verify" means for
// its own mode (refuse: deny; anything else: treat as absence of evidence).
export async function privateReadsForRunStrict(
  ledgerPath: string,
  runId: string,
): Promise<Result<{ count: number; principals: string[] }, Error>> {
  const read = await readLeakLedger(ledgerPath);
  if (!read.ok) return read;
  const principals = new Set<string>();
  let count = 0;
  for (const e of read.value) {
    if (e.run_id !== runId || e.visibility !== "private") continue;
    count++;
    if (e.principal) principals.add(e.principal);
  }
  return ok({ count, principals: [...principals] });
}
