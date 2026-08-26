import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { walkFiles } from "../../../src/storage/fs-walk.js";

// Deliberately explicit: a regression corpus is the committed inputs, never
// whatever ignored index/read-log state happens to live beside them locally.
export const SAMPLE_VAULT_FILES = [
  ".daftari/config.yaml",
  ".daftari/tensions.md",
  "_drafts/incomplete-note.md",
  "_drafts/moonshot-agentic-etl.md",
  "competitive-intel/aurora-pipelines-vs-helios-connect.md",
  "competitive-intel/cirrus-realtime-early-read.md",
  "competitive-intel/northwind-data-governance.md",
  "competitive-intel/vega-insight-positioning.md",
  "pricing/cirrus-capacity-tiers-2026.md",
  "pricing/cirrus-capacity-tiers.md",
  "pricing/helios-consumption-pricing.md",
  "pricing/serverless-cost-predictability.md",
] as const;

export function copyTrackedSampleVault(source: string, destination: string): void {
  for (const path of SAMPLE_VAULT_FILES) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, path), target);
  }
}

export function listTrackedSampleVaultFiles(repositoryRoot: string): string[] {
  const prefix = "test/fixtures/sample-vault/";
  // This intentional Git dependency proves the frozen manifest still covers
  // every committed corpus input while excluding ignored local vault state.
  let tracked: string;
  try {
    tracked = execFileSync("git", ["ls-files", "--", prefix], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  } catch (cause) {
    throw new Error(
      "sample-vault regression requires a Git checkout to validate its corpus manifest",
      { cause },
    );
  }
  return tracked
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(prefix.length))
    .sort();
}

export function assertTrackedSampleVaultManifest(repositoryRoot: string): void {
  const actual = listTrackedSampleVaultFiles(repositoryRoot);
  const expected = [...SAMPLE_VAULT_FILES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `sample-vault tracked files differ from the frozen regression manifest: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export async function listFixtureFiles(root: string): Promise<string[]> {
  const { files, symlinks } = await walkFiles(root);
  if (symlinks > 0) {
    throw new Error(`sample-vault regression copy contains ${symlinks} symbolic link(s)`);
  }
  return files.map((path) => relative(root, path).split(sep).join("/")).sort();
}
