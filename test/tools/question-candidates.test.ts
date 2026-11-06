// #647: vault_question_candidates. The fake provider drives the tool's shape,
// visibility, and paging; the local-minilm block at the bottom pins the issue's
// acceptance against real embeddings, because "closest in meaning" is a claim
// about the model and a fake cannot falsify it.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { resolveAccess } from "../../src/access/rbac.js";
import { resetDocumentCache } from "../../src/curation/vault-docs.js";
import { err, ok } from "../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../src/search/embedding-provider.js";
import { resetProviderForTests, setProviderForTests } from "../../src/search/vector.js";
import {
  __resetQuestionEmbeddingMemo,
  questionCandidatesTools,
  vaultQuestionCandidates,
} from "../../src/tools/question-candidates.js";
import { loadConfig } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

interface DocSpec {
  title?: string;
  status?: string;
  created?: string;
  updated?: string;
  raised?: string[];
  answered?: string[];
}

function writeDoc(vault: string, relPath: string, spec: DocSpec): void {
  const abs = join(vault, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  const list = (items: string[] = []): string =>
    items.length === 0 ? "[]" : `\n${items.map((q) => `  - ${JSON.stringify(q)}`).join("\n")}`;
  writeFileSync(
    abs,
    `---
title: ${JSON.stringify(spec.title ?? relPath)}
domain: accumulation
collection: ${relPath.split("/")[0]}
status: ${spec.status ?? "draft"}
confidence: medium
created: ${spec.created ?? "2026-06-01"}
updated: ${spec.updated ?? "2026-06-01"}
updated_by: agent:seed
provenance: direct
sources: []
superseded_by: null
ttl_days: 90
tags: []
questions_answered: ${list(spec.answered)}
questions_raised: ${list(spec.raised)}
---

Body.
`,
    "utf-8",
  );
}

// Empties the sample vault's questions so each test owns its corpus.
function freshVault(): string {
  const vault = makeTempVault();
  for (const dir of ["pricing", "competitive-intel", "_drafts"]) {
    rmSync(join(vault, dir), { recursive: true, force: true });
  }
  return vault;
}

let calls: string[][] = [];

function markerProvider(): EmbeddingProvider {
  return {
    id: "fake-question-markers",
    dim: 2,
    warm: async () => ok(undefined),
    embed: async (texts) => {
      calls.push(texts);
      return ok(
        texts.map((t) => {
          const v = new Float32Array(2);
          v[/seat|pricing/i.test(t) ? 0 : 1] = 1;
          return v;
        }),
      );
    },
  };
}

describe("vault_question_candidates", () => {
  let vault: string;

  beforeEach(() => {
    vault = freshVault();
    calls = [];
    resetDocumentCache();
    __resetQuestionEmbeddingMemo();
    setProviderForTests(markerProvider());
  });

  afterEach(() => {
    resetProviderForTests();
    resetDocumentCache();
    cleanupVault(vault);
  });

  it("is read-only and never writes the candidate into questions_answered", async () => {
    const tool = questionCandidatesTools.find((t) => t.name === "vault_question_candidates");
    expect(tool?.annotations?.readOnlyHint).toBe(true);

    writeDoc(vault, "pricing/raiser.md", {
      created: "2026-06-01",
      raised: ["How do we bill per seat?"],
    });
    writeDoc(vault, "pricing/ruling.md", {
      updated: "2026-07-01",
      answered: ["What is the seat pricing rule?"],
    });
    const result = await vaultQuestionCandidates(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    expect(result.value.vectorUsed).toBe(true);
    expect(result.value.questions[0]).toMatchObject({
      question: "How do we bill per seat?",
      raisedBy: ["pricing/raiser.md"],
    });
    expect(result.value.questions[0]?.candidates[0]).toMatchObject({
      path: "pricing/ruling.md",
      matchedField: "questions_answered",
      matchedText: "What is the seat pricing rule?",
    });

    resetDocumentCache();
    const after = await vaultQuestionCandidates(vault, {});
    expect(after.ok && after.value.total).toBe(1); // still open: advisory only
  });

  it("pages through open questions with limit and offset", async () => {
    writeDoc(vault, "pricing/raiser.md", { raised: ["One?", "Two?", "Three?"] });
    const page = await vaultQuestionCandidates(vault, { limit: 1, offset: 1 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.total).toBe(3);
    expect(page.value.questions.map((q) => q.question)).toEqual(["Two?"]);
  });

  it("narrows to one question or one raising document", async () => {
    writeDoc(vault, "pricing/a.md", { raised: ["Alpha seat?"] });
    writeDoc(vault, "pricing/b.md", { raised: ["Beta seat?"] });

    const byText = await vaultQuestionCandidates(vault, { question: "  ALPHA   seat? " });
    expect(byText.ok && byText.value.questions.map((q) => q.question)).toEqual(["Alpha seat?"]);

    const byPath = await vaultQuestionCandidates(vault, { path: "./pricing/b.md" });
    expect(byPath.ok && byPath.value.questions.map((q) => q.question)).toEqual(["Beta seat?"]);
  });

  it("embeds the corpus once across pages", async () => {
    writeDoc(vault, "pricing/raiser.md", { raised: ["One?", "Two?"] });
    writeDoc(vault, "pricing/other.md", { title: "Seat ruling" });
    await vaultQuestionCandidates(vault, { limit: 1 });
    await vaultQuestionCandidates(vault, { limit: 1, offset: 1 });
    const embedded = calls.flat();
    expect(embedded.filter((t) => t === "Seat ruling")).toHaveLength(1);
  });

  it("degrades to lexical and says so when the provider fails", async () => {
    setProviderForTests({
      ...markerProvider(),
      id: "fake-broken",
      embed: async () => err(new Error("offline")),
    });
    writeDoc(vault, "pricing/raiser.md", { raised: ["What is the Cirrus seat price?"] });
    writeDoc(vault, "pricing/ruling.md", {
      updated: "2026-07-01",
      answered: ["How much is a Cirrus seat?"],
    });
    const result = await vaultQuestionCandidates(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vectorUsed).toBe(false);
    expect(result.value.questions[0]?.candidates[0]?.path).toBe("pricing/ruling.md");
  });

  it.each([
    [{ limit: 0 }, "limit"],
    [{ limit: 51 }, "limit"],
    [{ offset: -1 }, "offset"],
    [{ top: 6 }, "top"],
    [{ question: 3 }, "question"],
    [{ path: 3 }, "path"],
  ])("rejects bad args %j", async (args, field) => {
    const result = await vaultQuestionCandidates(vault, args);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(field);
  });

  describe("under RBAC", () => {
    let analyst: AccessContext;

    beforeEach(() => {
      mkdirSync(join(vault, ".daftari"), { recursive: true });
      writeFileSync(
        join(vault, ".daftari", "config.yaml"),
        `version: 1
vault_name: test-vault
roles:
  analyst:
    read: ["pricing"]
    write: []
  admin:
    read: ["*"]
    write: ["*"]
`,
        "utf-8",
      );
      const config = loadConfig(vault);
      if (!config.ok) throw config.error;
      analyst = resolveAccess(config.value, "human:a", "analyst");
    });

    it("omits unreadable candidates without counting them", async () => {
      writeDoc(vault, "pricing/raiser.md", { raised: ["Seat rule?"] });
      writeDoc(vault, "secret/ruling.md", {
        updated: "2026-07-01",
        answered: ["What is the seat pricing rule?"],
      });
      const result = await vaultQuestionCandidates(vault, {}, analyst);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(JSON.stringify(result.value)).not.toContain("secret");
      expect(result.value.questions[0]?.candidates).toEqual([]);
    });

    it("never shares memoized embeddings across read scopes", async () => {
      writeDoc(vault, "pricing/raiser.md", { raised: ["Seat rule?"] });
      writeDoc(vault, "pricing/other.md", { title: "Seat ruling" });
      const config = loadConfig(vault);
      if (!config.ok) throw config.error;
      const admin = resolveAccess(config.value, "human:m", "admin");

      await vaultQuestionCandidates(vault, {}, admin);
      await vaultQuestionCandidates(vault, {}, analyst);
      await vaultQuestionCandidates(vault, {}, analyst);

      // A hit is faster than a miss, so a memo shared with admin would let the
      // analyst confirm text it cannot read. Once per scope, never across them.
      expect(calls.flat().filter((t) => t === "Seat ruling")).toHaveLength(2);
    });

    it("never surfaces a question raised only in an unreadable document", async () => {
      writeDoc(vault, "secret/raiser.md", { raised: ["Hidden seat question?"] });
      const all = await vaultQuestionCandidates(vault, {}, analyst);
      expect(all.ok && all.value.total).toBe(0);
      const direct = await vaultQuestionCandidates(vault, { path: "secret/raiser.md" }, analyst);
      expect(direct.ok && direct.value.total).toBe(0);
    });
  });
});

// The issue's acceptance, against the real default model: three rewordings
// that share almost no vocabulary with their questions, buried among
// distractors.
describe("vault_question_candidates with local-minilm", () => {
  it("lists the reworded answer among the top three candidates", async () => {
    const vault = freshVault();
    resetDocumentCache();
    __resetQuestionEmbeddingMemo();
    resetProviderForTests();
    try {
      const pairs = [
        ["How much do customers pay per seat?", "What is the per-user subscription price?"],
        ["Who signs off on a production deployment?", "Which person approves releases to prod?"],
        ["Is customer data stored outside the EU?", "Do we keep client records in Europe only?"],
      ] as const;
      pairs.forEach(([raised, answered], i) => {
        writeDoc(vault, `pricing/raiser-${i}.md`, { created: "2026-06-01", raised: [raised] });
        writeDoc(vault, `pricing/ruling-${i}.md`, {
          title: `Ruling ${i}`,
          updated: "2026-07-01",
          answered: [answered],
        });
      });
      const distractors = [
        "Why did the Q3 roadmap slip?",
        "Which vendor hosts our status page?",
        "How often do we rotate on-call?",
        "What font does the brand guide require?",
        "When does the office lease end?",
        "Which regions does support cover overnight?",
      ];
      distractors.forEach((q, i) => {
        writeDoc(vault, `pricing/other-${i}.md`, {
          title: `Note ${i}`,
          updated: "2026-07-01",
          answered: [q],
        });
      });

      const result = await vaultQuestionCandidates(vault, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.vectorUsed).toBe(true);
      pairs.forEach(([raised], i) => {
        const row = result.value.questions.find((q) => q.question === raised);
        expect(row?.candidates.map((c) => c.path)).toContain(`pricing/ruling-${i}.md`);
      });
    } finally {
      resetProviderForTests();
      resetDocumentCache();
      cleanupVault(vault);
    }
  }, 120_000);
});
