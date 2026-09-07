// Whether this runtime can load a TypeScript (.ts) worker_threads entry via
// tsx (execArgv ["--import", "tsx"]). Node 22 propagates a --import-registered
// module loader to spawned workers; Node 20 does not, so a .ts worker entry
// fails to resolve there with ERR_UNKNOWN_FILE_EXTENSION. This affects the
// dev/test path ONLY — the published package ships compiled .js workers
// (execArgv []), which load on every supported Node version. Tests that spawn
// the real worker gate on this so the CI Node 20 matrix leg stays green; the
// same tests still exercise the worker end-to-end on Node 22.
export const canRunTsWorkers = Number(process.versions.node.split(".")[0]) >= 22;
