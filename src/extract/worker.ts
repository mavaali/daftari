// src/extract/worker.ts
// The worker_threads entry point. Runs inside a bounded worker spawned by
// index.ts; receives an ExtractRequest via workerData and posts back exactly
// one ExtractWorkerResponse.
//
// The dispatch table below is the ONLY thing U7 (docx), U8 (pptx), and U9
// (pdf) need to edit to plug in real extractors: swap a stub entry for a
// real import. No parsing logic belongs in this file.

import { parentPort, workerData } from "node:worker_threads";
import type { ExtractRequest, ExtractWorkerResponse } from "./types.js";

type Handler = (request: ExtractRequest) => Promise<ExtractWorkerResponse>;

async function notYetImplemented(unit: string): Promise<ExtractWorkerResponse> {
  return { ok: false, error: { reason: "unsupported_type", message: `implemented in ${unit}` } };
}

const dispatch: Record<ExtractRequest["kind"], Handler> = {
  docx: () => notYetImplemented("U7"),
  pptx: () => notYetImplemented("U8"),
  pdf: () => notYetImplemented("U9"),
};

async function run(): Promise<ExtractWorkerResponse> {
  const request = workerData as ExtractRequest;
  const handler = dispatch[request.kind];
  if (!handler) {
    return {
      ok: false,
      error: { reason: "unsupported_type", message: `no handler for kind ${String(request.kind)}` },
    };
  }
  return handler(request);
}

run()
  .then((response) => parentPort?.postMessage(response))
  .catch((e: unknown) => {
    const response: ExtractWorkerResponse = {
      ok: false,
      error: { reason: "malformed", message: e instanceof Error ? e.message : String(e) },
    };
    parentPort?.postMessage(response);
  });
