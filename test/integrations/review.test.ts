import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendUnavailableReview, integrationReviewPath } from "../../src/integrations/review.js";

describe("integration unavailable review", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-review-"));
  });

  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  it("appends one event per deterministic idempotency key without touching markdown", () => {
    mkdirSync(join(vault, "claims"), { recursive: true });
    const derived = join(vault, "claims", "derived.md");
    writeFileSync(derived, "canonical derived knowledge\n");
    const event = {
      idempotencyKey: "google:doc-1:rev-1",
      providerSourceId: "google:doc-1",
      reason: "no_longer_discovered" as const,
      revision: "rev-1",
      occurredAt: "2026-08-24T12:00:00.000Z",
    };

    expect(appendUnavailableReview(vault, event).ok).toBe(true);
    expect(appendUnavailableReview(vault, event).ok).toBe(true);

    expect(existsSync(integrationReviewPath(vault))).toBe(true);
    expect(readFileSync(integrationReviewPath(vault), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(derived, "utf8")).toBe("canonical derived knowledge\n");
  });
});
