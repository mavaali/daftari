// Scoped addressing (2026-11-08 spec): `scope` + `key` frontmatter and the
// deterministic scope/key -> path derivation. The derivation is a trust
// boundary — caller-supplied text becomes a filesystem path — so traversal
// shapes are enumerated here explicitly.

import { describe, expect, it } from "vitest";
import { validateFrontmatter } from "../../src/frontmatter/schema.js";
import { deriveScopedPath, parseScope, scopedPathMismatch } from "../../src/frontmatter/scope.js";
import { BUILTIN_FRONTMATTER_FIELDS } from "../../src/frontmatter/types.js";

function derive(scope: string, key: string): string {
  const r = deriveScopedPath(scope, key);
  if (!r.ok) throw r.error;
  return r.value;
}

function rejects(scope: string, key = "k"): string {
  const r = deriveScopedPath(scope, key);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.error.message;
}

describe("parseScope", () => {
  it("splits on the first '::'", () => {
    const r = parseScope("repo::github.com/acme/checkout");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ level: "repo", value: "github.com/acme/checkout" });
  });

  it("rejects a missing separator, bad level, or empty value", () => {
    for (const bad of ["repo", "Repo::x", "1repo::x", "re po::x", "::x", "repo::", "repo_x::y"]) {
      expect(parseScope(bad).ok, bad).toBe(false);
    }
  });

  it("rejects whitespace and control characters in the value", () => {
    for (const bad of [
      "repo::a b",
      "repo::a\tb",
      "repo::a\nb",
      "repo::a\u0000b",
      "repo::a\u007fb",
    ]) {
      expect(parseScope(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("deriveScopedPath", () => {
  it("derives scopes/<level>/<value>/<key>.md, keeping '/' as directories", () => {
    expect(derive("repo::github.com/acme/checkout", "tests-need-local-postgres")).toBe(
      "scopes/repo/github.com/acme/checkout/tests-need-local-postgres.md",
    );
  });

  it("maps characters outside [A-Za-z0-9._-] to '-'", () => {
    expect(derive("user::alice@example.com", "k")).toBe("scopes/user/alice-example.com/k.md");
    expect(derive("ticket::JIRA:42", "k")).toBe("scopes/ticket/JIRA-42/k.md");
  });

  it("is deterministic", () => {
    expect(derive("team::payments", "oncall")).toBe(derive("team::payments", "oncall"));
  });

  it("rejects '..' segments anywhere", () => {
    rejects("repo::..");
    rejects("repo::../etc");
    rejects("repo::a/../../b");
    rejects("repo::a/..");
  });

  it("rejects '.' segments and './' prefixes", () => {
    rejects("repo::.");
    rejects("repo::./a");
    rejects("repo::a/./b");
  });

  it("rejects dot-leading segments (hidden dirs such as .git)", () => {
    rejects("repo::.git");
    rejects("repo::a/.daftari/b");
  });

  it("rejects empty segments: '//', leading '/', trailing '/'", () => {
    rejects("repo::a//b");
    rejects("repo::/etc/passwd");
    rejects("repo::a/");
  });

  it("rejects whitespace in the value", () => {
    rejects("repo::a b");
    rejects("repo::a/ /b");
  });

  it("confines unicode lookalikes of '.' and '/' instead of interpreting them", () => {
    // U+2024 ONE DOT LEADER, U+FF0E FULLWIDTH FULL STOP, U+2215 DIVISION SLASH,
    // U+FF0F FULLWIDTH SOLIDUS: none is a path separator or dot; each maps to '-'.
    const p = derive("repo::․․∕．．／etc", "k");
    expect(p).toBe("scopes/repo/------etc/k.md");
    expect(p.split("/")).not.toContain("..");
  });

  it("rejects a key that is not a slug", () => {
    for (const bad of ["", "UPPER", "-lead", ".dot", "a/b", "../x", "a b", "x".repeat(129)]) {
      expect(deriveScopedPath("repo::x", bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(deriveScopedPath("repo::x", "a".repeat(128)).ok).toBe(true);
  });

  it("rejects a value segment longer than 255 bytes", () => {
    rejects(`repo::${"a".repeat(256)}`);
  });
});

describe("scopedPathMismatch", () => {
  it("is null when scope/key derive to the path", () => {
    expect(
      scopedPathMismatch("scopes/team/payments/oncall.md", {
        scope: "team::payments",
        key: "oncall",
        collection: "scopes",
      }),
    ).toBeNull();
  });

  it("names a mismatch between scope/key and the path", () => {
    expect(
      scopedPathMismatch("scopes/team/payments/other.md", {
        scope: "team::payments",
        key: "oncall",
        collection: "scopes",
      }),
    ).toMatch(/derive to scopes\/team\/payments\/oncall\.md/);
  });

  it("flags an unscoped document inside scopes/", () => {
    expect(scopedPathMismatch("scopes/team/payments/x.md", { collection: "scopes" })).toMatch(
      /reserved/,
    );
  });

  it("flags a scoped document whose collection is not 'scopes'", () => {
    expect(
      scopedPathMismatch("scopes/team/payments/oncall.md", {
        scope: "team::payments",
        key: "oncall",
        collection: "pricing",
      }),
    ).toMatch(/collection/);
  });

  it("ignores unscoped documents outside scopes/", () => {
    expect(scopedPathMismatch("pricing/a.md", { collection: "pricing" })).toBeNull();
  });
});

describe("scope/key frontmatter validation", () => {
  const base = {
    title: "T",
    domain: "accumulation",
    collection: "scopes",
    status: "draft",
    confidence: "medium",
    created: "2026-11-08",
    updated: "2026-11-08",
    updated_by: "agent:t",
    provenance: "direct",
  };

  it("registers scope and key as built-ins", () => {
    expect(BUILTIN_FRONTMATTER_FIELDS).toContain("scope");
    expect(BUILTIN_FRONTMATTER_FIELDS).toContain("key");
  });

  it("accepts both together", () => {
    const { frontmatter, report } = validateFrontmatter({ ...base, scope: "repo::x", key: "k" });
    expect(report.valid).toBe(true);
    expect(frontmatter.scope).toBe("repo::x");
    expect(frontmatter.key).toBe("k");
  });

  it("accepts neither", () => {
    expect(validateFrontmatter(base).report.valid).toBe(true);
  });

  it("rejects scope without key and key without scope", () => {
    const a = validateFrontmatter({ ...base, scope: "repo::x" });
    expect(a.report.valid).toBe(false);
    expect(a.report.issues.map((i) => i.field)).toContain("key");
    const b = validateFrontmatter({ ...base, key: "k" });
    expect(b.report.valid).toBe(false);
    expect(b.report.issues.map((i) => i.field)).toContain("scope");
  });

  it("rejects a malformed scope or key", () => {
    expect(validateFrontmatter({ ...base, scope: "repo::../x", key: "k" }).report.valid).toBe(
      false,
    );
    expect(validateFrontmatter({ ...base, scope: "repo::x", key: "Bad Key" }).report.valid).toBe(
      false,
    );
    expect(validateFrontmatter({ ...base, scope: "repo::x", key: 42 }).report.valid).toBe(false);
  });
});
