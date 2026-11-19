// Review-burden instrumentation (bead 9mpe): decided_by_kind derivation and
// the content-free review journal (.daftari/review-log.jsonl).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendReviewEvents,
  docReviewItem,
  principalKind,
  principalKindForVault,
  readReviewEvents,
  recordShown,
  reviewLogPath,
} from "../../src/curation/review-log.js";
import { type DaftariConfig, loadConfig } from "../../src/utils/config.js";

function writeConfig(vault: string, yaml: string): void {
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(join(vault, ".daftari", "config.yaml"), yaml);
}

function configFrom(yaml: string): DaftariConfig {
  const dir = mkdtempSync(join(tmpdir(), "daftari-rl-cfg-"));
  try {
    writeConfig(dir, yaml);
    const c = loadConfig(dir);
    if (!c.ok) throw c.error;
    return c.value;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("principal_kinds config", () => {
  it("parses a principal → kind mapping", () => {
    const c = configFrom("version: 1\nprincipal_kinds:\n  mihir: human\n  mavaali: agent\n");
    expect(c.principalKinds).toEqual({ mihir: "human", mavaali: "agent" });
  });

  it("rejects a kind outside human | agent | unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "daftari-rl-cfg-"));
    try {
      writeConfig(dir, "version: 1\nprincipal_kinds:\n  mihir: robot\n");
      const c = loadConfig(dir);
      expect(c.ok).toBe(false);
      if (c.ok) return;
      expect(c.error.message).toContain("principal_kinds");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-mapping principal_kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "daftari-rl-cfg-"));
    try {
      writeConfig(dir, "version: 1\nprincipal_kinds: [mihir]\n");
      expect(loadConfig(dir).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("principalKind", () => {
  const config = configFrom(
    [
      "version: 1",
      "roles:",
      "  admin: { read: ['*'], write: ['*'], promote: true, ratify: true, dispose: true }",
      "principal_kinds:",
      "  mavaali: agent",
      "  'agent:odd-human': human",
      "server:",
      "  auth:",
      "    session:",
      "      signing_key_env: K",
      "      credential_env: P",
      "      maps_to: { user: mihir, role: admin }",
      "",
    ].join("\n"),
  );

  it("an explicit principal_kinds entry wins", () => {
    expect(principalKind(config, "mavaali")).toBe("agent");
    // Explicit beats the agent: prefix convention.
    expect(principalKind(config, "agent:odd-human")).toBe("human");
  });

  it("the browser-session identity (server.auth.session.maps_to.user) is human", () => {
    expect(principalKind(config, "mihir")).toBe("human");
  });

  it("agent: and system: prefixed principals are agents", () => {
    expect(principalKind(config, "agent:curation-loop")).toBe("agent");
    expect(principalKind(config, "system:lint-sweep")).toBe("agent");
  });

  it("never infers human from a name — human: prefix is unknown without config", () => {
    expect(principalKind(config, "human:mihir")).toBe("unknown");
  });

  it("an unmapped or missing principal is unknown", () => {
    expect(principalKind(config, "someone")).toBe("unknown");
    expect(principalKind(config, undefined)).toBe("unknown");
    expect(principalKind(config, null)).toBe("unknown");
    expect(principalKind(config, "  ")).toBe("unknown");
  });
});

describe("review journal", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-rl-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("principalKindForVault reads the vault config; a broken config degrades to prefix rules", () => {
    writeConfig(vault, "version: 1\nprincipal_kinds:\n  mavaali: agent\n");
    expect(principalKindForVault(vault, "mavaali")).toBe("agent");
    writeConfig(vault, "version: 1\nprincipal_kinds: [broken\n");
    expect(principalKindForVault(vault, "mavaali")).toBe("unknown");
    expect(principalKindForVault(vault, "agent:x")).toBe("agent");
  });

  it("appends and reads events; missing kinds read as unknown", () => {
    appendReviewEvents(vault, [
      {
        ev: "decision",
        surface: "staged",
        item: "stage-001",
        action: "ratified",
        decided_by_kind: "human",
        changed_anything: true,
        at: "2026-11-01T00:00:00Z",
      },
    ]);
    // A hand-written older-shape line with no kind fields.
    writeFileSync(
      reviewLogPath(vault),
      `${readFileSync(reviewLogPath(vault), "utf-8")}${JSON.stringify({
        ev: "decision",
        surface: "board",
        item: "f1",
        action: "accept",
        at: "2026-11-02T00:00:00Z",
      })}\n${JSON.stringify({ ev: "shown", surface: "board", item: "f1", at: "2026-11-01T00:00:00Z" })}\nnot json\n`,
    );
    const events = readReviewEvents(vault);
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ ev: "decision", decided_by_kind: "unknown" });
    expect(events[1]).toMatchObject({ changed_anything: false });
    expect(events[2]).toMatchObject({ ev: "shown", viewer_kind: "unknown" });
  });

  it("a missing journal reads as empty", () => {
    expect(readReviewEvents(vault)).toEqual([]);
  });

  it("recordShown keeps only the FIRST surfacing per (item, viewer kind)", () => {
    recordShown(vault, "board", ["stage-001", "tension-002"], "human", "2026-11-01T00:00:00Z");
    recordShown(vault, "board", ["stage-001"], "human", "2026-11-05T00:00:00Z");
    recordShown(vault, "docket", ["tension-002"], "human", "2026-11-06T00:00:00Z");
    recordShown(vault, "board", ["stage-001"], "agent", "2026-11-07T00:00:00Z");
    const shown = readReviewEvents(vault).filter((e) => e.ev === "shown");
    expect(shown).toEqual([
      {
        ev: "shown",
        surface: "board",
        item: "stage-001",
        viewer_kind: "human",
        at: "2026-11-01T00:00:00Z",
      },
      {
        ev: "shown",
        surface: "board",
        item: "tension-002",
        viewer_kind: "human",
        at: "2026-11-01T00:00:00Z",
      },
      {
        ev: "shown",
        surface: "board",
        item: "stage-001",
        viewer_kind: "agent",
        at: "2026-11-07T00:00:00Z",
      },
    ]);
  });

  it("doc items are hashed — no paths land in the journal", () => {
    const item = docReviewItem("pricing/secret-plan.md");
    expect(item).toMatch(/^doc:[0-9a-f]{16}$/);
    expect(item).not.toContain("secret");
    expect(docReviewItem("pricing/secret-plan.md")).toBe(item);
  });
});
