// `daftari sync` (#6): push the canonical local vault to its configured
// storage backing, or restore a vault from the backing into an empty
// directory. The backing is configured in .daftari/config.yaml (`storage`
// block); credentials come from the SDKs' standard environment chains.

import { parseFlag } from "../index.js";
import { reindexVault, reindexWarnings } from "../search/reindex.js";
import { createBackend } from "../storage/backend.js";
import { restoreVault, syncVault } from "../storage/sync.js";
import { loadConfig } from "../utils/config.js";

const USAGE = `daftari sync — push a vault to its storage backing, or restore from it.

Usage:
  daftari sync --vault <path> [--dry-run]     Push the working copy to the backing
  daftari sync --vault <path> --restore       Restore into an EMPTY directory, then reindex

The backing is the \`storage\` block in .daftari/config.yaml (backends: fs,
s3 — including MinIO/R2/GCS-interop endpoints — and azure). The local git
working copy is canonical; the backing is durable backing, not a second
source of truth. The SQLite index and lock files are never synced. A restore
has no local config to read yet, so the backing is named with flags using
the config block's names (--backend s3 --bucket team-vault [--prefix …]).

Push reads the live tree without stopping a running server; a write racing
the walk is repaired by the next sync.

Exit codes: 2 config/usage error, 3 runtime error.
`;

export async function runSync(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  const vault = parseFlag(argv, "vault");
  if (!vault) {
    process.stderr.write("daftari sync: --vault <path> is required\n\n");
    process.stderr.write(USAGE);
    return 2;
  }
  const restore = argv.includes("--restore");
  const dryRun = argv.includes("--dry-run");
  if (restore && dryRun) {
    process.stderr.write("daftari sync: --restore and --dry-run cannot be combined\n");
    return 2;
  }

  if (restore) {
    return runRestore(vault, argv);
  }

  const config = loadConfig(vault);
  if (!config.ok) {
    process.stderr.write(`daftari sync: ${config.error.message}\n`);
    return 2;
  }
  if (!config.value.storage) {
    process.stderr.write(
      "daftari sync: no storage backing configured — add a `storage` block " +
        "to .daftari/config.yaml (see README: Storage backing)\n",
    );
    return 2;
  }

  const backend = await createBackend(config.value.storage);
  if (!backend.ok) {
    process.stderr.write(`daftari sync: ${backend.error.message}\n`);
    return 2;
  }

  const result = await syncVault(vault, backend.value, { dryRun });
  if (!result.ok) {
    process.stderr.write(`daftari sync: ${result.error.message}\n`);
    return 3;
  }
  const s = result.value;
  process.stdout.write(
    `${dryRun ? "[dry-run] would push" : "pushed"} to ${backend.value.id}: ` +
      `${s.uploaded} uploaded (${s.bytesUploaded} bytes), ${s.deleted} deleted, ` +
      `${s.unchanged} unchanged` +
      (s.skippedSymlinks > 0 ? `, ${s.skippedSymlinks} symlink(s) skipped` : "") +
      "\n",
  );
  return 0;
}

// Restore cannot read the vault's config (the vault does not exist yet), so
// the backing is described on the command line with the same names as the
// config block.
async function runRestore(vault: string, argv: string[]): Promise<number> {
  const backendName = parseFlag(argv, "backend");
  if (!backendName || !["fs", "s3", "azure"].includes(backendName)) {
    process.stderr.write(
      "daftari sync --restore: --backend <fs|s3|azure> is required " +
        "(plus its target flag: --path, --bucket, or --container)\n",
    );
    return 2;
  }
  const storage = {
    backend: backendName as "fs" | "s3" | "azure",
    path: parseFlag(argv, "path") ?? undefined,
    bucket: parseFlag(argv, "bucket") ?? undefined,
    container: parseFlag(argv, "container") ?? undefined,
    prefix: parseFlag(argv, "prefix") ?? undefined,
    region: parseFlag(argv, "region") ?? undefined,
    endpoint: parseFlag(argv, "endpoint") ?? undefined,
    forcePathStyle: argv.includes("--force-path-style") ? true : undefined,
  };
  const required = { fs: "path", s3: "bucket", azure: "container" }[storage.backend] as
    | "path"
    | "bucket"
    | "container";
  if (!storage[required]) {
    process.stderr.write(
      `daftari sync --restore: --${required} is required for ${storage.backend}\n`,
    );
    return 2;
  }

  const backend = await createBackend(storage);
  if (!backend.ok) {
    process.stderr.write(`daftari sync: ${backend.error.message}\n`);
    return 2;
  }

  const restored = await restoreVault(vault, backend.value);
  if (!restored.ok) {
    process.stderr.write(`daftari sync: ${restored.error.message}\n`);
    return 3;
  }
  process.stdout.write(
    `restored ${restored.value.restored} files (${restored.value.bytes} bytes) ` +
      `from ${backend.value.id} into ${vault}\n`,
  );
  if (restored.value.skippedExcluded > 0) {
    process.stderr.write(
      `daftari sync: warning: ${restored.value.skippedExcluded} manifest entr(ies) refused by ` +
        "the exclusion rules (git config/hooks or rebuildable state) — the backing was " +
        "written by something other than daftari sync\n",
    );
  }
  process.stderr.write(
    "daftari sync: note: git config and hooks are never synced or restored " +
      "(git executes them; a backup channel must not deliver code) — re-add " +
      "remotes and local git config by hand\n",
  );

  // The index was deliberately never synced — rebuild it so the restored
  // vault is immediately servable.
  const indexed = await reindexVault(vault);
  if (indexed.ok) {
    process.stdout.write(`reindexed ${indexed.value.documentCount} docs\n`);
    for (const line of reindexWarnings(indexed.value)) {
      process.stderr.write(`daftari sync: warning: ${line}\n`);
    }
  } else {
    process.stderr.write(
      `daftari sync: warning: reindex after restore failed: ${indexed.error.message}\n` +
        "  run `daftari --vault <path> --reindex` before serving\n",
    );
  }
  return 0;
}
