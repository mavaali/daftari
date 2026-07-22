import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, malformedCommentHint } from "../../src/utils/config.js";

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

  // Whether shadow_mode was EXPLICITLY declared (vs defaulted) — the consolidate
  // loop refuses live writes unless the operator has made an explicit choice.
  describe("shadowModeSet tracking", () => {
    it("is false when no config file exists", () => {
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.shadowModeSet).toBe(false);
    });

    it("is false when shadow_mode is omitted", () => {
      writeConfig("version: 1\nvault_name: v\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.shadowModeSet).toBe(false);
    });

    it("is true when shadow_mode is explicitly set (even to false)", () => {
      writeConfig("version: 1\nvault_name: v\nshadow_mode: false\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.shadowMode).toBe(false);
      expect(result.value.shadowModeSet).toBe(true);
    });
  });

  describe("watch (issue #38 PR 3)", () => {
    it("defaults to true when no config file exists", () => {
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.watch).toBe(true);
    });

    it("defaults to true when the key is omitted", () => {
      writeConfig("version: 1\nvault_name: v\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.watch).toBe(true);
    });

    it("parses watch: false", () => {
      writeConfig("version: 1\nvault_name: v\nwatch: false\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.watch).toBe(false);
    });

    it("rejects a non-boolean watch value", () => {
      writeConfig("version: 1\nvault_name: v\nwatch: sure\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("watch");
    });
  });

  describe("tools (#103/#104)", () => {
    it("defaults to full exposure with empty include/exclude when the block is absent", () => {
      writeConfig("version: 1\nvault_name: v\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tools).toEqual({ tier: "full", include: [], exclude: [] });
    });

    it("parses tier plus include/exclude lists", () => {
      writeConfig(
        "version: 1\nvault_name: v\ntools:\n  tier: core\n" +
          "  include:\n    - vault_tension_log\n  exclude:\n    - vault_status\n",
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tools.tier).toBe("core");
      expect(result.value.tools.include).toEqual(["vault_tension_log"]);
      expect(result.value.tools.exclude).toEqual(["vault_status"]);
    });

    it("rejects an unknown tier — a typo must not silently change exposure", () => {
      writeConfig("version: 1\nvault_name: v\ntools:\n  tier: minimal\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("tools.tier");
      expect(result.error.message).toContain("core, standard, full");
    });

    // One config write per it(): loadConfig's cache is mtime-keyed, and a
    // write→load→write→load round trip on one path can serve the first
    // parse when the second write lands within the filesystem's mtime
    // resolution.
    it("rejects a non-list include", () => {
      writeConfig("version: 1\nvault_name: v\ntools:\n  include: vault_read\n");
      const badInclude = loadConfig(dir);
      expect(badInclude.ok).toBe(false);
      if (badInclude.ok) return;
      expect(badInclude.error.message).toContain("tools.include");
    });

    it("parses the server block and rejects malformed shapes loud (#5)", () => {
      writeConfig(
        "version: 1\nserver:\n  transport_security: external\n  auth:\n" +
          "    tokens:\n      - env: T_A\n        user: human:a\n        role: analyst\n",
      );
      const good = loadConfig(dir);
      expect(good.ok).toBe(true);
      if (!good.ok) return;
      expect(good.value.server.transportSecurity).toBe("external");
      expect(good.value.server.tokens).toEqual([{ env: "T_A", user: "human:a", role: "analyst" }]);
    });

    it("rejects a server token entry missing a field", () => {
      writeConfig(
        "version: 1\nserver:\n  auth:\n    tokens:\n      - env: T_A\n        user: human:a\n",
      );
      const bad = loadConfig(dir);
      expect(bad.ok).toBe(false);
      if (bad.ok) return;
      expect(bad.error.message).toContain("server.auth.tokens[0].role");
    });

    it("parses the oauth block and rejects malformed subjects (#7)", () => {
      writeConfig(
        "version: 1\nserver:\n  auth:\n    oauth:\n      issuer: https://idp.example\n" +
          "      audience: daftari\n      jwks_uri: https://idp.example/jwks.json\n" +
          '      subjects:\n        "a@example.com":\n          user: human:a\n          role: analyst\n',
      );
      const good = loadConfig(dir);
      expect(good.ok).toBe(true);
      if (!good.ok) return;
      expect(good.value.server.oauth?.issuer).toBe("https://idp.example");
      expect(good.value.server.oauth?.subjects["a@example.com"]).toEqual({
        user: "human:a",
        role: "analyst",
      });
    });

    it("rejects an oauth block missing a required field", () => {
      writeConfig(
        "version: 1\nserver:\n  auth:\n    oauth:\n      issuer: https://idp.example\n" +
          "      subjects: {}\n",
      );
      const bad = loadConfig(dir);
      expect(bad.ok).toBe(false);
      if (bad.ok) return;
      expect(bad.error.message).toContain("server.auth.oauth.audience");
    });

    it("rejects an unknown transport_security value", () => {
      writeConfig("version: 1\nserver:\n  transport_security: yolo\n");
      const bad = loadConfig(dir);
      expect(bad.ok).toBe(false);
      if (bad.ok) return;
      expect(bad.error.message).toContain("transport_security");
    });

    it("rejects an unrecognised tools.* key", () => {
      writeConfig("version: 1\nvault_name: v\ntools:\n  tiers: core\n");
      const badKey = loadConfig(dir);
      expect(badKey.ok).toBe(false);
      if (badKey.ok) return;
      expect(badKey.error.message).toContain("tools.tiers");
    });

    it("accepts unknown TOOL NAMES in include/exclude — future-tool forward compat", () => {
      writeConfig("version: 1\nvault_name: v\ntools:\n  exclude:\n    - vault_future_tool\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tools.exclude).toEqual(["vault_future_tool"]);
    });
  });

  describe("warm_embeddings (issue #38 PR 2)", () => {
    it("defaults to true when no config file exists", () => {
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Background warm-up is on by default — the first user search should
      // not pay the cold-start cost. Opt-out is for read-only or memory-
      // constrained deployments.
      expect(result.value.warmEmbeddings).toBe(true);
    });

    it("defaults to true when the key is omitted", () => {
      writeConfig("version: 1\nvault_name: v\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.warmEmbeddings).toBe(true);
    });

    it("parses warm_embeddings: false", () => {
      writeConfig("version: 1\nvault_name: v\nwarm_embeddings: false\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.warmEmbeddings).toBe(false);
    });

    it("parses warm_embeddings: true explicitly", () => {
      writeConfig("version: 1\nvault_name: v\nwarm_embeddings: true\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.warmEmbeddings).toBe(true);
    });

    it("rejects a non-boolean warm_embeddings value", () => {
      writeConfig("version: 1\nvault_name: v\nwarm_embeddings: maybe\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("warm_embeddings");
    });
  });

  describe("git_dir (external-git-dir feature)", () => {
    it("leaves gitDir undefined when git_dir is absent", () => {
      writeConfig("version: 1\nvault_name: v\n");
      const cfg = loadConfig(dir);
      expect(cfg.ok && cfg.value.gitDir).toBeUndefined();
    });

    it("resolves the 'external' sentinel to a path under the data home, outside the vault", () => {
      writeConfig("git_dir: external\n");
      const cfg = loadConfig(dir);
      expect(cfg.ok).toBe(true);
      if (!cfg.ok) return;
      expect(cfg.value.gitDir).toMatch(/daftari\/git\//);
      expect(cfg.value.gitDir?.startsWith(`${resolve(dir)}/`)).toBe(false);
    });

    it("expands ~ and resolves an explicit git_dir path", () => {
      writeConfig("git_dir: ~/somewhere/daftari-git\n");
      const cfg = loadConfig(dir);
      expect(cfg.ok && cfg.value.gitDir).toBe(join(homedir(), "somewhere/daftari-git"));
    });

    it("rejects a git_dir resolving inside the vault (loud error)", () => {
      writeConfig("git_dir: ./inside\n");
      expect(loadConfig(dir).ok).toBe(false);
    });

    it("rejects a non-string git_dir", () => {
      writeConfig("git_dir: [1, 2]\n");
      expect(loadConfig(dir).ok).toBe(false);
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
        name: "pattern risks catastrophic backtracking (nested quantifier)",
        yaml: "schema_extensions:\n  f:\n    type: string\n    pattern: '(a+)+$'\n",
        contains: "catastrophic backtracking",
      },
      {
        name: "pattern risks catastrophic backtracking (quantified overlapping alternation)",
        yaml: "schema_extensions:\n  f:\n    type: string\n    pattern: '(a|a)*$'\n",
        contains: "catastrophic backtracking",
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

  describe("backfill.identity_map", () => {
    it("yields an empty map when the block is absent", () => {
      writeConfig("roles:\n  admin:\n    read: ['*']\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.backfillIdentityMap).toEqual({});
    });

    it("parses git-author → identity mappings", () => {
      writeConfig(
        [
          "backfill:",
          "  identity_map:",
          '    "Mihir Wagle": human:mihir',
          '    "github-actions[bot]": agent:github-actions',
          "",
        ].join("\n"),
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.backfillIdentityMap).toEqual({
        "Mihir Wagle": "human:mihir",
        "github-actions[bot]": "agent:github-actions",
      });
    });

    it("rejects a non-mapping identity_map", () => {
      writeConfig("backfill:\n  identity_map:\n    - not-a-mapping\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("backfill.identity_map");
    });

    it("rejects an empty identity value", () => {
      writeConfig('backfill:\n  identity_map:\n    "Mihir Wagle": ""\n');
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
    });
  });

  describe("tension_scan block", () => {
    it("defaults when the block is absent", () => {
      writeConfig("auto_commit: true\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tensionScan).toEqual({
        maxLlmCalls: 200,
        maxDocs: 50,
        agent: "agent:sleep-tension-scan",
      });
    });

    it("honours declared budgets and agent", () => {
      writeConfig(
        "tension_scan:\n  max_llm_calls: 25\n  max_docs: 5\n  agent: agent:night-shift\n",
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tensionScan).toEqual({
        maxLlmCalls: 25,
        maxDocs: 5,
        agent: "agent:night-shift",
      });
    });

    it("keeps defaults for undeclared keys", () => {
      writeConfig("tension_scan:\n  max_llm_calls: 10\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tensionScan.maxLlmCalls).toBe(10);
      expect(result.value.tensionScan.maxDocs).toBe(50);
      expect(result.value.tensionScan.agent).toBe("agent:sleep-tension-scan");
    });

    it("rejects a non-integer budget", () => {
      writeConfig("tension_scan:\n  max_llm_calls: lots\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("tension_scan.max_llm_calls");
    });

    it("rejects a zero budget (the cap is a hard requirement, not an off switch)", () => {
      writeConfig("tension_scan:\n  max_docs: 0\n");
      expect(loadConfig(dir).ok).toBe(false);
    });

    it("rejects an unrecognised key so a typo cannot silently keep a default", () => {
      writeConfig("tension_scan:\n  max_llm_cals: 10\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("max_llm_cals");
    });

    it("rejects an empty agent", () => {
      writeConfig('tension_scan:\n  agent: ""\n');
      expect(loadConfig(dir).ok).toBe(false);
    });
  });

  describe("propose_only role flag (#235)", () => {
    it("parses propose_only: true onto the role", () => {
      writeConfig(
        "roles:\n  proposer:\n    read: ['*']\n    write: ['*']\n    propose_only: true\n",
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.roles.proposer?.proposeOnly).toBe(true);
    });

    it("defaults to absent/false when omitted", () => {
      writeConfig("roles:\n  writer:\n    read: ['*']\n    write: ['*']\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.roles.writer?.proposeOnly).toBeUndefined();
    });

    it("rejects a non-boolean propose_only", () => {
      writeConfig("roles:\n  proposer:\n    read: ['*']\n    propose_only: 'yes'\n");
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("propose_only");
    });

    it("rejects propose_only combined with ratify (a proposer does not decide)", () => {
      writeConfig(
        "roles:\n  confused:\n    read: ['*']\n    ratify: true\n    propose_only: true\n",
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("ratify and propose_only");
    });

    it("rejects propose_only combined with promote (promotion is a direct write)", () => {
      writeConfig(
        "roles:\n  confused:\n    read: ['*']\n    promote: true\n    propose_only: true\n",
      );
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("promote and propose_only");
    });
  });
});

describe("malformed-comment hint on YAML parse errors (#26)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-hint-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  it("points at a comment line that lost its '#' (the issue's repro)", () => {
    writeConfig(
      [
        "schema_extensions:",
        "  dec_id:",
        "    type: string",
        '    pattern: "^DEC-[0-9]{3}$"',
        "",
        "  # decision_date is kept as string because wiki uses free-form values like",
        " 2026-05 (revisited)\" that don't fit YYYY-MM-DD.",
        "  decision_date:",
        "    type: string",
        "",
      ].join("\n"),
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("malformed config: invalid YAML");
    expect(result.error.message).toContain(
      "hint: line 7 may be a malformed comment that lost its '#' prefix",
    );
  });

  it("stays silent when the parse error has no prose-shaped neighbor", () => {
    writeConfig("roles:\n  admin:\n    read: [unclosed\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("malformed config: invalid YAML");
    expect(result.error.message).not.toContain("hint:");
  });

  it("malformedCommentHint ignores comments, list items, and mapping entries", () => {
    const text = [
      "# a real comment with words and punctuation.",
      "- a list item with several words.",
      "key: a mapping value with several words.",
      "broken [",
    ].join("\n");
    expect(malformedCommentHint(text, 3)).toBeNull();
    expect(malformedCommentHint(text, null)).toBeNull();
  });
});
