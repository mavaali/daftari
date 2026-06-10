// test/audit/config.test.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAuditConfig } from "../../src/audit/config.js";

describe("parseAuditConfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "daftari-audit-cfg-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses CLI --repo flags into anonymous repos with defaults", () => {
    const a = join(tmp, "a");
    mkdirSync(a);
    const b = join(tmp, "b");
    mkdirSync(b);
    const result = parseAuditConfig([`--repo`, a, `--repo`, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cfg = result.value;
    expect(cfg.repos.map((r) => r.name)).toEqual(["repo-0", "repo-1"]);
    expect(cfg.repos[0]?.path).toBe(realpathSync(resolve(a)));
    expect(cfg.repos[0]?.docsGlob).toBe("**/*.md");
    expect(cfg.repos[0]?.urls).toEqual([]);
    expect(cfg.staleness.thresholdDays).toBe(540);
    expect(cfg.failOn).toEqual({ brokenRefs: 1, transitiveStaleness: 100 });
  });

  it("loads YAML and applies defaults to omitted fields", () => {
    const a = join(tmp, "a");
    mkdirSync(a);
    const yamlText = `
repos:
  - name: alpha
    path: ${a}
    urls:
      - github.com/org/alpha
output:
  markdown: report.md
staleness:
  threshold_days: 90
fail_on:
  broken_refs: 5
`;
    const result = parseAuditConfig([`--config`, "ignored"], () => yamlText);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cfg = result.value;
    expect(cfg.repos[0]?.name).toBe("alpha");
    expect(cfg.repos[0]?.urls).toEqual(["github.com/org/alpha"]);
    expect(cfg.repos[0]?.docsGlob).toBe("**/*.md");
    expect(cfg.output.markdown).toBe("report.md");
    expect(cfg.staleness.thresholdDays).toBe(90);
    expect(cfg.failOn.brokenRefs).toBe(5);
    expect(cfg.failOn.transitiveStaleness).toBe(100);
  });

  it("merges YAML repos with anonymous CLI repos", () => {
    const a = join(tmp, "a");
    mkdirSync(a);
    const b = join(tmp, "b");
    mkdirSync(b);
    const yamlText = `repos:\n  - name: alpha\n    path: ${a}\n`;
    const result = parseAuditConfig([`--config`, "ignored", `--repo`, b], () => yamlText);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repos.map((r) => r.name)).toEqual(["alpha", "repo-0"]);
  });

  it("CLI --output overrides YAML output.markdown and warns to stderr", () => {
    const a = join(tmp, "a");
    mkdirSync(a);
    const yamlText = `
repos:
  - name: alpha
    path: ${a}
output:
  markdown: from-yaml.md
`;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const result = parseAuditConfig(
      [`--config`, "ignored", `--output`, "from-cli.md"],
      () => yamlText,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output.markdown).toBe("from-cli.md");
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("warning: --output overrides output.markdown"),
    );
    stderr.mockRestore();
  });

  it("returns config-kind error on duplicate repo names", () => {
    const a = join(tmp, "a");
    mkdirSync(a);
    const b = join(tmp, "b");
    mkdirSync(b);
    const yamlText = `
repos:
  - name: same
    path: ${a}
  - name: same
    path: ${b}
`;
    const result = parseAuditConfig([`--config`, "ignored"], () => yamlText);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config");
    expect(result.error.message).toContain("duplicate repo name");
  });

  it("returns config-kind error on duplicate repo paths", () => {
    const a = join(tmp, "a");
    mkdirSync(a);
    const yamlText = `
repos:
  - name: one
    path: ${a}
  - name: two
    path: ${a}
`;
    const result = parseAuditConfig([`--config`, "ignored"], () => yamlText);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config");
    expect(result.error.message).toContain("duplicate repo path");
  });

  it("returns config-kind error when repo path does not exist", () => {
    const result = parseAuditConfig([`--repo`, join(tmp, "nope")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config");
  });

  it("returns config-kind error when no repos given", () => {
    const result = parseAuditConfig([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config");
  });

  it("CLI --output-json overrides YAML output.json and warns to stderr", () => {
    const a = join(tmp, "a");
    mkdirSync(a);
    const yamlText = `
repos:
  - name: alpha
    path: ${a}
output:
  json: from-yaml.json
`;
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const result = parseAuditConfig(
      [`--config`, "ignored", `--output-json`, "from-cli.json"],
      () => yamlText,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output.json).toBe("from-cli.json");
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("warning: --output-json overrides output.json"),
    );
    stderr.mockRestore();
  });

  it("returns config-kind error on malformed YAML", () => {
    const result = parseAuditConfig([`--config`, "ignored"], () => "{ broken");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config");
    expect(result.error.message).toContain("malformed YAML");
  });

  it("returns config-kind error when YAML is not a map at the top level", () => {
    const result = parseAuditConfig([`--config`, "ignored"], () => "just-a-string");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("config");
    expect(result.error.message).toContain("expected a YAML map");
  });

  describe("repo type (#118)", () => {
    it("defaults a YAML repo's type to 'docs' when omitted", () => {
      const a = join(tmp, "a");
      mkdirSync(a);
      const result = parseAuditConfig(
        [`--config`, "ignored"],
        () => `repos:\n  - name: alpha\n    path: ${a}\n`,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.repos[0]?.type).toBe("docs");
    });

    it("parses an explicit type: code repo", () => {
      const a = join(tmp, "a");
      mkdirSync(a);
      const result = parseAuditConfig(
        [`--config`, "ignored"],
        () => `repos:\n  - name: svc\n    path: ${a}\n    type: code\n`,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.repos[0]?.type).toBe("code");
    });

    it("defaults a code repo's glob to **/* so non-markdown files are indexed", () => {
      const a = join(tmp, "a");
      mkdirSync(a);
      const result = parseAuditConfig(
        [`--config`, "ignored"],
        () => `repos:\n  - name: svc\n    path: ${a}\n    type: code\n`,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.repos[0]?.docsGlob).toBe("**/*");
    });

    it("honours an explicit docs_glob on a code repo", () => {
      const a = join(tmp, "a");
      mkdirSync(a);
      const result = parseAuditConfig(
        [`--config`, "ignored"],
        () =>
          `repos:\n  - name: svc\n    path: ${a}\n    type: code\n    docs_glob: "src/**/*.ts"\n`,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.repos[0]?.docsGlob).toBe("src/**/*.ts");
    });

    it("returns a config error on an unknown type value", () => {
      const a = join(tmp, "a");
      mkdirSync(a);
      const result = parseAuditConfig(
        [`--config`, "ignored"],
        () => `repos:\n  - name: svc\n    path: ${a}\n    type: binary\n`,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("config");
      expect(result.error.message).toContain("type");
    });

    it("defaults a CLI --repo to type 'docs'", () => {
      const a = join(tmp, "a");
      mkdirSync(a);
      const result = parseAuditConfig([`--repo`, a]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.repos[0]?.type).toBe("docs");
    });

    it("registers a CLI --code-repo as type 'code'", () => {
      const a = join(tmp, "a");
      mkdirSync(a);
      const result = parseAuditConfig([`--code-repo`, a]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.repos[0]?.type).toBe("code");
    });
  });
});
