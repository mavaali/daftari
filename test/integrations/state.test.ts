import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "../../src/frontmatter/types.js";
import {
  integrationStatePath,
  readIntegrationState,
  resolveIntegrationStateKey,
  writeIntegrationState,
} from "../../src/integrations/state.js";
import type { IntegrationState } from "../../src/integrations/types.js";

const KEY = Buffer.alloc(32, 7);

function state(refreshToken: string): IntegrationState {
  return {
    providers: {
      google: {
        accessToken: "access-token",
        refreshToken,
        accessTokenExpiresAt: "2026-08-24T12:00:00.000Z",
        cursor: "drive-cursor",
        webhook: { id: "channel-1", secret: "webhook-secret" },
        sources: {
          "doc-1": {
            id: "doc-1",
            revision: "3",
            contentHash: "abc123",
            available: true,
            lastSeenAt: "2026-08-24T12:00:00.000Z",
            lastDistillRunId: "run-1",
          },
        },
      },
    },
    oauthStates: {},
  };
}

describe("encrypted integration state", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-state-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("round-trips encrypted credentials without plaintext on disk", () => {
    const input = state("refresh-token");
    expect(writeIntegrationState(vault, input, KEY)).toEqual(ok(undefined));

    const encrypted = readFileSync(integrationStatePath(vault), "utf8");
    expect(encrypted).not.toContain("access-token");
    expect(encrypted).not.toContain("refresh-token");
    expect(encrypted).not.toContain("webhook-secret");
    expect(readIntegrationState(vault, KEY)).toEqual(ok(input));
  });

  it("returns an empty state when no encrypted file exists", () => {
    expect(readIntegrationState(vault, KEY)).toEqual(ok({ providers: {}, oauthStates: {} }));
  });

  it("rejects an invalid AES-256 key before reading or writing state", () => {
    const invalidKey = Buffer.alloc(31, 7);
    expect(writeIntegrationState(vault, state("refresh-token"), invalidKey).ok).toBe(false);
    expect(readIntegrationState(vault, invalidKey).ok).toBe(false);
  });

  it("resolves only canonical base64 environment keys of exactly 32 bytes", () => {
    const name = "DAFTARI_INTEGRATIONS_KEY";
    const canonical = KEY.toString("base64");
    expect(resolveIntegrationStateKey(name, { [name]: canonical })).toEqual(ok(KEY));

    // Node's base64 decoder accepts this value, but a deployment typo must not
    // silently decode to the configured key.
    expect(resolveIntegrationStateKey(name, { [name]: canonical.slice(0, -1) }).ok).toBe(false);
    expect(
      resolveIntegrationStateKey(name, { [name]: Buffer.alloc(31, 7).toString("base64") }).ok,
    ).toBe(false);
  });

  it("rejects a tampered envelope", () => {
    expect(writeIntegrationState(vault, state("refresh-token"), KEY).ok).toBe(true);
    const envelope = JSON.parse(readFileSync(integrationStatePath(vault), "utf8")) as {
      ciphertext: string;
    };
    envelope.ciphertext = `${envelope.ciphertext.startsWith("A") ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
    writeFileSync(integrationStatePath(vault), JSON.stringify(envelope), "utf8");

    const result = readIntegrationState(vault, KEY);
    expect(result.ok).toBe(false);
  });

  it("removes the temporary envelope when the atomic rename fails", () => {
    mkdirSync(integrationStatePath(vault), { recursive: true });

    expect(writeIntegrationState(vault, state("refresh-token"), KEY).ok).toBe(false);
    const entries = readdirSync(join(vault, ".daftari"));
    expect(entries.filter((entry) => /^integrations\.state\.enc\..+\.tmp$/.test(entry))).toEqual(
      [],
    );
  });
});
