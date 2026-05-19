import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

// Writes a .daftari/config.yaml into a throwaway directory and loads it.
// Returns the loadConfig Result so a test can assert on either branch.
describe("loadConfig — schema extensions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  describe("absent / empty blocks", () => {
    it("yields an empty extension list when no config file exists", () => {
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.schemaExtensions).toEqual([]);
      expect(result.value.roles).toEqual({});
    });

    it("yields an empty extension list when the block is omitted", () => {
      writeConfig("version: 1\nvault_name: v\nroles:\n  admin:\n    read: ['*']\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.schemaExtensions).toEqual([]);
      expect(Object.keys(result.value.roles)).toEqual(["admin"]);
    });

    it("parses schema_extensions even when no roles are declared", () => {
      writeConfig("version: 1\nschema_extensions:\n  adr_id:\n    type: string\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.roles).toEqual({});
      expect(result.value.schemaExtensions).toHaveLength(1);
    });
  });

  describe("auto_commit (issue #22)", () => {
    it("defaults to true when no config file exists", () => {
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.autoCommit).toBe(true);
    });

    it("defaults to true when the key is omitted", () => {
      writeConfig("version: 1\nvault_name: v\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.autoCommit).toBe(true);
    });

    it("parses auto_commit: false", () => {
      writeConfig("version: 1\nvault_name: v\nauto_commit: false\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.autoCommit).toBe(false);
    });

    it("rejects a non-boolean auto_commit value", () => {
      writeConfig("version: 1\nvault_name: v\nauto_commit: nope\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("auto_commit");
    });
  });

  describe("type primitives", () => {
    it("parses every supported extension type", () => {
      writeConfig(
        [
          "schema_extensions:",
          "  note:",
          "    type: string",
          "  decision_date:",
          "    type: date",
          "  weight:",
          "    type: number",
          "  is_final:",
          "    type: boolean",
          "  stakeholders:",
          "    type: array",
          "    items: string",
          "  severity:",
          "    type: enum",
          "    enum: [low, high]",
          "",
        ].join("\n"),
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.schemaExtensions.map((e) => e.type)).toEqual([
        "string",
        "date",
        "number",
        "boolean",
        "array",
        "enum",
      ]);
    });

    it("preserves declaration order", () => {
      writeConfig(
        [
          "schema_extensions:",
          "  zeta:",
          "    type: string",
          "  alpha:",
          "    type: number",
          "  mu:",
          "    type: boolean",
          "",
        ].join("\n"),
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.schemaExtensions.map((e) => e.field)).toEqual(["zeta", "alpha", "mu"]);
    });

    it("defaults 'required' to false and accepts an explicit true", () => {
      writeConfig(
        [
          "schema_extensions:",
          "  a:",
          "    type: string",
          "  b:",
          "    type: string",
          "    required: true",
          "",
        ].join("\n"),
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.schemaExtensions[0]?.required).toBe(false);
      expect(result.value.schemaExtensions[1]?.required).toBe(true);
    });
  });

  describe("attributes", () => {
    it("carries enum values, array items, and a string pattern", () => {
      writeConfig(
        [
          "schema_extensions:",
          "  adr_id:",
          "    type: string",
          '    pattern: "^ADR-[0-9]+$"',
          "  stakeholders:",
          "    type: array",
          "    items: string",
          "  review_state:",
          "    type: enum",
          "    enum: [proposed, accepted]",
          "",
        ].join("\n"),
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [adr, stakeholders, reviewState] = result.value.schemaExtensions;
      expect(adr?.pattern).toBe("^ADR-[0-9]+$");
      expect(stakeholders?.items).toBe("string");
      expect(reviewState?.enum).toEqual(["proposed", "accepted"]);
    });

    it("normalises a date default to a YYYY-MM-DD string", () => {
      writeConfig(
        ["schema_extensions:", "  decided:", "    type: date", "    default: 2026-01-15", ""].join(
          "\n",
        ),
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.schemaExtensions[0]?.default).toBe("2026-01-15");
    });

    it("carries typed defaults for each primitive", () => {
      writeConfig(
        [
          "schema_extensions:",
          "  s:",
          "    type: string",
          "    default: draft",
          "  n:",
          "    type: number",
          "    default: 90",
          "  b:",
          "    type: boolean",
          "    default: false",
          "  a:",
          "    type: array",
          "    items: string",
          "    default: [x, y]",
          "  e:",
          "    type: enum",
          "    enum: [low, high]",
          "    default: low",
          "",
        ].join("\n"),
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const byField = Object.fromEntries(
        result.value.schemaExtensions.map((e) => [e.field, e.default]),
      );
      expect(byField).toEqual({ s: "draft", n: 90, b: false, a: ["x", "y"], e: "low" });
    });
  });

  describe("malformed declarations fail config load", () => {
    const cases: { name: string; yaml: string; contains: string }[] = [
      {
        name: "schema_extensions is not a mapping",
        yaml: "schema_extensions:\n  - a\n  - b\n",
        contains: "'schema_extensions' must be a mapping",
      },
      {
        name: "an entry is not a mapping",
        yaml: "schema_extensions:\n  adr_id: string\n",
        contains: "must be a mapping",
      },
      {
        name: "field name shadows a built-in field",
        yaml: "schema_extensions:\n  status:\n    type: string\n",
        contains: "shadows a built-in frontmatter field",
      },
      {
        name: "unknown extension type",
        yaml: "schema_extensions:\n  f:\n    type: timestamp\n",
        contains: "unknown type",
      },
      {
        name: "missing type",
        yaml: "schema_extensions:\n  f:\n    required: true\n",
        contains: "unknown type",
      },
      {
        name: "enum without values",
        yaml: "schema_extensions:\n  f:\n    type: enum\n",
        contains: "requires a non-empty 'enum' list",
      },
      {
        name: "enum list is empty",
        yaml: "schema_extensions:\n  f:\n    type: enum\n    enum: []\n",
        contains: "requires a non-empty 'enum' list",
      },
      {
        name: "enum values are not strings",
        yaml: "schema_extensions:\n  f:\n    type: enum\n    enum: [1, 2]\n",
        contains: "'enum' values must be strings",
      },
      {
        name: "enum on a non-enum type",
        yaml: "schema_extensions:\n  f:\n    type: string\n    enum: [a, b]\n",
        contains: "'enum' is only valid for type 'enum'",
      },
      {
        name: "array without items",
        yaml: "schema_extensions:\n  f:\n    type: array\n",
        contains: "requires 'items: string'",
      },
      {
        name: "array items is not 'string'",
        yaml: "schema_extensions:\n  f:\n    type: array\n    items: number\n",
        contains: "requires 'items: string'",
      },
      {
        name: "items on a non-array type",
        yaml: "schema_extensions:\n  f:\n    type: string\n    items: string\n",
        contains: "'items' is only valid for type 'array'",
      },
      {
        name: "pattern on a non-string type",
        yaml: "schema_extensions:\n  f:\n    type: number\n    pattern: '^x$'\n",
        contains: "'pattern' is only valid for type 'string'",
      },
      {
        name: "pattern is not a valid regular expression",
        yaml: "schema_extensions:\n  f:\n    type: string\n    pattern: '([unclosed'\n",
        contains: "not a valid regular expression",
      },
      {
        name: "required is not a boolean",
        yaml: "schema_extensions:\n  f:\n    type: string\n    required: yes-please\n",
        contains: "'required' must be true or false",
      },
      {
        name: "default does not match the declared type",
        yaml: "schema_extensions:\n  f:\n    type: number\n    default: not-a-number\n",
        contains: "'default' must be a number",
      },
      {
        name: "string default does not match the declared pattern",
        yaml: 'schema_extensions:\n  f:\n    type: string\n    pattern: "^ADR-"\n    default: nope\n',
        contains: "'default' does not match 'pattern'",
      },
      {
        name: "default is outside the declared enum",
        yaml: "schema_extensions:\n  f:\n    type: enum\n    enum: [a, b]\n    default: c\n",
        contains: "'default' must be one of the declared enum values",
      },
    ];

    for (const { name, yaml, contains } of cases) {
      it(name, () => {
        writeConfig(yaml);
        const result = loadConfig(dir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.message).toContain("malformed config");
        expect(result.error.message).toContain(contains);
      });
    }
  });

  it("still rejects a malformed roles block alongside extensions", () => {
    writeConfig(
      [
        "roles:",
        "  analyst:",
        "    read: competitive-intel",
        "schema_extensions:",
        "  adr_id:",
        "    type: string",
        "",
      ].join("\n"),
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("malformed config");
  });
});
