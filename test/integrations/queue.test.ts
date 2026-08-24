import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err, ok } from "../../src/frontmatter/types.js";
import { createIntegrationQueue, integrationQueuePath } from "../../src/integrations/queue.js";

describe("durable integration queue", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-integration-queue-"));
  });

  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  it("durably deduplicates event IDs without persisting source text", () => {
    const queue = createIntegrationQueue(vault, () => new Date("2026-08-24T12:00:00.000Z"));
    const item = {
      provider: "google" as const,
      eventId: "message-7",
      hint: { kind: "reconcile" as const },
    };

    expect(queue.enqueue(item)).toEqual(ok({ enqueued: true }));
    expect(queue.enqueue(item)).toEqual(ok({ enqueued: false }));
    const raw = readFileSync(integrationQueuePath(vault), "utf8");
    expect(raw).toContain("message-7");
    expect(raw).not.toContain("source text");
    expect(queue.pending()).toEqual(ok([expect.objectContaining({ eventId: "message-7" })]));
  });

  it("retains failed items across queue recreation and drains them after recovery", async () => {
    const first = createIntegrationQueue(vault);
    first.enqueue({ provider: "notion", eventId: "evt-1", hint: { kind: "reconcile" } });
    expect((await first.drain(async () => err(new Error("offline")))).ok).toBe(false);

    const recovered = createIntegrationQueue(vault);
    expect(recovered.pending().ok && recovered.pending().value).toHaveLength(1);
    const seen: string[] = [];
    expect(
      await recovered.drain(async (item) => {
        seen.push(item.eventId);
        return ok(undefined);
      }),
    ).toEqual(ok({ processed: 1, skipped: false }));
    expect(seen).toEqual(["evt-1"]);
    expect(recovered.pending()).toEqual(ok([]));
    expect(
      recovered.enqueue({ provider: "notion", eventId: "evt-1", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: false }));
  });

  it("prevents overlapping drains", async () => {
    const queue = createIntegrationQueue(vault);
    queue.enqueue({ provider: "google", eventId: "evt-1", hint: { kind: "reconcile" } });
    let release: (() => void) | undefined;
    const blocked = queue.drain(
      () => new Promise((resolve) => (release = () => resolve(ok(undefined)))),
    );
    await Promise.resolve();
    expect(await queue.drain(async () => ok(undefined))).toEqual(
      ok({ processed: 0, skipped: true }),
    );
    release?.();
    expect(await blocked).toEqual(ok({ processed: 1, skipped: false }));
  });

  it("reports a malformed durable queue instead of treating it as empty", () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(integrationQueuePath(vault), "not-json\n");
    const queue = createIntegrationQueue(vault);
    expect(queue.pending().ok).toBe(false);
  });
});
