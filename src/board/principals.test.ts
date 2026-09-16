// principals.test.ts — TDD test suite for U10: configured principals + dispose capability.
//
// Run with:
//   npx vitest run src/board/principals.test.ts
//
// Also run adjacent suites to confirm additive changes stay green:
//   npx vitest run src/board/
//   npx vitest run test/access/rbac.test.ts test/utils/config.test.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canDispose } from "../access/rbac.js";
import type { RoleConfig } from "../utils/config.js";
import { configPath, loadConfig } from "../utils/config.js";
import { configuredPrincipals, isConfiguredPrincipal } from "./principals.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dir: string;

function writeConfig(yaml: string): void {
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  writeFileSync(configPath(dir), yaml);
}

function loadOrThrow(yaml: string) {
  writeConfig(yaml);
  const result = loadConfig(dir);
  if (!result.ok) throw result.error;
  return result.value;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daftari-principals-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. configuredPrincipals — derive principal set from tokens[].user
// ---------------------------------------------------------------------------

describe("configuredPrincipals", () => {
  it("collects user names from server.auth.tokens", () => {
    const config = loadOrThrow(`
server:
  auth:
    tokens:
      - env: TOK_AGENT
        user: agent:loop
        role: agent
      - env: TOK_HUMAN
        user: human:mihir
        role: human
roles:
  agent:
    read: ["*"]
    write: ["*"]
  human:
    read: ["*"]
    write: ["*"]
`);
    const principals = configuredPrincipals(config);
    expect(principals.has("agent:loop")).toBe(true);
    expect(principals.has("human:mihir")).toBe(true);
    expect(principals.size).toBe(2);
  });

  it("returns an empty set when no tokens and no principals declared", () => {
    const config = loadOrThrow("version: 1\n");
    expect(configuredPrincipals(config).size).toBe(0);
  });

  it("unions token users with an explicit principals list", () => {
    const config = loadOrThrow(`
server:
  auth:
    tokens:
      - env: TOK_AGENT
        user: agent:loop
        role: agent
roles:
  agent:
    read: ["*"]
    write: ["*"]
principals:
  - human:extra
  - human:another
`);
    const principals = configuredPrincipals(config);
    expect(principals.has("agent:loop")).toBe(true);
    expect(principals.has("human:extra")).toBe(true);
    expect(principals.has("human:another")).toBe(true);
    expect(principals.size).toBe(3);
  });

  it("deduplicates when the same user appears in both tokens and principals list", () => {
    const config = loadOrThrow(`
server:
  auth:
    tokens:
      - env: TOK
        user: human:mihir
        role: human
roles:
  human:
    read: ["*"]
    write: ["*"]
principals:
  - human:mihir
`);
    expect(configuredPrincipals(config).size).toBe(1);
  });

  it("config with only explicit principals and no tokens", () => {
    const config = loadOrThrow("principals:\n  - human:solo\n");
    const principals = configuredPrincipals(config);
    expect(principals.has("human:solo")).toBe(true);
    expect(principals.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. isConfiguredPrincipal — boolean gate
// ---------------------------------------------------------------------------

describe("isConfiguredPrincipal", () => {
  it("returns true when the owner name is in token users", () => {
    const config = loadOrThrow(`
server:
  auth:
    tokens:
      - env: TOK
        user: human:owner
        role: human
roles:
  human:
    read: ["*"]
    write: ["*"]
`);
    expect(isConfiguredPrincipal(config, "human:owner")).toBe(true);
  });

  it("returns false when the name is not in the configured principal set", () => {
    const config = loadOrThrow(`
server:
  auth:
    tokens:
      - env: TOK
        user: human:owner
        role: human
roles:
  human:
    read: ["*"]
    write: ["*"]
`);
    expect(isConfiguredPrincipal(config, "unknown:stranger")).toBe(false);
  });

  it("returns false for empty string owner", () => {
    const config = loadOrThrow(`
server:
  auth:
    tokens:
      - env: TOK
        user: human:owner
        role: human
roles:
  human:
    read: ["*"]
    write: ["*"]
`);
    expect(isConfiguredPrincipal(config, "")).toBe(false);
  });

  it("returns false for whitespace-only owner", () => {
    const config = loadOrThrow(`
server:
  auth:
    tokens:
      - env: TOK
        user: human:owner
        role: human
roles:
  human:
    read: ["*"]
    write: ["*"]
`);
    expect(isConfiguredPrincipal(config, "   ")).toBe(false);
  });

  it("returns false when config has no principals at all", () => {
    const config = loadOrThrow("version: 1\n");
    expect(isConfiguredPrincipal(config, "human:anyone")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. RoleConfig dispose flag — config round-trip via real parser
// ---------------------------------------------------------------------------

describe("dispose flag in RoleConfig (config round-trip)", () => {
  it("parses dispose: true for a human operator role", () => {
    const config = loadOrThrow(`
roles:
  human:
    read: ["*"]
    write: ["*"]
    promote: true
    ratify: true
    dispose: true
`);
    expect(config.roles.human?.dispose).toBe(true);
  });

  it("defaults dispose to absent (falsy) when not declared", () => {
    const config = loadOrThrow(`
roles:
  agent:
    read: ["*"]
    write: ["*"]
`);
    // absent means the key is omitted (undefined / falsy) — not forced to false
    const role = config.roles.agent;
    expect(role?.dispose).toBeFalsy();
  });

  it("existing config without dispose parses unchanged", () => {
    const config = loadOrThrow(`
roles:
  analyst:
    read: ["competitive-intel", "pricing"]
    write: []
    promote: false
    ratify: true
`);
    const role = config.roles.analyst;
    // Existing fields untouched.
    expect(role?.read).toEqual(["competitive-intel", "pricing"]);
    expect(role?.promote).toBe(false);
    expect(role?.ratify).toBe(true);
    // dispose absent — backward compatible.
    expect(role?.dispose).toBeFalsy();
  });

  it("fails loud when dispose is not a boolean", () => {
    const result = (() => {
      writeConfig(`
roles:
  bad:
    read: ["*"]
    write: []
    dispose: yes_string
`);
      return loadConfig(dir);
    })();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("dispose");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. canDispose — capability predicate in rbac.ts
// ---------------------------------------------------------------------------

describe("canDispose", () => {
  it("returns true for a role with dispose: true", () => {
    const role: RoleConfig = {
      read: ["*"],
      write: ["*"],
      promote: false,
      ratify: false,
      dispose: true,
    };
    expect(canDispose(role)).toBe(true);
  });

  it("returns false for a role without dispose (agent role)", () => {
    const role: RoleConfig = {
      read: ["*"],
      write: ["*"],
      promote: false,
      ratify: false,
    };
    expect(canDispose(role)).toBe(false);
  });

  it("returns false for a role with dispose explicitly false", () => {
    const role: RoleConfig = {
      read: ["*"],
      write: [],
      promote: false,
      ratify: false,
      dispose: false,
    };
    expect(canDispose(role)).toBe(false);
  });

  it("returns false for null role (guest / unknown role)", () => {
    expect(canDispose(null)).toBe(false);
  });

  it("dispose from config round-trips through canDispose", () => {
    const config = loadOrThrow(`
roles:
  human:
    read: ["*"]
    write: ["*"]
    dispose: true
  agent:
    read: ["*"]
    write: ["*"]
`);
    expect(canDispose(config.roles.human ?? null)).toBe(true);
    expect(canDispose(config.roles.agent ?? null)).toBe(false);
  });
});
