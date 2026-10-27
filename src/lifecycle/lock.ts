// Process-level lockfile for a vault. Prevents two daftari processes from
// running against the same vault concurrently and corrupting the shared
// index.db. See docs/superpowers/plans/2026-05-20-process-lockfile.md (#52).
//
// Lease lock (istf). Liveness is a renewed lease, not "is this pid a daftari
// process?". A vault can be shared across machines (a FUSE-mounted Cowork
// folder seen from several VMs, a network share), where the holder's pid means
// nothing to us and pid reuse is routine, and Windows has no `ps` at all. So:
//   - The holder id is host identity + pid + a random nonce (hostId(), below).
//   - The holder renews every heartbeatMs (default HEARTBEAT_MS) by rewriting
//     its OWN side file, process.lock.hb-<nonce>. process.lock itself is
//     written once, at the claim, and never rewritten — so a holder that
//     stalls and resumes can never overwrite a successor's lock.
//   - Another process may take over only once the lease has lapsed: no renewal
//     for leaseMs (default LEASE_MS = 10 heartbeats). Expiry is judged on the
//     holder's own recorded heartbeatMs/leaseMs, so a future change of the
//     defaults never misjudges an older holder.
//   - A lease that LOOKS lapsed by our wall clock is still watched for one
//     more renewal window before it is broken: a holder whose clock runs
//     behind ours, or that just woke from sleep, renews and is seen as live.
//   - Same-host fast path: if the holder is on this host and its pid is
//     provably dead (`process.kill(pid, 0)` — cross-platform, never `ps`), the
//     lock is stale at once, no lease wait.
//   - A same-host holder is SIGTERMed (the stdio takeover, or serve
//     --takeover) only after its heartbeat is SEEN to advance: a live pid alone
//     may be a recycled one belonging to an unrelated process.
//   - A holder that finds its lock is no longer its own (taken over while it
//     was stalled) stops renewing and reports the lost lease; the servers shut
//     down on it rather than keep writing as a second writer.
// Takeover is atomic: the claim is always an O_EXCL create. Breakers of one
// stale lock are serialized by an O_EXCL succession claim keyed by its bytes;
// the single winner removes it by an atomic rename to a private name and
// checks what it moved — if that is not the lock judged stale, it is put back
// with an O_EXCL create that never overwrites. Release takes the same claim.
// Lock-file transitions depend on no clock; only recovering a crashed
// breaker's claim uses a local timeout.
//
// Accepted residual (decision 2026-10-26): with only O_EXCL and rename — no
// compare-and-swap, no OS lock — a few steps remain check-then-act (e.g. a
// breaker's re-check of the heartbeat, then its rename). The window is
// microseconds wide and needs a process to stall or crash exactly inside it.
// If it is hit, two processes can hold the vault at once, but the one whose
// lock is gone notices at its next renewal and shuts down: overlap is bounded
// by one heartbeat (HEARTBEAT_MS) plus its shutdown drain.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { err, ok, type Result } from "../frontmatter/types.js";

// #5 (spec 2026-07-20 Decision 4): the lock records HOW the holder serves.
// Absent (pre-#5 lockfiles) means stdio.
export type LockMode = "stdio" | "serve";

export type LockData = {
  daftari: true;
  pid: number;
  vaultRoot: string;
  startedAt: string;
  version: string;
  mode?: LockMode;
  // serve holders record their bind so a refusal message can name the
  // remedy ("connect to http://<bind>:<port>/mcp").
  bind?: string;
  // Lease fields (istf). Absent on lockfiles written before the lease lock.
  host?: string;
  macs?: string[];
  nonce?: string;
  heartbeatAt?: string;
  heartbeatMs?: number;
  leaseMs?: number;
};

// Renew every 2s; the lease lapses after 20s without a renewal (10 missed
// heartbeats). 10x absorbs event-loop stalls (a synchronous SQLite batch),
// GC pauses and slow writes on a FUSE or network mount without a live holder
// being judged dead, while a crashed holder on another machine frees the vault
// within ~20s. Same-host crashes do not wait at all (dead-pid fast path).
export const HEARTBEAT_MS = 2_000;
export const LEASE_MS = 10 * HEARTBEAT_MS;
// A lockfile that stays unparseable this long is not one being written.
const UNREADABLE_GRACE_MS = 1_000;

function lockPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "process.lock");
}

// A nonce names a side file, so a foreign lockfile must not be able to steer
// that path anywhere (no separators, no "..").
const NONCE_RE = /^[A-Za-z0-9_-]{1,64}$/;

function heartbeatPath(vaultRoot: string, nonce: string): string | null {
  return NONCE_RE.test(nonce) ? join(vaultRoot, ".daftari", `process.lock.hb-${nonce}`) : null;
}

// The holder's latest renewal: its heartbeat side file, or — before the first
// renewal, or for a lock without one — the claim time recorded in the lock.
export function lastHeartbeat(vaultRoot: string, lock: LockData): string | undefined {
  const path = lock.nonce === undefined ? null : heartbeatPath(vaultRoot, lock.nonce);
  if (path !== null) {
    const raw = readOptional(path);
    if (raw) {
      try {
        const hb = JSON.parse(raw) as { nonce?: unknown; heartbeatAt?: unknown };
        if (hb.nonce === lock.nonce && typeof hb.heartbeatAt === "string") return hb.heartbeatAt;
      } catch {
        // mid-replace or garbage: fall back to the claim time
      }
    }
  }
  return lock.heartbeatAt;
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

// Host identity: hostname, plus on Linux the kernel boot id and the pid
// namespace. The pid namespace matters: sandboxes inside one VM (and
// containers on one kernel) share a boot id but not a pid space, so a pid
// read from another namespace says nothing about liveness here. macOS and
// Windows expose no boot id without a subprocess, so there the hostname is
// paired with the machine's hardware (MAC) addresses — see isSameHost.
let cachedHostId: string | undefined;
export function hostId(): string {
  if (cachedHostId !== undefined) return cachedHostId;
  const parts = [hostname()];
  const boot = readOptional("/proc/sys/kernel/random/boot_id");
  if (boot) parts.push(`boot=${boot}`);
  try {
    parts.push(`pidns=${readlinkSync("/proc/self/ns/pid")}`);
  } catch {
    // Not Linux (or /proc unavailable): hostname + MACs only.
  }
  cachedHostId = parts.join("|");
  return cachedHostId;
}

let cachedMacs: string[] | undefined;
function hostMacs(): string[] {
  if (cachedMacs !== undefined) return cachedMacs;
  const macs = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list ?? []) {
      if (!nic.internal && nic.mac && nic.mac !== "00:00:00:00:00:00") macs.add(nic.mac);
    }
  }
  cachedMacs = [...macs].sort();
  return cachedMacs;
}

// Same host = same host id AND, when both sides recorded hardware addresses,
// at least one in common. Intersection rather than equality: a VPN or a
// docker bridge coming up between two starts must not turn this machine into
// "another machine". Two distinct machines that share a hostname (default Mac
// names collide) differ in hardware addresses, so the dead-pid fast path never
// fires against a holder on the other one.
function isSameHost(prior: LockData): boolean {
  if (prior.host !== hostId()) return false;
  const theirs = prior.macs ?? [];
  const ours = hostMacs();
  if (theirs.length === 0 || ours.length === 0) return true;
  return theirs.some((m) => ours.includes(m));
}

function parseLock(raw: string): LockData | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as LockData).daftari === true &&
      typeof (parsed as LockData).pid === "number"
    ) {
      return parsed as LockData;
    }
    return null;
  } catch {
    return null;
  }
}

// Raw lockfile content, null when absent. Windows can refuse to open a file
// that is being atomically replaced at that instant (EPERM/EBUSY); a short
// retry rides that out instead of failing the acquire.
function readRaw(path: string): Result<string | null, Error> {
  for (let i = 0; ; i++) {
    try {
      return ok(readFileSync(path, "utf-8"));
    } catch (e) {
      const errno = e as NodeJS.ErrnoException;
      if (errno.code === "ENOENT") return ok(null);
      if ((errno.code === "EPERM" || errno.code === "EBUSY") && i < 5) continue;
      return err(errno);
    }
  }
}

export function readLockfile(vaultRoot: string): Result<LockData | null, Error> {
  const raw = readRaw(lockPath(vaultRoot));
  if (!raw.ok) return raw;
  if (raw.value === null) return ok(null);
  return ok(parseLock(raw.value));
}

export function writeLockfile(vaultRoot: string, data: LockData): Result<void, Error> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    writeFileSync(lockPath(vaultRoot), JSON.stringify(data, null, 2), "utf-8");
    return ok(undefined);
  } catch (e) {
    return err(e as Error);
  }
}

// `kill(pid, 0)` tests process liveness without delivering a signal, on POSIX
// and on Windows. ESRCH = no such process; EPERM = exists but not ours (still
// alive for our purposes). Meaningful only for a pid on THIS host.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const errno = e as NodeJS.ErrnoException;
    return errno.code === "EPERM";
  }
}

// Wait until pid exits or until timeoutMs elapses. Returns true if pid is
// gone. Polled with setTimeout so we don't peg a CPU core during the grace
// window.
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const POLL_MS = 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(POLL_MS);
  }
  return !isProcessAlive(pid);
}

const SIGTERM_GRACE_MS = 3000;

// Atomic O_EXCL create. Returns ok(true) if we created the lockfile (sole
// owner), ok(false) on EEXIST (caller must read and resolve).
function tryCreateExclusive(path: string, content: string): Result<boolean, Error> {
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return ok(true);
  } catch (e) {
    const errno = e as NodeJS.ErrnoException;
    if (errno.code === "EEXIST") return ok(false);
    return err(errno);
  }
}

// How many times acquireLock re-attempts the atomic claim when it keeps losing
// the race to a competing acquirer. Each iteration either creates the lock
// (O_EXCL), returns a definitive refusal, or removes a defunct lock and retries;
// the bound stops two simultaneous stdio takeovers from ping-ponging forever.
const MAX_ACQUIRE_ATTEMPTS = 5;

function sameLock(a: LockData, b: LockData): boolean {
  return (
    a.pid === b.pid &&
    a.startedAt === b.startedAt &&
    a.nonce === b.nonce &&
    a.heartbeatAt === b.heartbeatAt
  );
}

// Remove the lockfile iff it still holds `expected` — a parsed lock (same
// pid, startedAt, nonce, claim time) or the exact raw bytes of an unreadable
// one. Returns true if it removed it.
//
// The check and the removal are one atomic step: rename the file to a name
// only we know, then look at what we moved. If it is not `expected` (a
// competing acquirer replaced the stale lock in the race window), put it back
// with link(), which fails rather than overwrite should yet another lock have
// appeared meanwhile — in which case the displaced owner finds its lock gone
// at its next renewal and stops (see startHeartbeat). A plain read-then-unlink
// here could delete a competitor's fresh lock.
export function removeLockIfUnchanged(vaultRoot: string, expected: LockData | string): boolean {
  const path = lockPath(vaultRoot);
  const isExpected = (raw: string): boolean => {
    if (typeof expected === "string") return raw === expected.trim();
    const parsed = parseLock(raw);
    return parsed !== null && sameLock(parsed, expected);
  };
  // Cheap pre-check: never even move a lock that is visibly not ours to move.
  const before = readOptional(path);
  if (before === null || !isExpected(before)) return false;
  const grave = `${path}.gone-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, grave);
  } catch {
    return false; // already gone (or unmovable) — the next exclusive create decides
  }
  const movedRaw = readOptional(grave) ?? "";
  const moved = parseLock(movedRaw);
  if (!isExpected(movedRaw)) {
    restoreLock(grave, path, movedRaw);
    return false;
  }
  try {
    unlinkSync(grave);
  } catch {
    // leftover side file; harmless and gitignored
  }
  const hb = moved?.nonce === undefined ? null : heartbeatPath(vaultRoot, moved.nonce);
  if (hb !== null) {
    try {
      unlinkSync(hb);
    } catch {
      // no heartbeat file yet
    }
  }
  return true;
}

// Put a lock we moved by mistake back, never overwriting a newer one: an
// O_EXCL create of the same bytes (works on every filesystem, unlike link()).
// Owners recognise their lock by its content (nonce), not its inode.
function restoreLock(grave: string, path: string, raw: string): void {
  tryCreateExclusive(path, raw);
  try {
    unlinkSync(grave);
  } catch {
    // leftover side file; harmless and gitignored
  }
}

// A succession claim is held for the microseconds it takes to verify and
// move one stale lock. One that sits unchanged this long — by our own
// observation, never by comparing clocks — belongs to a breaker that crashed.
const CLAIM_STALE_MS = 10_000;

// Break a lock judged stale. Breakers of the same stale lock are serialized
// by an O_EXCL succession claim keyed by that lock's exact bytes, so only one
// of them ever moves it (racing breakers would otherwise move each other's
// fresh locks). A crashed breaker's claim is escalated by O_EXCL-claiming the
// next level, never by deleting it, so recovery cannot itself race. Waiting
// out a claim happens here, not in the acquire retry budget, so a fresh
// process can always recover a claim abandoned by a crash. Returns true if
// this call removed the lock.
function claimPath(vaultRoot: string, raw: string, level: number): string {
  const key = createHash("sha256").update(raw.trim()).digest("hex").slice(0, 24);
  return `${lockPath(vaultRoot)}.succ-${key}-${level}`;
}

function dropClaims(vaultRoot: string, raw: string, upToLevel: number): void {
  for (let level = upToLevel; level >= 0; level--) {
    try {
      unlinkSync(claimPath(vaultRoot, raw, level));
    } catch {
      // already gone
    }
  }
}

function claimBody(): string {
  return JSON.stringify({ host: hostId(), pid: process.pid, at: new Date().toISOString() });
}

// `beatAtJudgment` is the holder's heartbeat as read BEFORE the stale verdict
// (the caller passes it in; re-reading it here would adopt a renewal that
// landed after the verdict as the baseline and miss it). Its process.lock
// bytes never change, so a renewal shows only in its heartbeat file: if that
// moves from the judged value before we remove the lock, the holder is alive
// and we must not. Exported for tests.
export async function breakStale(
  vaultRoot: string,
  raw: string,
  beatAtJudgment: string | undefined,
): Promise<boolean> {
  const judged = parseLock(raw);
  const renewed = (): boolean =>
    judged !== null && lastHeartbeat(vaultRoot, judged) !== beatAtJudgment;
  for (let level = 0; level < 8; level++) {
    const claim = claimPath(vaultRoot, raw, level);
    const created = tryCreateExclusive(claim, claimBody());
    if (!created.ok) return false;
    if (created.value) {
      try {
        if (renewed()) return false; // live after all: re-evaluate
        return removeLockIfUnchanged(vaultRoot, raw);
      } finally {
        // Done with these bytes either way. Drop our claim and the abandoned
        // ones we escalated past, so a later breaker of the same (still
        // current) lock is not stalled behind a finished claim, and repeated
        // aborts cannot use up the escalation levels.
        dropClaims(vaultRoot, raw, level);
      }
    }
    const claimant = readOptional(claim);
    if (claimant === null) return false; // finished just now: re-evaluate
    if (!claimantIsDead(claimant)) {
      // A breaker (or the releasing holder) is at work. Watch until it
      // finishes — the lock changes or the claim goes — the holder renews, or
      // the claim proves abandoned.
      const since = performance.now();
      for (;;) {
        await sleep(50);
        if ((readOptional(lockPath(vaultRoot)) ?? "") !== raw.trim()) return false;
        if (readOptional(claim) !== claimant) return false;
        if (renewed()) return false;
        if (performance.now() - since > CLAIM_STALE_MS) break;
      }
    }
    // Abandoned: escalate to the next level.
  }
  return false;
}

function claimantIsDead(raw: string): boolean {
  try {
    const c = JSON.parse(raw) as { host?: unknown; pid?: unknown };
    return (
      c.host === hostId() &&
      typeof c.pid === "number" &&
      c.pid !== process.pid &&
      !isProcessAlive(c.pid)
    );
  } catch {
    return false;
  }
}

// Succession claims are only meaningful while the lock they name is current;
// a new holder clears them. (A late breaker re-creating one still finds the
// lock changed and moves nothing.)
function clearClaims(vaultRoot: string): void {
  try {
    for (const f of readdirSync(join(vaultRoot, ".daftari"))) {
      if (f.startsWith("process.lock.succ-")) unlinkSync(join(vaultRoot, ".daftari", f));
    }
  } catch {
    // best effort
  }
}

function clampHeartbeat(ms: unknown): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 10 && ms <= 60_000
    ? ms
    : HEARTBEAT_MS;
}

function clampLease(ms: unknown, heartbeatMs: number): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 2 * heartbeatMs && ms <= 600_000
    ? ms
    : Math.max(LEASE_MS, 10 * heartbeatMs);
}

// ---- heartbeat -------------------------------------------------------------

type Held = { nonce: string; timer: NodeJS.Timeout; data: LockData };
const held = new Map<string, Held>();

// Renewal writes only the holder's own side file (tmp + atomic rename), never
// process.lock.
function writeHeartbeat(vaultRoot: string, nonce: string): void {
  const path = heartbeatPath(vaultRoot, nonce);
  if (path === null) return;
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ nonce, heartbeatAt: new Date().toISOString() }), "utf-8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw e;
  }
}

function removeHeartbeat(vaultRoot: string, nonce: string): void {
  const path = heartbeatPath(vaultRoot, nonce);
  if (path === null) return;
  try {
    unlinkSync(path);
  } catch {
    // never written, or already removed by a breaker
  }
}

function stopHeartbeat(vaultRoot: string): void {
  const h = held.get(vaultRoot);
  if (!h) return;
  clearInterval(h.timer);
  held.delete(vaultRoot);
}

function startHeartbeat(vaultRoot: string, data: LockData, onLeaseLost?: () => void): void {
  const nonce = data.nonce as string;
  let warned = false;
  // Each beat first checks that process.lock is still ours. Renewal touches
  // only our own heartbeat file, so even a beat that stalls between the check
  // and the write cannot disturb a successor: a stalled-and-resumed holder at
  // worst refreshes a heartbeat file nobody reads, then sees the successor's
  // nonce on the next beat and stops.
  const beat = () => {
    if (held.get(vaultRoot)?.nonce !== nonce) return;
    const raw = readRaw(lockPath(vaultRoot));
    if (!raw.ok) return; // transient read failure — try next beat
    if (raw.value === null) {
      // Removed out from under us (by hand, or by a breaker that judged the
      // lease lapsed and has not claimed yet). Reclaim it with the same atomic
      // create every acquirer uses: if a contender created first, the next
      // beat sees its nonce and reports the loss.
      tryCreateExclusive(lockPath(vaultRoot), JSON.stringify(data, null, 2));
      return;
    }
    const current = parseLock(raw.value);
    if (current === null) return; // a contender mid-write; judge next beat
    if (current.nonce !== nonce) {
      stopHeartbeat(vaultRoot);
      removeHeartbeat(vaultRoot, nonce);
      process.stderr.write(
        `daftari: lost the vault lock for ${vaultRoot} — another process took it over ` +
          `(holder now: pid=${current.pid}); stopping so two processes never write one vault\n`,
      );
      onLeaseLost?.();
      return;
    }
    try {
      writeHeartbeat(vaultRoot, nonce);
      warned = false;
    } catch (e) {
      if (!warned) {
        warned = true;
        process.stderr.write(
          `daftari: warning: could not renew the vault lease: ${(e as Error).message}\n`,
        );
      }
    }
  };
  const timer = setInterval(beat, data.heartbeatMs);
  timer.unref();
  held.set(vaultRoot, { nonce, timer, data });
}

// ---- acquire ---------------------------------------------------------------

export interface AcquireLockOptions {
  mode?: LockMode; // default "stdio"
  bind?: string; // recorded for serve holders (refusal-message remedy)
  // Explicit consent to SIGTERM a LIVE holder from `daftari serve`. Without
  // it, serve refuses against any live holder (Decision 4).
  takeover?: boolean;
  // Lease timing for THIS holder (defaults HEARTBEAT_MS / LEASE_MS). Recorded
  // in the lock, so contenders judge expiry by the holder's own numbers.
  heartbeatMs?: number;
  leaseMs?: number;
  // Called (once) if a heartbeat finds the lock no longer ours. The servers
  // shut down on it.
  onLeaseLost?: () => void;
}

type Watch =
  | { kind: "advanced"; latest: LockData }
  | { kind: "changed" }
  | { kind: "dead" }
  | { kind: "timeout" };

// Watch a lease until its heartbeat advances (holder alive), the lock is
// replaced/removed, a same-host holder's pid dies, or the deadline passes.
async function watchLease(
  vaultRoot: string,
  prior: LockData,
  deadline: number,
  sameHost: boolean,
): Promise<Watch> {
  const pollMs = Math.max(10, Math.min(100, clampHeartbeat(prior.heartbeatMs) / 4));
  const priorBeat = lastHeartbeat(vaultRoot, prior);
  for (;;) {
    const cur = readLockfile(vaultRoot);
    if (cur.ok) {
      if (cur.value === null || cur.value.nonce !== prior.nonce) return { kind: "changed" };
      if (lastHeartbeat(vaultRoot, cur.value) !== priorBeat) {
        return { kind: "advanced", latest: cur.value };
      }
    }
    if (sameHost && !isProcessAlive(prior.pid)) return { kind: "dead" };
    if (Date.now() >= deadline) return { kind: "timeout" };
    await sleep(pollMs);
  }
}

type Verdict =
  | { kind: "stale"; why: string }
  | { kind: "refuse"; error: Error }
  | { kind: "signal"; latest: LockData; holder: string }
  | { kind: "changed" };

function describeHolder(prior: LockData, foreign: boolean): string {
  const priorMode: LockMode = prior.mode ?? "stdio";
  return (
    `pid=${prior.pid}, mode=${priorMode}, started=${prior.startedAt}` +
    (prior.bind ? `, bind=${prior.bind}` : "") +
    (foreign && prior.host ? `, host=${prior.host.split("|")[0]}` : "")
  );
}

// The #5 refusal matrix for a LIVE holder. Null = the rule is to take over.
function modeRefusal(
  mode: LockMode,
  prior: LockData,
  holder: string,
  takeover: boolean,
): Error | null {
  const priorMode: LockMode = prior.mode ?? "stdio";
  if (mode === "stdio" && priorMode === "serve") {
    return new Error(
      `this vault is held by a live daftari serve (${holder}). ` +
        `Connect to it over HTTP instead, or stop the server ` +
        `deliberately (or replace it with 'daftari serve --takeover').`,
    );
  }
  if (mode === "serve" && !takeover) {
    return new Error(
      `this vault is held by a live daftari instance (${holder}). ` +
        `A server start never silently replaces a live holder; ` +
        `re-run with --takeover to replace it deliberately.`,
    );
  }
  return null;
}

async function judge(
  vaultRoot: string,
  prior: LockData,
  mode: LockMode,
  takeover: boolean,
): Promise<Verdict> {
  // A pre-lease lockfile (no nonce/heartbeat): its holder never renews, so
  // only a dead pid proves it stale. A live pid may be the old daftari or a
  // recycled pid — without `ps` we cannot tell, so we refuse rather than
  // signal a possibly unrelated process.
  if (prior.nonce === undefined || prior.heartbeatAt === undefined) {
    if (prior.pid === process.pid) {
      return {
        kind: "stale",
        why:
          `names our own pid ${prior.pid} — ` +
          `a leftover from a previous incarnation that had the same pid`,
      };
    }
    if (!isProcessAlive(prior.pid)) {
      return { kind: "stale", why: `pid=${prior.pid} not a live daftari instance` };
    }
    const holder = describeHolder(prior, false);
    const refusal = modeRefusal(mode, prior, holder, takeover);
    if (refusal) return { kind: "refuse", error: refusal };
    return {
      kind: "refuse",
      error: new Error(
        `this vault is held by an older daftari that does not renew a lease (${holder}). ` +
          `It cannot be told apart from an unrelated process that reused its pid, so it is ` +
          `not signalled: stop that daftari, or, if none is running, delete ${lockPath(vaultRoot)}.`,
      ),
    };
  }

  const sameHost = isSameHost(prior);
  // Same host and our own pid: we are alive and this is not our lock (a
  // re-acquire stops our heartbeat first), so it is a previous incarnation's.
  if (sameHost && prior.pid === process.pid) {
    return {
      kind: "stale",
      why:
        `names our own pid ${prior.pid} — ` +
        `a leftover from a previous incarnation that had the same pid`,
    };
  }
  // Same-host fast path: a provably dead holder.
  if (sameHost && !isProcessAlive(prior.pid)) {
    return { kind: "stale", why: `pid=${prior.pid} not a live daftari instance` };
  }

  const heartbeatMs = clampHeartbeat(prior.heartbeatMs);
  const leaseMs = clampLease(prior.leaseMs, heartbeatMs);
  const lastBeat = Date.parse(lastHeartbeat(vaultRoot, prior) ?? "");
  let latest = prior;
  let proven = false;

  const age = Date.now() - lastBeat;
  const lapsedByClock = !(age <= leaseMs); // NaN (unparseable) counts as lapsed
  // A heartbeat dated in our future: the holder's clock runs ahead, so our
  // clock says nothing about when it last renewed. Judge it by local
  // observation alone — a full lease with no renewal — or a crashed holder
  // with a fast clock would block the vault for as long as its offset.
  const futureDated = age < -heartbeatMs;
  if (lapsedByClock || futureDated) {
    // Lapsed by our clock: watch one more renewal window before believing it
    // — a holder whose clock lags ours, or that just woke from sleep, renews.
    const window = futureDated ? leaseMs : 2 * heartbeatMs + 250;
    const w = await watchLease(vaultRoot, prior, Date.now() + window, sameHost);
    if (w.kind === "changed") return { kind: "changed" };
    if (w.kind === "dead") {
      return { kind: "stale", why: `pid=${prior.pid} not a live daftari instance` };
    }
    if (w.kind === "timeout") {
      return {
        kind: "stale",
        why:
          `pid=${prior.pid}${sameHost ? "" : ` on ${prior.host?.split("|")[0]}`}: ` +
          (futureDated ? `no renewal seen for ${window}ms (holder clock ahead)` : "lease lapsed"),
      };
    }
    latest = w.latest;
    proven = true;
  }

  const holder = describeHolder(latest, !sameHost);
  const refusal = modeRefusal(mode, latest, holder, takeover);
  if (refusal) return { kind: "refuse", error: refusal };

  if (!sameHost) {
    return {
      kind: "refuse",
      error: new Error(
        `this vault is held by a live daftari on another machine (${holder}). ` +
          `A process on another machine cannot be signalled from here: stop it there, ` +
          `or, if it has crashed, retry once its lease lapses (${Math.round(leaseMs / 1000)}s ` +
          `after its last heartbeat).`,
      ),
    };
  }

  if (!proven) {
    // Signal only a holder whose heartbeat we SEE advance; a live pid alone
    // may be recycled. Bounded by the lease: if it never renews, it is stale.
    const w = await watchLease(
      vaultRoot,
      latest,
      Date.parse(lastHeartbeat(vaultRoot, latest) ?? "") + leaseMs,
      true,
    );
    if (w.kind === "changed") return { kind: "changed" };
    if (w.kind === "dead") {
      return { kind: "stale", why: `pid=${prior.pid} not a live daftari instance` };
    }
    if (w.kind === "timeout") {
      return { kind: "stale", why: `pid=${prior.pid} lease lapsed without renewal` };
    }
    latest = w.latest;
  }
  return { kind: "signal", latest, holder };
}

// Acquire the per-vault process lock. Behavior (#52, amended by #5 spec
// 2026-07-20 Decision 4, and by the lease lock, istf):
//   - No existing lock → atomic O_EXCL create, return ok.
//   - Stale lock (lease lapsed, or same-host holder pid dead) → removed under
//     the break mutex, then the O_EXCL create is retried (every mode).
//   - LIVE holder — precedence favors the durable tenant:
//       stdio finding stdio          → SIGTERM-and-wait takeover (the
//                                      single-user convenience, unchanged).
//       stdio finding serve          → REFUSE, naming the server and the
//                                      remedy. Never SIGTERMs a serve holder.
//       serve finding stdio or serve → REFUSE unless --takeover: a server
//                                      deployment must not silently kill a
//                                      live desktop session, and a
//                                      double-start must not bounce every
//                                      session. With takeover, SIGTERM-and-
//                                      wait against either holder mode.
//     A live holder on ANOTHER host cannot be signalled, so the takeover
//     rows refuse for it too.
//
// Logs go to stderr (MCP convention; stdout is reserved for JSON-RPC).
export async function acquireLock(
  vaultRoot: string,
  version: string,
  options: AcquireLockOptions = {},
): Promise<Result<void, Error>> {
  const mode: LockMode = options.mode ?? "stdio";
  const heartbeatMs = clampHeartbeat(options.heartbeatMs);
  const leaseMs = clampLease(options.leaseMs, heartbeatMs);
  // Re-acquiring a vault this process already holds replaces our own lock.
  stopHeartbeat(vaultRoot);
  const our: LockData = {
    daftari: true,
    pid: process.pid,
    vaultRoot,
    startedAt: new Date().toISOString(),
    version,
    mode,
    ...(options.bind ? { bind: options.bind } : {}),
    host: hostId(),
    macs: hostMacs(),
    nonce: randomBytes(16).toString("hex"),
    heartbeatAt: new Date().toISOString(),
    heartbeatMs,
    leaseMs,
  };

  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
  } catch (e) {
    return err(e as Error);
  }

  // The claim is ALWAYS the atomic O_EXCL create — never a plain overwrite.
  // On EEXIST we resolve the existing lock (refuse, or SIGTERM-and-wait a live
  // holder, or break a stale one) and loop so the create is retried.
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const mine: LockData = { ...our, heartbeatAt: new Date().toISOString() };
    const created = tryCreateExclusive(lockPath(vaultRoot), JSON.stringify(mine, null, 2));
    if (!created.ok) return created;
    if (created.value) {
      startHeartbeat(vaultRoot, mine, options.onLeaseLost);
      clearClaims(vaultRoot);
      return ok(undefined);
    }

    const raw = readRaw(lockPath(vaultRoot));
    if (!raw.ok) return raw;
    if (raw.value === null) {
      // The lock vanished between our failed exclusive create and this read
      // (the holder released, or a competing acquirer removed a stale lock).
      continue;
    }
    const prior = parseLock(raw.value);
    if (prior === null) {
      // Unparseable: a creator mid-write (gone in microseconds) or garbage.
      await sleep(UNREADABLE_GRACE_MS);
      const again = readRaw(lockPath(vaultRoot));
      if (!again.ok) return again;
      if (again.value !== raw.value) continue;
      process.stderr.write("daftari: removing unreadable lockfile\n");
      await breakStale(vaultRoot, raw.value, undefined);
      continue;
    }

    // Read the holder's heartbeat before judging: every stale verdict means
    // "no renewal since this value", so the removal step compares against it.
    const beatBeforeJudgment = lastHeartbeat(vaultRoot, prior);
    const verdict = await judge(vaultRoot, prior, mode, options.takeover === true);
    if (verdict.kind === "refuse") return err(verdict.error);
    if (verdict.kind === "changed") continue;
    if (verdict.kind === "stale") {
      process.stderr.write(`daftari: removing stale lockfile (${verdict.why})\n`);
      // Only if it is still byte-for-byte the lock we judged (a live holder
      // never rewrites process.lock, so any change means a new claimant).
      await breakStale(vaultRoot, raw.value, beatBeforeJudgment);
      continue;
    }

    // signal: a live same-host holder whose heartbeat we saw advance.
    process.stderr.write(
      `daftari: another instance is holding this vault (${verdict.holder}); ` +
        `sending SIGTERM and taking over\n`,
    );
    try {
      process.kill(verdict.latest.pid, "SIGTERM");
    } catch {
      // Died between check and signal — fine.
    }
    const exited = await waitForExit(verdict.latest.pid, SIGTERM_GRACE_MS);
    if (!exited) {
      process.stderr.write(
        `daftari: warning: pid ${verdict.latest.pid} did not exit within ` +
          `${SIGTERM_GRACE_MS}ms; it keeps the vault until it stops renewing\n`,
      );
    }
    // A clean exit released the lock itself. If it did not, the next pass
    // sees a dead same-host pid (stale) — or, if it is still renewing, a live
    // holder again — and never removes a lock that is still being renewed.
  }

  return err(
    new Error(
      `could not acquire the process lock for ${vaultRoot} after ` +
        `${MAX_ACQUIRE_ATTEMPTS} attempts — the vault is under heavy ` +
        `acquisition contention; retry`,
    ),
  );
}

// Idempotent. Removes the lockfile only if it still belongs to us (our nonce)
// — protects against a race where takeover happens during our shutdown and
// we'd otherwise delete the new owner's lock. Stays sync because it runs from
// `process.on("exit")`, which forbids async work.
export function releaseLock(vaultRoot: string): void {
  const mine = held.get(vaultRoot);
  stopHeartbeat(vaultRoot);
  if (mine === undefined) return;
  // Release is a lock transition like any other, so it takes the same
  // level-0 succession claim a breaker of our lock would. Only the claim
  // holder may remove a given lock, so no breaker can sit between its check
  // and its move while we release (and vice versa). If a breaker already
  // holds the claim, it owns the removal: we leave the lock, which is stale
  // the moment we exit.
  const ourRaw = JSON.stringify(mine.data, null, 2);
  const claimed = tryCreateExclusive(claimPath(vaultRoot, ourRaw, 0), claimBody());
  if (claimed.ok && claimed.value) {
    removeLockIfUnchanged(vaultRoot, mine.data);
    dropClaims(vaultRoot, ourRaw, 0);
  }
  removeHeartbeat(vaultRoot, mine.nonce);
}
