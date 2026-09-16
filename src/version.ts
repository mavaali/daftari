// Single source of truth for the running daftari version. Read from the
// package manifest so it never drifts from the published version. src/version.ts
// and dist/version.js both sit one level under the package root, so this
// relative path resolves the same in dev and build.
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  version: string;
};

export const DAFTARI_VERSION = manifest.version;
