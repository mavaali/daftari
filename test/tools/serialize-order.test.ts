import { describe, expect, it } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";
import type { Frontmatter } from "../../src/frontmatter/types.js";
import { applyExtensionDefaults, serializeDocument } from "../../src/tools/write.js";
import type { SchemaExtension } from "../../src/utils/config.js";

// A complete, valid built-in frontmatter block.
function fm(): Frontmatter {
  return {
    title: "ADR — Adopt SQLite",
    domain: "accumulation",
    collection: "decisions",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    updated: "2026-05-01",
    updated_by: "agent:claude-code",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: [],
    questions_answered: [],
    questions_raised: [],
  };
}

const ext = (over: Partial<SchemaExtension> & Pick<SchemaExtension, "field" | "type">) => ({
  required: false,
  ...over,
});

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

// Top-level YAML keys of the frontmatter block, in document order.
function frontmatterKeys(text: string): string[] {
  const block = text.split("---")[1] ?? "";
  return block
    .split("\n")
    .map((line) => /^([A-Za-z0-9_]+):/.exec(line)?.[1])
    .filter((k): k is string => k !== undefined);
}

describe("serializeDocument — extension ordering", () => {
  it("writes built-in fields first, then extensions in declaration order", () => {
    const extensions: SchemaExtension[] = [
      ext({ field: "adr_id", type: "string" }),
      ext({ field: "decision_date", type: "date" }),
      ext({ field: "stakeholders", type: "array", items: "string" }),
    ];
    const raw = {
      adr_id: "ADR-007",
      decision_date: "2026-04-10",
      stakeholders: ["platform", "data"],
    };
    const text = serializeDocument(fm(), "# Body\n", extensions, raw);
    expect(frontmatterKeys(text)).toEqual([
      ...BUILTIN_KEYS,
      "adr_id",
      "decision_date",
      "stakeholders",
    ]);
  });

  it("ignores the key order of the raw input — declaration order wins", () => {
    const extensions: SchemaExtension[] = [
      ext({ field: "adr_id", type: "string" }),
      ext({ field: "severity", type: "enum", enum: ["low", "high"] }),
      ext({ field: "weight", type: "number" }),
    ];
    const forward = { adr_id: "ADR-1", severity: "high", weight: 3 };
    const shuffled = { weight: 3, adr_id: "ADR-1", severity: "high" };
    const a = serializeDocument(fm(), "# Body\n", extensions, forward);
    const b = serializeDocument(fm(), "# Body\n", extensions, shuffled);
    expect(b).toBe(a);
    expect(frontmatterKeys(a).slice(BUILTIN_KEYS.length)).toEqual(["adr_id", "severity", "weight"]);
  });

  it("omits an absent extension field with no default", () => {
    const extensions: SchemaExtension[] = [ext({ field: "adr_id", type: "string" })];
    const text = serializeDocument(fm(), "# Body\n", extensions, {});
    expect(frontmatterKeys(text)).toEqual(BUILTIN_KEYS);
  });

  it("does not inject defaults on its own — only serializes what raw carries", () => {
    const extensions: SchemaExtension[] = [
      ext({ field: "status_tag", type: "string", default: "proposed" }),
    ];
    const text = serializeDocument(fm(), "# Body\n", extensions, {});
    expect(frontmatterKeys(text)).toEqual(BUILTIN_KEYS);
  });

  it("serializes defaults once they are supplied via applyExtensionDefaults", () => {
    const extensions: SchemaExtension[] = [
      ext({
        field: "status_tag",
        type: "enum",
        enum: ["proposed", "accepted"],
        default: "proposed",
      }),
      ext({ field: "ttl_override", type: "number", default: 30 }),
    ];
    const raw = applyExtensionDefaults({}, extensions);
    const text = serializeDocument(fm(), "# Body\n", extensions, raw);
    expect(text).toContain("status_tag: proposed");
    expect(text).toContain("ttl_override: 30");
  });

  it("treats a null extension value as absent and omits the key", () => {
    const extensions: SchemaExtension[] = [ext({ field: "adr_id", type: "string" })];
    const text = serializeDocument(fm(), "# Body\n", extensions, { adr_id: null });
    expect(frontmatterKeys(text)).toEqual(BUILTIN_KEYS);
  });

  it("produces output identical to the pre-extension form when none are declared", () => {
    const withDefault = serializeDocument(fm(), "# Body\n");
    const withEmpty = serializeDocument(fm(), "# Body\n", [], { stray: "ignored" });
    expect(withEmpty).toBe(withDefault);
    expect(frontmatterKeys(withDefault)).toEqual(BUILTIN_KEYS);
  });
});

describe("serializeDocument — round-trip preservation", () => {
  const extensions: SchemaExtension[] = [
    ext({ field: "adr_id", type: "string" }),
    ext({ field: "decision_date", type: "date" }),
    ext({ field: "review_count", type: "number" }),
    ext({ field: "is_ratified", type: "boolean" }),
    ext({ field: "stakeholders", type: "array", items: "string" }),
    ext({ field: "severity", type: "enum", enum: ["low", "high"] }),
  ];
  const raw = {
    adr_id: "ADR-042",
    decision_date: "2026-04-10",
    review_count: 4,
    is_ratified: true,
    stakeholders: ["platform", "data", "security"],
    severity: "high",
  };

  it("write → read → write yields byte-identical text for every extension type", () => {
    const text1 = serializeDocument(fm(), "# Decision\n\nBody text.\n", extensions, raw);

    const parsed = parseDocument(text1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const text2 = serializeDocument(
      parsed.value.frontmatter,
      parsed.value.content,
      extensions,
      parsed.value.raw,
    );
    expect(text2).toBe(text1);
  });

  it("preserves each extension value through a parse", () => {
    const text = serializeDocument(fm(), "# Decision\n", extensions, raw);
    const parsed = parseDocument(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.raw.adr_id).toBe("ADR-042");
    expect(parsed.value.raw.review_count).toBe(4);
    expect(parsed.value.raw.is_ratified).toBe(true);
    expect(parsed.value.raw.stakeholders).toEqual(["platform", "data", "security"]);
    expect(parsed.value.raw.severity).toBe("high");
    // A date is serialized as a quoted string, so it round-trips as a string.
    expect(parsed.value.raw.decision_date).toBe("2026-04-10");
  });

  it("normalizes a js-yaml Date back to a YYYY-MM-DD value", () => {
    const text = serializeDocument(
      fm(),
      "# Body\n",
      [ext({ field: "decision_date", type: "date" })],
      { decision_date: new Date("2026-04-10T00:00:00.000Z") },
    );
    expect(text).toContain("decision_date: '2026-04-10'");
    expect(text).not.toContain("T00:00:00");
  });
});

describe("applyExtensionDefaults", () => {
  const extensions: SchemaExtension[] = [
    ext({ field: "status_tag", type: "string", default: "proposed" }),
    ext({ field: "adr_id", type: "string" }), // no default
  ];

  it("fills a missing field from its declared default", () => {
    expect(applyExtensionDefaults({}, extensions).status_tag).toBe("proposed");
  });

  it("treats a null value as missing and fills the default", () => {
    expect(applyExtensionDefaults({ status_tag: null }, extensions).status_tag).toBe("proposed");
  });

  it("leaves a present value untouched", () => {
    expect(applyExtensionDefaults({ status_tag: "accepted" }, extensions).status_tag).toBe(
      "accepted",
    );
  });

  it("leaves a missing field with no default absent", () => {
    expect("adr_id" in applyExtensionDefaults({}, extensions)).toBe(false);
  });

  it("does not mutate the input record", () => {
    const input = {};
    applyExtensionDefaults(input, extensions);
    expect(input).toEqual({});
  });
});
