// The registry guard (#297, spec Decision 5): every registered tool is either
// in the federation allowlist or assigned exactly one refusal class. This is
// the structural enforcement that a new tool cannot ship with undefined
// federated-path behavior — adding a tool without classifying it fails here.

import { describe, expect, it } from "vitest";
import {
  FEDERATED_TOOLS,
  federatedRefusal,
  readOnlyRefusal,
  STATE_READ_TOOLS,
  STATE_REFUSAL,
  scanArgsForFederatedPath,
  WRITE_SHAPED_TOOLS,
} from "../../src/federation/classification.js";
import type { MountRegistry } from "../../src/federation/mounts.js";
import { registeredToolNames } from "../../src/server.js";

function registryWith(aliases: string[]): MountRegistry {
  return {
    mounts: new Map(
      aliases.map((alias) => [
        alias,
        {
          alias,
          root: `/tmp/${alias}`,
          state: "ok" as const,
          role: null,
          roleName: "guest",
          schemaExtensions: [],
          indexMode: "full" as const,
        },
      ]),
    ),
  };
}

describe("federation tool classification", () => {
  it("classifies every registered tool into exactly one class", () => {
    for (const name of registeredToolNames()) {
      const classes = [
        FEDERATED_TOOLS.has(name),
        WRITE_SHAPED_TOOLS.has(name),
        STATE_READ_TOOLS.has(name),
      ].filter(Boolean).length;
      expect(classes, `tool ${name} must be in exactly one federation class`).toBe(1);
    }
  });

  it("names no tool that is not registered (no stale classifications)", () => {
    const registered = new Set(registeredToolNames());
    for (const set of [FEDERATED_TOOLS, WRITE_SHAPED_TOOLS, STATE_READ_TOOLS]) {
      for (const name of set) {
        expect(registered.has(name), `classified tool ${name} is not registered`).toBe(true);
      }
    }
  });

  it("keeps the six-tool allowlist closed", () => {
    expect([...FEDERATED_TOOLS].sort()).toEqual([
      "vault_index",
      "vault_read",
      "vault_reindex",
      "vault_search",
      "vault_search_related",
      "vault_status",
    ]);
  });

  it("returns the read-only copy for write-shaped tools", () => {
    const msg = federatedRefusal("vault_write", "research:notes/pricing.md");
    expect(msg).toBe(
      'federated mount is read-only: "research:notes/pricing.md" — ' +
        "writes apply only to the local vault",
    );
    expect(federatedRefusal("vault_merge", "research:a.md")).toBe(readOnlyRefusal("research:a.md"));
    expect(federatedRefusal("vault_tier2_verdict", "research:a.md")).toBe(
      readOnlyRefusal("research:a.md"),
    );
  });

  it("returns the documents-only copy for state-read tools", () => {
    for (const tool of ["vault_provenance", "vault_lint", "vault_backlinks", "vault_tier1"]) {
      expect(federatedRefusal(tool, "research:a.md")).toBe(STATE_REFUSAL);
    }
  });

  it("returns null for allowlisted tools", () => {
    expect(federatedRefusal("vault_read", "research:a.md")).toBeNull();
    expect(federatedRefusal("vault_search", "research:a.md")).toBeNull();
  });
});

describe("scanArgsForFederatedPath", () => {
  const registry = registryWith(["research"]);

  it("finds an alias-prefixed value under path-bearing keys", () => {
    expect(scanArgsForFederatedPath({ path: "research:notes/a.md" }, registry)?.alias).toBe(
      "research",
    );
    expect(scanArgsForFederatedPath({ target_path: "research:a.md" }, registry)?.alias).toBe(
      "research",
    );
    expect(
      scanArgsForFederatedPath({ source_paths: ["local/a.md", "research:b.md"] }, registry)?.raw,
    ).toBe("research:b.md");
    expect(scanArgsForFederatedPath({ source_a: "research:b.md" }, registry)?.alias).toBe(
      "research",
    );
    expect(scanArgsForFederatedPath({ from: "research:b.md" }, registry)?.alias).toBe("research");
  });

  it("ignores content-bearing keys so prose cannot false-positive", () => {
    expect(
      scanArgsForFederatedPath({ content: "research: findings pending" }, registry),
    ).toBeNull();
    expect(scanArgsForFederatedPath({ rationale: "research:a.md moved" }, registry)).toBeNull();
  });

  it("ignores ':'-containing paths whose prefix is not a declared alias", () => {
    expect(scanArgsForFederatedPath({ path: "notes:pricing.md" }, registry)).toBeNull();
    expect(scanArgsForFederatedPath({ path: "other:a.md" }, registry)).toBeNull();
  });
});
