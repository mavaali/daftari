// test/extract/fixtures/fixed-worker.ts
// Injected via ExtractOptions.workerUrl — returns a fixed result immediately,
// used to prove the main thread is unaffected after a prior call timed out.
import { parentPort } from "node:worker_threads";

parentPort?.postMessage({ ok: true, value: { text: "fixed result" } });
