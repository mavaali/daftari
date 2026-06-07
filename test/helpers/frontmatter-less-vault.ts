// Test helper: build a small frontmatter-less wiki with real git history.
//
// `daftari backfill` derives `created` / `updated` / `updated_by` from git, so
// the fixture has to be a real repo with controlled commit dates and authors —
// a static checked-in fixture can't carry those. Each doc is committed with an
// explicit author and committer date (GIT_AUTHOR_DATE / GIT_COMMITTER_DATE),
// so the derived dates are deterministic.
//
// Layout (collection = first path component):
//   specs/data-movement/foo.md  no frontmatter, H1 + question sections, 2 commits
//   specs/data-movement/bar.md  no frontmatter, no H1 (title from filename)
//   specs/pricing/baz.md        partial frontmatter (title + created present)
//   guides/setup.md             fully conformant frontmatter (skipped)
//   notes/orphan.md             no frontmatter, author absent from identity_map
//   readme.md                   root-level, no folder (rootSkipped)

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface Commit {
  date: string; // YYYY-MM-DD
  author: string; // git author name (%aN)
  content: string;
}

interface DocSpec {
  path: string;
  commits: Commit[];
}

const FOO_V1 = `# Foo: Data Movement Overview

An intro paragraph before any sections.

## Questions Answered
- How does data move from A to B?

## Questions Raised
- Does it scale to 1M events/sec?
`;

const FOO_V2 = `${FOO_V1}\nA later edit adds a closing line.\n`;

const BAR = `Just a body with no heading at the top.

Some paragraph of content.
`;

const BAZ_PARTIAL = `---
title: "Existing Baz Title"
created: 2024-12-01
---

# Baz body heading

Pricing content.
`;

const SETUP_CONFORMANT = `---
title: "Setup Guide"
domain: accumulation
collection: guides
status: canonical
confidence: high
created: 2025-01-05
updated: 2025-01-05
updated_by: human:mihir
provenance: direct
---

# Setup Guide

Already fully described.
`;

const ORPHAN = `# Orphan Note

Authored by someone not in the identity map.
`;

const README_ROOT = `# Readme

A top-level document with no collection folder.
`;

const CONFIG_YAML = `backfill:
  identity_map:
    "Mihir Wagle": human:mihir
    "Priya Patel": human:priya
`;

const DOCS: DocSpec[] = [
  {
    path: "specs/data-movement/foo.md",
    commits: [
      { date: "2025-04-12", author: "Mihir Wagle", content: FOO_V1 },
      { date: "2025-05-01", author: "Mihir Wagle", content: FOO_V2 },
    ],
  },
  {
    path: "specs/data-movement/bar.md",
    commits: [{ date: "2025-03-02", author: "Priya Patel", content: BAR }],
  },
  {
    path: "specs/pricing/baz.md",
    commits: [{ date: "2025-02-10", author: "Mihir Wagle", content: BAZ_PARTIAL }],
  },
  {
    path: "guides/setup.md",
    commits: [{ date: "2025-01-05", author: "Mihir Wagle", content: SETUP_CONFORMANT }],
  },
  {
    path: "notes/orphan.md",
    commits: [{ date: "2025-06-01", author: "Sam Rivers", content: ORPHAN }],
  },
  {
    path: "readme.md",
    commits: [{ date: "2025-01-01", author: "Mihir Wagle", content: README_ROOT }],
  },
];

function authorEmail(author: string): string {
  return `${author.toLowerCase().replace(/\s+/g, ".")}@example.test`;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ...env },
  });
}

// Builds the fixture in a fresh temp directory and returns its path. The caller
// owns cleanup via cleanupVault().
export function buildFrontmatterLessVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-backfill-"));

  git(dir, ["init", "--quiet"]);
  git(dir, ["config", "user.name", "Fixture Bot"]);
  git(dir, ["config", "user.email", "fixture@example.test"]);

  mkdirSync(join(dir, ".daftari"), { recursive: true });
  writeFileSync(join(dir, ".daftari", "config.yaml"), CONFIG_YAML);

  for (const doc of DOCS) {
    const abs = join(dir, doc.path);
    mkdirSync(dirname(abs), { recursive: true });
    for (const c of doc.commits) {
      writeFileSync(abs, c.content);
      git(dir, ["add", "--", doc.path]);
      const stamp = `${c.date}T12:00:00`;
      git(
        dir,
        [
          "-c",
          `user.name=${c.author}`,
          "-c",
          `user.email=${authorEmail(c.author)}`,
          "commit",
          `--author=${c.author} <${authorEmail(c.author)}>`,
          "-m",
          `add ${doc.path}`,
        ],
        { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
      );
    }
  }

  return dir;
}

export function cleanupVault(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
