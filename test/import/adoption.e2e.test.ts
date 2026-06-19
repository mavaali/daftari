// End-to-end test for `daftari import obsidian` (the adoption flow).
//
// Builds a real temp git vault shaped like an adopted Obsidian vault — a Web
// Clipper clip, a doc with a wikilink, and Obsidian dotdirs (.obsidian, .trash)
// — then exercises the exact plan→apply calls the CLI path makes
// (`generatePlan(..., { obsidian: true })` then `applyPlan(...)`) and asserts
// the adoption behaviors end to end: clip round-trip, wikilinks untouched,
// idempotence, and dotdir exclusion.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPlan } from "../../src/backfill/apply.js";
import { generatePlan } from "../../src/backfill/plan.js";
import { parseDocument } from "../../src/frontmatter/parser.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

// A clip captured by Obsidian Web Clipper: singular `source`, custom author /
// published fields, a `clippings` tag, and an inline #idea in the body.
const CLIP = `---
source: https://example.com/post
author: Jane
published: 2026-01-01
tags: [clippings]
---

# A Clipped Post

Some captured text with an inline #idea worth keeping.
`;

// A note whose body links to another via an Obsidian wikilink.
const LINKING = `---
---

# Linking Note

For background see [[Other Note]].
`;

// The wikilink target — present so the link is "real", though the test only
// checks that the literal wikilink text survives apply (no conversion).
const OTHER = `# Other Note

The target of the wikilink.
`;

// Markdown living under Obsidian control dirs — must never enter the plan.
const TRASHED = `# Deleted

This was moved to the Obsidian trash.
`;
const OBSIDIAN_INTERNAL = `# Obsidian internal

A markdown file Obsidian keeps in its config dir.
`;

interface Doc {
  path: string;
  content: string;
}

const DOCS: Doc[] = [
  { path: "notes/clip.md", content: CLIP },
  { path: "notes/linking.md", content: LINKING },
  { path: "notes/other-note.md", content: OTHER },
  { path: ".trash/deleted.md", content: TRASHED },
  { path: ".obsidian/whatever.md", content: OBSIDIAN_INTERNAL },
];

function buildObsidianVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-adoption-"));
  git(dir, ["init", "--quiet"]);
  git(dir, ["config", "user.name", "Fixture Bot"]);
  git(dir, ["config", "user.email", "fixture@example.test"]);

  mkdirSync(join(dir, ".daftari"), { recursive: true });
  writeFileSync(join(dir, ".daftari", "config.yaml"), "backfill:\n  identity_map: {}\n");

  for (const doc of DOCS) {
    const abs = join(dir, doc.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, doc.content);
    git(dir, ["add", "--", doc.path]);
  }
  git(dir, ["commit", "--quiet", "-m", "import obsidian vault"]);
  return dir;
}

describe("daftari import obsidian — end-to-end adoption", () => {
  let vault: string;

  beforeEach(() => {
    vault = buildObsidianVault();
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("round-trips a Web Clipper clip: sources, harvested + existing tags, custom + required fields", async () => {
    const plan = await generatePlan(vault, {
      identityMap: {},
      invoker: "human:tester",
      obsidian: true,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const apply = await applyPlan(vault, "notes", "human:tester");
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.value.applied).toContain("notes/clip.md");

    const parsed = parseDocument(readFileSync(join(vault, "notes/clip.md"), "utf-8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fm = parsed.value.frontmatter;
    const raw = parsed.value.raw;

    // Web Clipper `source` → Daftari `sources[]`.
    expect(fm.sources).toContain("https://example.com/post");

    // Inline #idea harvested AND the existing `clippings` tag preserved.
    expect(fm.tags).toContain("clippings");
    expect(fm.tags).toContain("idea");

    // Custom fields survive (raw pass-through). `published` is parsed as a Date
    // by gray-matter; assert presence, not its serialized shape.
    expect(raw.author).toBe("Jane");
    expect(raw.published).toBeDefined();

    // Required Daftari fields are filled and non-empty.
    expect(fm.title).toBeTruthy();
    expect(fm.status).toBeTruthy();
    expect(fm.confidence).toBeTruthy();
    expect(fm.domain).toBeTruthy();
    expect(fm.provenance).toBeTruthy();
  });

  it("leaves wikilinks untouched", async () => {
    const plan = await generatePlan(vault, {
      identityMap: {},
      invoker: "human:tester",
      obsidian: true,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const apply = await applyPlan(vault, "notes", "human:tester");
    expect(apply.ok).toBe(true);

    const text = readFileSync(join(vault, "notes/linking.md"), "utf-8");
    expect(text).toContain("[[Other Note]]");
  });

  it("is idempotent — a second plan finds no work for an already-applied scope", async () => {
    const first = await generatePlan(vault, {
      identityMap: {},
      invoker: "human:tester",
      obsidian: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.entries.some((e) => e.path === "notes/clip.md")).toBe(true);

    const apply = await applyPlan(vault, "notes", "human:tester");
    expect(apply.ok).toBe(true);

    // A fresh plan over the now-conformant scope produces no entry for the
    // applied docs (they validate, so backfill skips them).
    const second = await generatePlan(vault, {
      scope: "notes",
      identityMap: {},
      invoker: "human:tester",
      obsidian: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.entries.some((e) => e.scope === "notes")).toBe(false);
    expect(second.value.summary.planned).toBe(0);
  });

  it("excludes Obsidian dotdirs (.trash, .obsidian) from the plan", async () => {
    const plan = await generatePlan(vault, {
      identityMap: {},
      invoker: "human:tester",
      obsidian: true,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const paths = plan.value.entries.map((e) => e.path);
    expect(paths.some((p) => p.startsWith(".trash/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".obsidian/"))).toBe(false);
  });
});
