import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

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

export function listFixtureFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(directory, entry.name), path);
      if (entry.isFile()) files.push(path);
    }
  };
  visit(root, "");
  return files.sort();
}
