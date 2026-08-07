// Tiny bounded-concurrency map: runs `fn` over `items` with at most `limit`
// invocations in flight, resolving to results in INPUT order. Written inline
// (rather than depending on p-limit) because the repo needs exactly this one
// shape: an ordered fan-out over a file list (#7, reindex staging + startup
// manifest stat pass).
//
// Rejection is fail-fast: the first rejection propagates and no NEW work is
// started, but already-in-flight invocations run to completion (they are not
// cancellable). Callers that must never throw should have `fn` return a
// Result instead — both reindex call sites do.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
  }
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    while (!failed) {
      const index = next;
      if (index >= items.length) return;
      next += 1;
      try {
        // items[index] is always defined here (index < length), but noUncheckedIndexedAccess
        // types it T | undefined — the cast restores the invariant.
        results[index] = await fn(items[index] as T, index);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
