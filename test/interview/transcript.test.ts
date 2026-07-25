import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";
import type { InterviewQuestion } from "../../src/interview/questions.js";
import {
  type InterviewAnswer,
  renderTranscript,
  transcriptRelPath,
  writeTranscript,
} from "../../src/interview/transcript.js";

const TODAY = new Date().toISOString().slice(0, 10);

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-transcript-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function question(overrides: Partial<InterviewQuestion> = {}): InterviewQuestion {
  return {
    id: "q-001",
    kind: "tension",
    question: 'Two documents disagree (factual): a.md says "X" while b.md says "Y".',
    context: "open tension tension-001 (fresh), logged 2026-07-20",
    refs: ["tension-001", "pricing/a.md", "pricing/b.md"],
    ...overrides,
  };
}

const META = { date: TODAY, by: "human:tester", collection: "interviews" };

describe("renderTranscript", () => {
  it("produces a valid vault document with the testimony posture", () => {
    const answers: InterviewAnswer[] = [
      { question: question(), answer: "Claim X is current; b.md predates the pricing change." },
    ];
    const parsed = parseDocument(renderTranscript(answers, META));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.validation.valid).toBe(true);
    const fm = parsed.value.frontmatter;
    expect(fm.title).toBe(`Interview — ${TODAY}`);
    expect(fm.tier).toBe("source");
    expect(fm.provenance).toBe("direct");
    expect(fm.confidence).toBe("high");
    expect(fm.ttl_days).toBeNull();
    expect(fm.updated_by).toBe("human:tester");
    expect(fm.sources).toEqual(["tension-001", "pricing/a.md", "pricing/b.md"]);
    expect(fm.questions_answered).toEqual([answers[0]?.question.question]);
    expect(parsed.value.content).toContain(
      "**A:** Claim X is current; b.md predates the pricing change.",
    );
  });

  it("dedupes sources across answers and survives quotes in claims", () => {
    const answers: InterviewAnswer[] = [
      { question: question(), answer: "First." },
      {
        question: question({
          id: "q-002",
          kind: "stale",
          question: '"Doc" (pricing/a.md) is 10 days past its 30-day freshness window.',
          refs: ["pricing/a.md"],
        }),
        answer: "Still accurate.",
      },
    ];
    const parsed = parseDocument(renderTranscript(answers, META));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frontmatter.sources).toEqual([
      "tension-001",
      "pricing/a.md",
      "pricing/b.md",
    ]);
    expect(parsed.value.frontmatter.questions_answered).toHaveLength(2);
  });
});

describe("transcriptRelPath", () => {
  it("suffixes when today's transcript already exists", () => {
    expect(transcriptRelPath(vault, "interviews", TODAY)).toBe(`interviews/${TODAY}-interview.md`);
    mkdirSync(join(vault, "interviews"), { recursive: true });
    writeFileSync(join(vault, "interviews", `${TODAY}-interview.md`), "x", "utf-8");
    expect(transcriptRelPath(vault, "interviews", TODAY)).toBe(
      `interviews/${TODAY}-interview-2.md`,
    );
  });
});

describe("writeTranscript", () => {
  it("writes the transcript and auto-commits it", async () => {
    const r = await writeTranscript(vault, [{ question: question(), answer: "X stands." }], META);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.relPath).toBe(`interviews/${TODAY}-interview.md`);
    expect(existsSync(join(vault, r.value.relPath))).toBe(true);
    expect(r.value.commitHash).toBeTruthy();

    const log = execSync("git log --format=%s -1", { cwd: vault, encoding: "utf-8" });
    expect(log).toContain(`Record interview ${TODAY} (1 answer)`);
  });

  it("skips the commit when auto_commit is off", async () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      join(vault, ".daftari", "config.yaml"),
      "version: 1\nauto_commit: false\nroles: {}\n",
      "utf-8",
    );

    const r = await writeTranscript(vault, [{ question: question(), answer: "X stands." }], META);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.commitHash).toBeNull();
    expect(r.value.warning).toBeUndefined();
    expect(existsSync(join(vault, r.value.relPath))).toBe(true);
  });

  it("refuses an empty interview", async () => {
    const r = await writeTranscript(vault, [], META);
    expect(r.ok).toBe(false);
  });

  it("rejects a collection name carrying YAML structure or path traversal", async () => {
    const answers = [{ question: question(), answer: "X stands." }];
    for (const collection of [
      "interviews\ncollection: public-notes", // duplicate-key YAML injection
      "../../outside", // vault escape
      "a/b", // multi-segment
      "team: a", // YAML mapping
      "node_modules", // listFiles hard-ignores it — the vault could never see the doc
      "",
    ]) {
      const r = await writeTranscript(vault, answers, { ...META, collection });
      expect(r.ok, `collection ${JSON.stringify(collection)} must be rejected`).toBe(false);
    }
    expect(existsSync(join(vault, "..", "outside"))).toBe(false);
  });

  it("serializes YAML-significant content in answers and claims safely", async () => {
    const answers = [
      {
        question: question({
          question: 'a.md says "yes: [maybe]" while b.md says "no — {never}".',
        }),
        answer: "colon: dash - brace } quote \" tick ' hash # done",
      },
    ];
    const parsed = parseDocument(renderTranscript(answers, META));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.validation.valid).toBe(true);
    expect(parsed.value.frontmatter.collection).toBe("interviews");
    expect(parsed.value.frontmatter.questions_answered).toEqual([answers[0]?.question.question]);
  });
});
