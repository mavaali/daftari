import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "../src/frontmatter/parser.js";
import type { Frontmatter } from "../src/frontmatter/types.js";
import { vaultRead } from "../src/tools/read.js";
import { serializeDocument, vaultWrite } from "../src/tools/write.js";
import { cleanupVault, makeTempVault } from "./helpers/temp-vault.js";

// Schema extensions are additive: a vault with no `schema_extensions` block
// must behave exactly as it did before the feature existed. These tests pin
// that contract by comparing serialized bytes.

const AGENT = "agent:claude-code";

const BUILTIN_KEYS = [
  "title",
  "domain",
  "collection",
  "status",
  "confidence",
  "created",
  "updated",
  "updated_by",
  "provenance",
  "sources",
  "superseded_by",
  "ttl_days",
  "tags",
  "questions_answered",
  "questions_raised",
];

function frontmatterKeys(text: string): string[] {
  const block = text.split("---")[1] ?? "";
  return block
    .split("\n")
    .map((line) => /^([A-Za-z0-9_]+):/.exec(line)?.[1])
    .filter((k): k is string => k !== undefined);
}

function fm(): Frontmatter {
  return {
    title: "Serverless Cost Notes",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    updated: "2026-05-01",
    updated_by: "agent:seed",
    provenance: "direct",
    sources: ["a-source"],
    superseded_by: null,
    ttl_days: 90,
    tags: ["pricing"],
    questions_answered: [],
    questions_raised: ["Is spend predictable?"],
  };
}

describe("back-compat — no schema_extensions block", () => {
  describe("serializeDocument", () => {
    it("the extensions/raw arguments default to a no-op", () => {
      const twoArg = serializeDocument(fm(), "# Body\n");
      const fourArgEmpty = serializeDocument(fm(), "# Body\n", [], {});
      expect(fourArgEmpty).toBe(twoArg);
    });

    it("preserves undeclared raw frontmatter even when no extensions are declared (#113)", () => {
      // A vault with no schema_extensions block still round-trips any custom
      // fields a document carries — writes are non-destructive. The undeclared
      // keys follow the built-ins, in raw insertion order, untyped.
      const text = serializeDocument(fm(), "# Body\n", [], {
        adr_id: "ADR-1",
        anything: ["leaked"],
      });
      expect(frontmatterKeys(text)).toEqual([...BUILTIN_KEYS, "adr_id", "anything"]);
      expect(text).toContain("adr_id: ADR-1");
    });

    it("round-trips a serialized document byte-for-byte", () => {
      const text1 = serializeDocument(fm(), "# Body\n\nContent.\n");
      const parsed = parseDocument(text1);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const text2 = serializeDocument(parsed.value.frontmatter, parsed.value.content);
      expect(text2).toBe(text1);
    });
  });

  describe("the write path on a vault with no config", () => {
    let vault: string;

    beforeEach(() => {
      vault = makeTempVault();
    });

    afterEach(() => {
      cleanupVault(vault);
    });

    it("writes only built-in frontmatter fields", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/new-note.md",
        body: "# Serverless Cost Notes\n\nBody.\n",
        frontmatter: {
          title: "Serverless Cost Notes",
          domain: "accumulation",
          collection: "pricing",
          status: "draft",
          confidence: "medium",
          created: "2026-05-01",
          updated: "2026-05-01",
          updated_by: "agent:seed",
          provenance: "direct",
          sources: [],
          superseded_by: null,
          ttl_days: 90,
          tags: ["pricing"],
        },
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const read = await vaultRead(vault, "pricing/new-note.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // No extension keys leak into the file; only built-ins are present.
      expect(Object.keys(read.value.raw).sort()).toEqual([...BUILTIN_KEYS].sort());
    }, 60_000);

    it("an existing sample-vault document re-writes with stable frontmatter", async () => {
      const original = await vaultRead(vault, "pricing/helios-consumption-pricing.md");
      expect(original.ok).toBe(true);
      if (!original.ok) return;

      const rewrite = await vaultWrite(vault, {
        path: "pricing/helios-consumption-pricing.md",
        body: original.value.content,
        frontmatter: original.value.raw,
        agent: AGENT,
      });
      expect(rewrite.ok).toBe(true);
      if (!rewrite.ok) return;

      const reread = await vaultRead(vault, "pricing/helios-consumption-pricing.md");
      expect(reread.ok).toBe(true);
      if (!reread.ok) return;
      // The re-written document carries no key beyond the built-in set.
      expect(Object.keys(reread.value.raw).every((k) => BUILTIN_KEYS.includes(k))).toBe(true);
    }, 60_000);
  });
});
