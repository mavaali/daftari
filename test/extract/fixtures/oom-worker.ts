// test/extract/fixtures/oom-worker.ts
// Injected via ExtractOptions.workerUrl in harness.test.ts's heap-cap case.
// Deliberately allocates past the small workerHeapMb the test configures via
// resourceLimits, so V8 kills the worker with ERR_WORKER_OUT_OF_MEMORY and
// the harness must map that to "too_large", not "malformed".
const held: number[][] = [];
for (;;) {
  held.push(new Array(1_000_000).fill(Math.random()));
}
