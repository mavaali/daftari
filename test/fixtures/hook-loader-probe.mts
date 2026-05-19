// Probe for the hook loader's hot-reload behavior, run as a child process by
// test/hooks/loader.test.ts. Vitest's module runner caches dynamic import()
// by resolved path and ignores the `?t=<mtime>` cache-busting query the loader
// appends, so the loader's hot-reload can only be observed in a real Node
// process. This script loads a hook, loads it again unchanged, then edits the
// file and loads once more, reporting what it saw as JSON on stdout.

import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHook } from "../../src/hooks/loader.js";

const vault = process.argv[2];
const relPath = process.argv[3];
const v2Source = process.argv[4];
const decl = { path: relPath };
const context = { path: relPath, operation: "create" as const };

async function load() {
  const result = await loadHook(vault, decl);
  if (!result.ok) {
    throw result.error;
  }
  return result.value.hook;
}

const first = await load();
const firstAgain = await load();
const message1 = first({}, context)[0].message;
const stableRef = first === firstAgain;

writeFileSync(join(vault, relPath), v2Source);
// Bump mtime forward so the loader sees a changed file even on filesystems
// with whole-second mtime resolution.
const future = Date.now() / 1000 + 5;
utimesSync(join(vault, relPath), future, future);

const second = await load();
const message2 = second({}, context)[0].message;

process.stdout.write(JSON.stringify({ message1, message2, stableRef }));
