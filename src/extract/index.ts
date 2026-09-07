// src/extract/index.ts
// Provider-neutral extraction entry point. Runs document extraction in a
// bounded worker_threads Worker: a wall-clock timeout terminates the worker
// on overrun (→ "timeout"), and a heap cap is enforced via the worker's
// resourceLimits. Real docx/pptx/pdf parsing lives in worker.ts's dispatch
// table (wired by U7/U8/U9) — this module only owns the harness.

import { Worker } from "node:worker_threads";
import { err, ok, type Result } from "../frontmatter/types.js";
import type {
  ExtractError,
  ExtractKind,
  ExtractLimits,
  ExtractRequest,
  ExtractResult,
} from "./types.js";
import { isExtractWorkerResponse } from "./types.js";

export interface ExtractOptions {
  /**
   * Override the worker script the harness spawns. Tests use this seam to
   * inject a fixture worker (one that sleeps past wallClockMs, or returns a
   * fixed result) without touching the real dispatch table.
   */
  workerUrl?: URL;
  /** execArgv passed to the spawned Worker — e.g. ["--import", "tsx"] to run a .ts worker directly. */
  execArgv?: string[];
}

// In dev/test the running module is still TypeScript (vitest/tsx serve
// source files as-is, so import.meta.url ends in .ts); in the published
// package it's compiled to dist/extract/index.js. Either way the sibling
// worker file is resolved relative to this module, so no separate build
// step or path config is needed for the harness to find its worker.
function defaultWorkerTarget(): { url: URL; execArgv: string[] } {
  const isTs = import.meta.url.endsWith(".ts");
  return {
    url: new URL(isTs ? "./worker.ts" : "./worker.js", import.meta.url),
    execArgv: isTs ? ["--import", "tsx"] : [],
  };
}

// Node reports a worker killed for exceeding resourceLimits (e.g.
// maxOldGenerationSizeMb) as an "error" event carrying this specific code —
// distinct from a generic thrown/uncaught error in worker code. We must not
// collapse the two into "malformed": a caller acting on lastFailure.reason
// needs to tell "give up, the parser choked on garbage" from "too big, could
// retry with lower limits" (the latter maps to the existing too_large
// reason, same as an oversized archive/page count caught before the OOM).
const WORKER_OOM_ERROR_CODE = "ERR_WORKER_OUT_OF_MEMORY";

function isWorkerOutOfMemoryError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === WORKER_OOM_ERROR_CODE
  );
}

export async function extractText(
  bytes: Uint8Array,
  kind: ExtractKind,
  limits: ExtractLimits,
  opts: ExtractOptions = {},
  // pptx-only, per-enrollment (default on): whether to include speaker
  // notes in the extracted text. Kept as its own trailing parameter rather
  // than a field on `opts` — `opts` is the main-thread-only Worker-spawning
  // seam (workerUrl/execArgv, never sent to the worker), while this really
  // is request data and must reach the worker via ExtractRequest below.
  includeSpeakerNotes = true,
): Promise<Result<ExtractResult, ExtractError>> {
  const target = defaultWorkerTarget();
  const workerUrl = opts.workerUrl ?? target.url;
  const execArgv = opts.execArgv ?? target.execArgv;
  const request: ExtractRequest = { bytes, kind, limits, includeSpeakerNotes };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: Result<ExtractResult, ExtractError>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      // Fire-and-forget: terminate regardless of how we settled, so a
      // worker that already responded (or errored) doesn't linger.
      void worker.terminate();
    };

    const worker = new Worker(workerUrl, {
      workerData: request,
      execArgv,
      resourceLimits: {
        maxOldGenerationSizeMb: limits.workerHeapMb,
        maxYoungGenerationSizeMb: Math.max(16, Math.floor(limits.workerHeapMb / 4)),
      },
    });

    const timer = setTimeout(() => {
      settle(err({ reason: "timeout", message: `extraction exceeded ${limits.wallClockMs}ms` }));
    }, limits.wallClockMs);
    timer.unref?.();

    worker.once("message", (msg: unknown) => {
      if (!isExtractWorkerResponse(msg)) {
        settle(
          err({ reason: "malformed", message: "worker returned an unrecognized message shape" }),
        );
        return;
      }
      settle(msg.ok ? ok(msg.value) : err(msg.error));
    });

    worker.once("error", (e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      settle(
        isWorkerOutOfMemoryError(e)
          ? err({ reason: "too_large", message })
          : err({ reason: "malformed", message }),
      );
    });

    // Node emits "error" (with the OOM code above) before "exit" when a
    // resourceLimits kill happens, so that branch is already handled by the
    // handler above by the time this fires. A non-zero exit reaching here
    // without a preceding error is some other abnormal termination we can't
    // attribute to a specific cause, so it stays "malformed".
    worker.once("exit", (code: number) => {
      settle(
        err({ reason: "malformed", message: `worker exited with code ${code} before responding` }),
      );
    });
  });
}

export type {
  ExtractError,
  ExtractKind,
  ExtractLimits,
  ExtractReason,
  ExtractResult,
} from "./types.js";
export {
  DEFAULT_EXTRACT_LIMITS,
  EXTRACT_KINDS,
  EXTRACT_REASONS,
  isExtractKind,
  isExtractReason,
} from "./types.js";
