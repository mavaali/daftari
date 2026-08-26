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
      await recovered.drain(async (batch) => {
        seen.push(...batch.items.map((item) => item.eventId));
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

  it("preserves a durably enqueued event that arrives while another item is draining", async () => {
    const queue = createIntegrationQueue(vault);
    expect(
      queue.enqueue({ provider: "google", eventId: "evt-a", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: true }));
    let release: (() => void) | undefined;
    const draining = queue.drain(async (batch) => {
      if (batch.items.some((item) => item.eventId === "evt-a")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return ok(undefined);
      }
      return err(new Error("leave successor pending"));
    });
    await Promise.resolve();
    expect(
      queue.enqueue({ provider: "google", eventId: "evt-b", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: true }));
    release?.();
    expect(await draining).toEqual(ok({ processed: 1, skipped: false }));
    expect(queue.pending()).toEqual(ok([expect.objectContaining({ eventId: "evt-b" })]));
  });

  it("does not erase distinct accepted events merely because their hints match", () => {
    const queue = createIntegrationQueue(vault);
    expect(
      queue.enqueue({ provider: "notion", eventId: "evt-1", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: true }));
    expect(
      queue.enqueue({ provider: "notion", eventId: "evt-2", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: true }));
    expect(queue.pending().ok && queue.pending().value).toHaveLength(2);
  });

  it("coalesces ten thousand provider events into one bounded durable batch", async () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      integrationQueuePath(vault),
      JSON.stringify({
        version: 2,
        pending: Array.from({ length: 10_000 }, (_, index) => ({
          provider: "google",
          eventId: `evt-${index}`,
          hint: { kind: "reconcile" },
          enqueuedAt: "2026-08-24T12:00:00.000Z",
          attempts: 0,
        })),
        processedEvents: [],
      }),
    );
    const queue = createIntegrationQueue(vault, () => new Date("2026-08-25T12:00:00.000Z"));
    let calls = 0;
    const drained = await queue.drain(async (batch) => {
      calls += 1;
      expect(batch.provider).toBe("google");
      expect(batch.items).toHaveLength(10_000);
      return ok(undefined);
    });

    expect(drained).toEqual(ok({ processed: 10_000, skipped: false }));
    expect(calls).toBe(1);
    const raw = readFileSync(integrationQueuePath(vault), "utf8");
    const durable = JSON.parse(raw) as { pending: unknown[]; processedEvents: unknown[] };
    expect(durable.pending).toEqual([]);
    expect(durable.processedEvents).toHaveLength(10_000);
    expect(raw.length).toBeLessThan(1_500_000);
  });

  it("retains a fatal provider batch without starving a later provider batch", async () => {
    const queue = createIntegrationQueue(vault);
    queue.enqueue({ provider: "google", eventId: "google-poison", hint: { kind: "reconcile" } });
    queue.enqueue({ provider: "notion", eventId: "notion-later", hint: { kind: "reconcile" } });
    const seen: string[] = [];

    const drained = await queue.drain(async (batch) => {
      seen.push(batch.provider);
      return batch.provider === "google" ? err(new Error("provider offline")) : ok(undefined);
    });

    expect(drained.ok).toBe(false);
    expect(seen).toEqual(["google", "notion"]);
    expect(queue.pending()).toEqual(
      ok([expect.objectContaining({ provider: "google", eventId: "google-poison", attempts: 1 })]),
    );
    expect(
      queue.enqueue({ provider: "notion", eventId: "notion-later", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: false }));
  });

  it("bounds fatal provider delivery retries and tombstones the exhausted event", async () => {
    const queue = createIntegrationQueue(vault);
    expect(
      queue.enqueue({ provider: "google", eventId: "fatal-event", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: true }));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await queue.drain(async () => err(new Error("provider offline")))).ok).toBe(false);
    }

    expect(queue.pending()).toEqual(ok([]));
    expect(
      queue.enqueue({ provider: "google", eventId: "fatal-event", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: false }));
  });

  it("retains replay tombstones beyond ten thousand events for a bounded thirty-day horizon", () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    const processedAt = "2026-08-24T12:00:00.000Z";
    writeFileSync(
      integrationQueuePath(vault),
      JSON.stringify({
        version: 2,
        pending: [],
        processedEvents: Array.from({ length: 10_001 }, (_, index) => ({
          key: `notion:evt-${index}`,
          processedAt,
        })),
      }),
    );
    const queue = createIntegrationQueue(vault, () => new Date("2026-08-25T12:00:00.000Z"));
    expect(
      queue.enqueue({ provider: "notion", eventId: "evt-0", hint: { kind: "reconcile" } }),
    ).toEqual(ok({ enqueued: false }));
  });

  it("reports a malformed durable queue instead of treating it as empty", () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(integrationQueuePath(vault), "not-json\n");
    const queue = createIntegrationQueue(vault);
    expect(queue.pending().ok).toBe(false);
  });
});
