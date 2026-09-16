// config-session.test.ts — U2: server.auth.session schema validation.
//
// Shape-only validation, mirroring the tokens/oauth blocks: config load stays
// pure of process.env, so "is the env var set?" and "does maps_to.role exist?"
// are serve-startup checks, not load-time ones. This suite locks the loud
// failures and the defaulting of lifetime_hours.
//
// Run with: npx vitest run test/utils/config-session.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, DEFAULT_SESSION_LIFETIME_HOURS, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — server.auth.session", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-session-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  const base = "version: 1\nvault_name: v\nroles:\n  admin:\n    read: ['*']\n";

  it("parses a full session block and applies the lifetime", () => {
    writeConfig(
      `${base}server:\n  auth:\n    session:\n      signing_key_env: DAFTARI_SESSION_KEY\n` +
        "      credential_env: DAFTARI_BOARD_PASSWORD\n" +
        "      maps_to: { user: mihir, role: admin }\n      lifetime_hours: 8\n",
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const session = result.value.server.session;
    expect(session).toBeDefined();
    expect(session?.signingKeyEnv).toBe("DAFTARI_SESSION_KEY");
    expect(session?.credentialEnv).toBe("DAFTARI_BOARD_PASSWORD");
    expect(session?.mapsTo).toEqual({ user: "mihir", role: "admin" });
    expect(session?.lifetimeHours).toBe(8);
  });

  it("defaults lifetime_hours when omitted", () => {
    writeConfig(
      `${base}server:\n  auth:\n    session:\n      signing_key_env: K\n` +
        "      credential_env: P\n      maps_to: { user: mihir, role: admin }\n",
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.server.session?.lifetimeHours).toBe(DEFAULT_SESSION_LIFETIME_HOURS);
  });

  it("leaves session undefined when the block is omitted (tokens still parse)", () => {
    writeConfig(
      `${base}server:\n  auth:\n    tokens:\n      - env: T\n        user: agent\n        role: admin\n`,
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.server.session).toBeUndefined();
    expect(result.value.server.tokens).toHaveLength(1);
  });

  it("rejects an unknown key inside session", () => {
    writeConfig(
      `${base}server:\n  auth:\n    session:\n      signing_key_env: K\n      credential_env: P\n` +
        "      maps_to: { user: mihir, role: admin }\n      ttl: 5\n",
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/server\.auth\.session/);
  });

  it("rejects a missing signing_key_env", () => {
    writeConfig(
      `${base}server:\n  auth:\n    session:\n      credential_env: P\n` +
        "      maps_to: { user: mihir, role: admin }\n",
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/signing_key_env/);
  });

  it("rejects a missing maps_to", () => {
    writeConfig(
      `${base}server:\n  auth:\n    session:\n      signing_key_env: K\n      credential_env: P\n`,
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/maps_to/);
  });

  it("rejects a maps_to missing role", () => {
    writeConfig(
      `${base}server:\n  auth:\n    session:\n      signing_key_env: K\n      credential_env: P\n` +
        "      maps_to: { user: mihir }\n",
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/maps_to\.role/);
  });

  it("rejects a non-positive lifetime_hours", () => {
    writeConfig(
      `${base}server:\n  auth:\n    session:\n      signing_key_env: K\n      credential_env: P\n` +
        "      maps_to: { user: mihir, role: admin }\n      lifetime_hours: 0\n",
    );
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/lifetime_hours/);
  });
});
