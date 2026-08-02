// Tests for the autonomous authoring prompt snapshot and EA wiki schema.
//
// These tests verify:
// 1. AUTHORING_SYSTEM_PROMPT retains the key decision-procedure steps from the
//    wiki-maintainer SKILL.md (read schema first, search before writing, supersede
//    against prior, use [[wikilinks]], file tensions and never auto-resolve).
// 2. AUTHORING_SYSTEM_PROMPT does NOT contain the human-only steps that were
//    adapted out for the autonomous bench (user discussion, approval gate, python
//    usage-log script).
// 3. PROVENANCE correctly identifies the canonical SKILL source (repo, path, sha).
// 4. EA_WIKI_MD is a non-empty, self-contained WIKI.md body listing all five EA
//    page types (topics, decisions, entities, tasks, tensions).

import { describe, it, expect } from "vitest";
import { AUTHORING_SYSTEM_PROMPT, PROVENANCE } from "./authoring-prompt.js";
import { EA_WIKI_MD } from "./wiki-schema.js";

describe("AUTHORING_SYSTEM_PROMPT — kept decision-procedure steps", () => {
  it("is non-empty", () => {
    expect(AUTHORING_SYSTEM_PROMPT.trim().length).toBeGreaterThan(0);
  });

  it("instructs the agent to read the schema / WIKI.md first", () => {
    expect(AUTHORING_SYSTEM_PROMPT).toMatch(/wiki\.md/i);
  });

  it("instructs the agent to search before writing", () => {
    expect(AUTHORING_SYSTEM_PROMPT).toMatch(/search/i);
  });

  it("instructs the agent to supersede against prior material", () => {
    expect(AUTHORING_SYSTEM_PROMPT).toMatch(/supersede/i);
  });

  it("instructs the agent to use [[wikilinks]]", () => {
    expect(AUTHORING_SYSTEM_PROMPT).toMatch(/\[\[/);
  });

  it("instructs the agent that tensions are never auto-resolved", () => {
    expect(AUTHORING_SYSTEM_PROMPT).toMatch(/never/i);
  });
});

describe("AUTHORING_SYSTEM_PROMPT — adapted-out human-only steps absent", () => {
  it("does not reference the approval / approve gate", () => {
    expect(AUTHORING_SYSTEM_PROMPT).not.toMatch(/approval|approve/i);
  });

  it("does not instruct the agent to ask the user or discuss with the user", () => {
    expect(AUTHORING_SYSTEM_PROMPT).not.toMatch(/ask the user|discuss with (the|you)/i);
  });

  it("does not reference the python usage-log script", () => {
    expect(AUTHORING_SYSTEM_PROMPT).not.toMatch(/usage[._-]?log|python/i);
  });
});

describe("PROVENANCE", () => {
  it("repo is claude-home-base", () => {
    expect(PROVENANCE.repo).toBe("claude-home-base");
  });

  it("sha is a 40-character hex string", () => {
    expect(PROVENANCE.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("path ends with SKILL.md", () => {
    expect(PROVENANCE.path.endsWith("SKILL.md")).toBe(true);
  });
});

describe("EA_WIKI_MD", () => {
  it("is non-empty", () => {
    expect(EA_WIKI_MD.trim().length).toBeGreaterThan(0);
  });

  it("lists the topics/ page type", () => {
    expect(EA_WIKI_MD).toMatch(/topics\//i);
  });

  it("lists the decisions/ page type", () => {
    expect(EA_WIKI_MD).toMatch(/decisions\//i);
  });

  it("lists the entities/ page type", () => {
    expect(EA_WIKI_MD).toMatch(/entities\//i);
  });

  it("lists the tasks/ page type", () => {
    expect(EA_WIKI_MD).toMatch(/tasks\//i);
  });

  it("lists the tensions/ page type", () => {
    expect(EA_WIKI_MD).toMatch(/tensions\//i);
  });
});
