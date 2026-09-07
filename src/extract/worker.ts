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

// A static `import "./office.js"` here resolves fine when this worker runs
// compiled (dist/extract/worker.js importing the real dist/extract/office.js
// — plain Node ESM resolution, no loader involved). But in dev/test, this
// file is loaded as a worker_threads entry with execArgv ["--import","tsx"]
// (see index.ts's defaultWorkerTarget), and tsx's resolve hook — which maps
// a ".js" specifier to its sibling ".ts" source just fine for a normal
// import — does not reliably do that remapping for a *value* import
// resolved from inside a worker thread. The worker entry URL itself always
// resolves (it's passed to `new Worker()` with its real, exact extension
// already), so mirror that exact-extension trick for this one nested
// import: build the sibling module's URL with the same extension as this
// file, then dynamically import that exact URL — no extension remapping
// needed either way.
const isTs = import.meta.url.endsWith(".ts");
const officeUrl = new URL(isTs ? "./office.ts" : "./office.js", import.meta.url);
const { handleDocx, handlePptx } = (await import(officeUrl.href)) as typeof import("./office.js");

// pdf.ts (U9) is the same kind of new local sibling module as office.ts, so
// it hits the identical gotcha — mirror the exact-extension dynamic-import
// pattern above rather than a plain static `import "./pdf.js"`, which would
// break resolving to ./pdf.ts under dev/test's tsx-in-worker execArgv.
const pdfUrl = new URL(isTs ? "./pdf.ts" : "./pdf.js", import.meta.url);
const { handlePdf } = (await import(pdfUrl.href)) as typeof import("./pdf.js");

const dispatch: Record<ExtractRequest["kind"], Handler> = {
  docx: handleDocx,
  pptx: handlePptx,
  pdf: handlePdf,
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
