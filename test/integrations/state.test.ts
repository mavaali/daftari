import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "../../src/frontmatter/types.js";
import type { UnavailableSourceEvent } from "../../src/integrations/engine.js";
import {
  integrationStatePath,
  readIntegrationState,
  resolveIntegrationStateKey,
  writeIntegrationState,
} from "../../src/integrations/state.js";
import type { EnrollmentRecord, IntegrationState } from "../../src/integrations/types.js";

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

  it("rejects short or mutually exclusive webhook setup state", () => {
    const short = state("refresh-token");
    const google = short.providers.google;
    if (google === undefined) throw new Error("missing test provider");
    delete google.webhook;
    google.webhookSetupToken = "short";
    expect(writeIntegrationState(vault, short, KEY).ok).toBe(false);

    const both = state("refresh-token");
    const bothGoogle = both.providers.google;
    if (bothGoogle === undefined) throw new Error("missing test provider");
    bothGoogle.webhookSetupToken = "long-enough-setup-token";
    expect(writeIntegrationState(vault, both, KEY).ok).toBe(false);
  });

  describe("provider-neutral state extensions (U2)", () => {
    const enrollment: EnrollmentRecord = {
      id: "enrollment-1",
      kind: "item",
      driveId: "drive-1",
      remoteId: "remote-1",
      label: "Quarterly plan.docx",
      webUrl: "https://example.sharepoint.com/quarterly-plan.docx",
      collection: "work",
      includeSpeakerNotes: false,
      enrolledBy: "mihir",
      enrolledAt: "2026-09-01T12:00:00.000Z",
      audienceAckAt: "2026-09-01T12:00:00.000Z",
      readersAtEnrollment: ["mihir@example.com"],
      cursorKey: "quarterly-plan",
    };

    function stateWithExtensions(): IntegrationState {
      const base = state("refresh-token");
      const google = base.providers.google;
      if (google === undefined) throw new Error("missing test provider");
      google.enrollments = { [enrollment.id]: enrollment };
      google.account = {
        id: "account-1",
        tenantId: "tenant-1",
        displayName: "Mihir Wagle",
        upn: "mihir@example.com",
      };
      google.authorization = { status: "reconnect_required", at: "2026-09-01T12:00:00.000Z" };
      const source = google.sources["doc-1"];
      if (source === undefined) throw new Error("missing test source");
      source.enrollmentId = enrollment.id;
      source.lastFailure = { at: "2026-09-01T12:00:00.000Z", reason: "too_large" };
      return base;
    }

    it("round-trips enrollments, account, and authorization through the encrypted envelope", () => {
      const input = stateWithExtensions();
      expect(writeIntegrationState(vault, input, KEY)).toEqual(ok(undefined));
      expect(readIntegrationState(vault, KEY)).toEqual(ok(input));
    });

    it("parses a pre-existing envelope with none of the new fields (backward compatibility)", () => {
      const input = state("refresh-token");
      expect(writeIntegrationState(vault, input, KEY)).toEqual(ok(undefined));

      const result = readIntegrationState(vault, KEY);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected parse to succeed");
      const google = result.value.providers.google;
      if (google === undefined) throw new Error("missing test provider");
      expect(google.enrollments).toBeUndefined();
      expect(google.account).toBeUndefined();
      expect(google.authorization).toBeUndefined();
      expect(google.sources["doc-1"]?.enrollmentId).toBeUndefined();
      expect(google.sources["doc-1"]?.lastFailure).toBeUndefined();
    });

    it("rejects a malformed authorization.status", () => {
      const input = stateWithExtensions();
      const google = input.providers.google;
      if (google === undefined) throw new Error("missing test provider");
      // @ts-expect-error intentionally malformed for the validator test
      google.authorization = { status: "maybe", at: "2026-09-01T12:00:00.000Z" };
      expect(writeIntegrationState(vault, input, KEY).ok).toBe(false);
    });

    it("round-trips a webhook channel with subscriptions and an unenrolled unavailable event reason", () => {
      const input = stateWithExtensions();
      const google = input.providers.google;
      if (google === undefined) throw new Error("missing test provider");
      google.webhook = {
        id: "channel-1",
        secret: "webhook-secret",
        subscriptions: [
          { id: "sub-1", resource: "drive-1/root", expiresAt: "2026-09-08T00:00:00.000Z" },
        ],
      };
      expect(writeIntegrationState(vault, input, KEY)).toEqual(ok(undefined));
      expect(readIntegrationState(vault, KEY)).toEqual(ok(input));

      const event: UnavailableSourceEvent = {
        idempotencyKey: "key-1",
        providerSourceId: "doc-1",
        reason: "unenrolled",
        revision: "3",
        occurredAt: "2026-09-01T12:00:00.000Z",
      };
      expect(event.reason).toBe("unenrolled");
    });
  });
});
