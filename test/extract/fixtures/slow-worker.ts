// test/extract/fixtures/slow-worker.ts
// Injected via ExtractOptions.workerUrl in harness.test.ts's timeout case.
// Sleeps well past the test's tiny wallClockMs before ever responding, so
// extractText must resolve via its own timeout path, not this message.
import { parentPort } from "node:worker_threads";

setTimeout(() => {
  parentPort?.postMessage({ ok: true, value: { text: "arrived too late" } });
}, 2_000);
