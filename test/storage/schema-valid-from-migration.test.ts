// Regression: an index built before the valid-time columns landed must still
// open after upgrading.
//
// #305 added valid_from/valid_until to the `documents` DDL and to the upsert,
// but left SCHEMA_VERSION at "10" — the value #303 had already introduced.
// `CREATE TABLE IF NOT EXISTS` does not alter an existing table, so a database
// written by any commit between the two stored version 10 WITHOUT the columns,
// matched on the version check, skipped the rebuild, and then failed its first
// upsert with `no such column: valid_from`.
//
// This cannot be caught by a fresh-checkout CI run: `.daftari/index.db` is
// gitignored, so every CI run builds the index from scratch and never reaches
// the upgrade path. The test therefore constructs the stale state explicitly.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { indexDbPath, openIndexDb } from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

let vault: string;

beforeEach(async () => {
  vault = await makeTempVault();
});

afterEach(async () => {
  await cleanupVault(vault);
});

function columns(path: string, table: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
  } finally {
    db.close();
  }
}

// The `documents` table exactly as it stood before #305, plus the meta row
// recording the version that shipped with it.
function writePreValidityIndex(path: string, storedVersion: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      path          TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      collection    TEXT NOT NULL,
      domain        TEXT,
      status        TEXT,
      confidence    TEXT,
      updated       TEXT,
      tags          TEXT,
      content       TEXT NOT NULL,
      tokens        INTEGER NOT NULL,
      ttl_days      INTEGER,
      created       TEXT,
      superseded_by TEXT
    );`);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      storedVersion,
    );
  } finally {
    db.close();
  }
}

describe("upgrading an index built before the valid-time columns", () => {
  it("opens a version-10 database that predates valid_from", () => {
    const path = indexDbPath(vault);
    writePreValidityIndex(path, "10");
    expect(columns(path, "documents")).not.toContain("valid_from");

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    // Before the bump to "11" this returned `no such column: valid_from` on the
    // first write, leaving the vault unable to serve.
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.value.close();
  });

  it("gives that database the valid-time columns", () => {
    const path = indexDbPath(vault);
    writePreValidityIndex(path, "10");

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.value.close();

    const cols = columns(path, "documents");
    expect(cols).toContain("valid_from");
    expect(cols).toContain("valid_until");
  });

  it("clears the freshness manifest so the next reindex repopulates them", () => {
    const path = indexDbPath(vault);
    writePreValidityIndex(path, "10");
    const seed = new Database(path);
    seed
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run("vault_manifest", '{"stale":"entry"}');
    seed.close();

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.value.close();

    const db = new Database(path, { readonly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("vault_manifest") as
      | { value: string }
      | undefined;
    db.close();
    // A surviving manifest would mean the rebuilt tables stay empty until
    // something else invalidates it — the columns would exist but hold nothing.
    expect(row).toBeUndefined();
  });

  it("records the new version so the rebuild happens once, not on every open", () => {
    const path = indexDbPath(vault);
    writePreValidityIndex(path, "10");

    const first = openIndexDb(vault, LOCAL_MINILM_DIM);
    expect(first.ok).toBe(true);
    if (first.ok) first.value.close();

    const db = new Database(path, { readonly: true });
    const version = (
      db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version") as
        | { value: string }
        | undefined
    )?.value;
    db.close();
    expect(version).not.toBe("10");
  });
});
