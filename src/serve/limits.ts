// The serve ops floor's pure mechanics (multi-user assessment, item 6):
// per-principal token buckets, the per-IP auth-failure penalty box, and the
// global in-flight slot gate. Process-local in-memory state is correct here
// by construction — one `daftari serve` per vault is the invariant
// (.daftari/process.lock, 2026-07-20 Decisions 3/4), the principal set is
// config-declared and finite, and a restart re-arms the floor immediately.
// All clocks are injected (`nowMs`) — the locks.ts injectable-now precedent.

// Defaults sized for a ~10-user team: `burst 40` absorbs an agent turn that
// fans out dozens of tool calls; 120/min sustained caps a runaway loop's
// damage to ~2 O(vault) scans a second; 10 auth failures then a ~10s drip
// lets a human fix a mistyped token without lockout drama; 32 in-flight
// bounds memory/socket pile-up (better-sqlite3 is synchronous, so true
// parallelism is event-loop-bounded regardless).
export interface ServeLimits {
  ratePerMinute: number;
  burst: number;
  authFailureBurst: number;
  authFailuresPerMinute: number;
  maxInFlight: number;
}

export const DEFAULT_LIMITS: ServeLimits = {
  ratePerMinute: 120,
  burst: 40,
  authFailureBurst: 10,
  authFailuresPerMinute: 6,
  maxInFlight: 32,
};

export interface Bucket {
  tokens: number;
  capacity: number;
  refillPerMinute: number;
  lastRefillMs: number;
}

export function makeBucket(capacity: number, refillPerMinute: number, nowMs: number): Bucket {
  return { tokens: capacity, capacity, refillPerMinute, lastRefillMs: nowMs };
}

function refill(b: Bucket, nowMs: number): void {
  const elapsed = Math.max(0, nowMs - b.lastRefillMs);
  b.tokens = Math.min(b.capacity, b.tokens + (elapsed / 60_000) * b.refillPerMinute);
  b.lastRefillMs = nowMs;
}

// Seconds until one whole token accrues — what a 429's Retry-After reports.
function secondsUntilOneToken(b: Bucket): number {
  const needed = Math.max(0, 1 - b.tokens);
  return Math.max(1, Math.ceil((needed * 60_000) / b.refillPerMinute / 1000));
}

export interface TakeResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function tryTake(b: Bucket, nowMs: number): TakeResult {
  refill(b, nowMs);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return { allowed: false, retryAfterSeconds: secondsUntilOneToken(b) };
}

export interface BucketRegistry {
  buckets: Map<string, { bucket: Bucket; lastSeenMs: number }>;
  capacity: number;
  refillPerMinute: number;
  maxEntries: number;
  idleTtlMs: number;
}

export function makeBucketRegistry(
  capacity: number,
  refillPerMinute: number,
  maxEntries = 10_000,
  idleTtlMs = 10 * 60_000,
): BucketRegistry {
  return {
    buckets: new Map(),
    capacity,
    refillPerMinute,
    maxEntries,
    idleTtlMs,
  };
}

/** Bounded, idle-expiring LRU registry for attacker-influenced bucket keys. */
export function takeFromRegistry(registry: BucketRegistry, key: string, nowMs: number): TakeResult {
  let tracked = registry.buckets.get(key);
  if (tracked === undefined) {
    for (const [existingKey, existing] of registry.buckets) {
      if (nowMs - existing.lastSeenMs >= registry.idleTtlMs) {
        registry.buckets.delete(existingKey);
      }
    }
    while (registry.buckets.size >= registry.maxEntries) {
      const oldest = registry.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      registry.buckets.delete(oldest);
    }
    tracked = {
      bucket: makeBucket(registry.capacity, registry.refillPerMinute, nowMs),
      lastSeenMs: nowMs,
    };
  } else {
    registry.buckets.delete(key);
    tracked.lastSeenMs = nowMs;
  }
  registry.buckets.set(key, tracked);
  return tryTake(tracked.bucket, nowMs);
}

// The pre-auth penalty box: keyed per remote IP, CHECKED before any auth
// work runs (bounding the CPU an unauthenticated flood can spend on
// constant-time token matching and JWT verification) but CHARGED only by a
// 401/403 outcome — a legitimate authenticated client never touches it.
export interface PenaltyBox {
  buckets: Map<string, Bucket>;
  failureBurst: number;
  failuresPerMinute: number;
  maxEntries: number;
}

export function makePenaltyBox(
  failureBurst: number,
  failuresPerMinute: number,
  maxEntries = 10_000,
): PenaltyBox {
  return { buckets: new Map(), failureBurst, failuresPerMinute, maxEntries };
}

export function penaltyAllows(box: PenaltyBox, key: string, nowMs: number): TakeResult {
  const b = box.buckets.get(key);
  if (!b) return { allowed: true, retryAfterSeconds: 0 };
  refill(b, nowMs);
  if (b.tokens >= 1) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: secondsUntilOneToken(b) };
}

export function chargePenalty(box: PenaltyBox, key: string, nowMs: number): void {
  let b = box.buckets.get(key);
  if (!b) {
    b = makeBucket(box.failureBurst, box.failuresPerMinute, nowMs);
    // Bound the map against IP-cycling attackers: sweep entries whose bucket
    // has refilled to capacity — a full bucket is informationally identical
    // to an absent one, so the sweep is lossless and deterministic.
    if (box.buckets.size >= box.maxEntries) {
      for (const [k, existing] of box.buckets) {
        refill(existing, nowMs);
        if (existing.tokens >= existing.capacity) box.buckets.delete(k);
      }
      // The lossless sweep frees nothing when every bucket is still draining
      // (source-IP churn under a sustained flood). Fall back to evicting the
      // oldest entries so the map is a HARD cap, matching the bounded bucket
      // registry — dropping a partially drained bucket lets that IP back in,
      // the accepted cost of bounding memory under churn.
      while (box.buckets.size >= box.maxEntries) {
        const oldest = box.buckets.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        box.buckets.delete(oldest);
      }
    }
    box.buckets.set(key, b);
  }
  refill(b, nowMs);
  b.tokens = Math.max(0, b.tokens - 1);
}

// The global in-flight ceiling: reject-don't-queue (the file lease's own
// "fail cleanly, no wait-and-retry" property, one layer up — a bounded HTTP
// queue would age read snapshots and inflate stale-write rejections).
export interface SlotGate {
  inFlight: number;
  max: number;
}

export function makeSlotGate(max: number): SlotGate {
  return { inFlight: 0, max };
}

export function tryAcquireSlot(gate: SlotGate): boolean {
  if (gate.inFlight >= gate.max) return false;
  gate.inFlight += 1;
  return true;
}

export function releaseSlot(gate: SlotGate): void {
  gate.inFlight = Math.max(0, gate.inFlight - 1);
}
