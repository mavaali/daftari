import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { RefreshHint } from "./engine.js";
import type { ProviderName } from "./types.js";

const QUEUE_VERSION = 2;
const REPLAY_HORIZON_MS = 30 * 24 * 60 * 60 * 1_000;

export interface IntegrationQueueInput {
  provider: ProviderName;
  eventId: string;
  hint: RefreshHint;
}

export interface IntegrationQueueItem extends IntegrationQueueInput {
  enqueuedAt: string;
  attempts: number;
}

interface ProcessedEvent {
  key: string;
  processedAt: string;
}

interface QueueState {
  version: typeof QUEUE_VERSION;
  pending: IntegrationQueueItem[];
  processedEvents: ProcessedEvent[];
}

interface LegacyQueueState {
  version: 1;
  pending: IntegrationQueueItem[];
  processedEventIds: string[];
}

export interface IntegrationQueue {
  enqueue(input: IntegrationQueueInput): Result<{ enqueued: boolean }, Error>;
  pending(): Result<IntegrationQueueItem[], Error>;
  drain(
    worker: (item: IntegrationQueueItem) => Promise<Result<void, Error>>,
  ): Promise<Result<{ processed: number; skipped: boolean }, Error>>;
}

export function integrationQueuePath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "integration-queue.json");
}

function emptyQueue(): QueueState {
  return { version: QUEUE_VERSION, pending: [], processedEvents: [] };
}

function itemKey(provider: ProviderName, eventId: string): string {
  return `${provider}:${eventId}`;
}

function validHint(value: unknown): value is RefreshHint {
  if (typeof value !== "object" || value === null) return false;
  const hint = value as Record<string, unknown>;
  if (hint.kind === "reconcile") return true;
  return (
    hint.kind === "sources" &&
    Array.isArray(hint.sourceIds) &&
    hint.sourceIds.every((id) => typeof id === "string" && id.length > 0) &&
    typeof hint.rediscover === "boolean"
  );
}

function validQueueItem(value: unknown): value is IntegrationQueueItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    (item.provider === "google" || item.provider === "notion") &&
    typeof item.eventId === "string" &&
    item.eventId.length > 0 &&
    validHint(item.hint) &&
    typeof item.enqueuedAt === "string" &&
    typeof item.attempts === "number" &&
    Number.isInteger(item.attempts) &&
    item.attempts >= 0
  );
}

function validProcessedEvent(value: unknown): value is ProcessedEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.key === "string" &&
    event.key.length > 0 &&
    typeof event.processedAt === "string" &&
    Number.isFinite(Date.parse(event.processedAt))
  );
}

function pruneProcessedEvents(state: QueueState, now: Date): QueueState {
  const cutoff = now.getTime() - REPLAY_HORIZON_MS;
  return {
    ...state,
    processedEvents: state.processedEvents.filter(
      (event) => Date.parse(event.processedAt) >= cutoff,
    ),
  };
}

function readQueue(vaultRoot: string, now: () => Date): Result<QueueState, Error> {
  const path = integrationQueuePath(vaultRoot);
  if (!existsSync(path)) return ok(emptyQueue());
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!Array.isArray(parsed.pending) || !parsed.pending.every(validQueueItem)) {
      return err(new Error("integration queue is malformed"));
    }
    if (
      parsed.version === QUEUE_VERSION &&
      Array.isArray(parsed.processedEvents) &&
      parsed.processedEvents.every(validProcessedEvent)
    ) {
      return ok(pruneProcessedEvents(parsed as unknown as QueueState, now()));
    }
    if (
      parsed.version === 1 &&
      Array.isArray(parsed.processedEventIds) &&
      parsed.processedEventIds.every((id) => typeof id === "string" && id.length > 0)
    ) {
      const migratedAt = now().toISOString();
      const legacy = parsed as unknown as LegacyQueueState;
      return ok({
        version: QUEUE_VERSION,
        pending: legacy.pending,
        processedEvents: legacy.processedEventIds.map((key) => ({ key, processedAt: migratedAt })),
      });
    }
    return err(new Error("integration queue is malformed"));
  } catch (cause) {
    return err(new Error("failed to read integration queue", { cause }));
  }
}

function writeQueue(vaultRoot: string, state: QueueState): Result<void, Error> {
  const path = integrationQueuePath(vaultRoot);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(descriptor, `${JSON.stringify(state)}\n`, undefined, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return ok(undefined);
  } catch (cause) {
    return err(new Error("failed to write integration queue", { cause }));
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } catch {
      // Preserve the primary write error; the unique temp path is ignored.
    }
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Best-effort cleanup; startup ignores and later writes never reuse it.
    }
  }
}

export function createIntegrationQueue(
  vaultRoot: string,
  now: () => Date = () => new Date(),
): IntegrationQueue {
  let draining = false;

  return {
    enqueue(input) {
      if (input.eventId.length === 0 || !validHint(input.hint)) {
        return err(new Error("integration queue item is invalid"));
      }
      const read = readQueue(vaultRoot, now);
      if (!read.ok) return read;
      const key = itemKey(input.provider, input.eventId);
      const duplicateEvent =
        read.value.processedEvents.some((event) => event.key === key) ||
        read.value.pending.some((item) => itemKey(item.provider, item.eventId) === key);
      if (duplicateEvent) return ok({ enqueued: false });
      read.value.pending.push({ ...input, enqueuedAt: now().toISOString(), attempts: 0 });
      const written = writeQueue(vaultRoot, read.value);
      return written.ok ? ok({ enqueued: true }) : err(written.error);
    },

    pending() {
      const read = readQueue(vaultRoot, now);
      return read.ok ? ok(read.value.pending.map((item) => ({ ...item }))) : err(read.error);
    },

    async drain(worker) {
      if (draining) return ok({ processed: 0, skipped: true });
      draining = true;
      let processed = 0;
      try {
        while (true) {
          const read = readQueue(vaultRoot, now);
          if (!read.ok) return read;
          const item = read.value.pending[0];
          if (item === undefined) return ok({ processed, skipped: false });
          let outcome: Result<void, Error>;
          try {
            outcome = await worker({ ...item });
          } catch {
            outcome = err(new Error("integration queue worker failed"));
          }
          const fresh = readQueue(vaultRoot, now);
          if (!fresh.ok) return fresh;
          const key = itemKey(item.provider, item.eventId);
          const freshIndex = fresh.value.pending.findIndex(
            (candidate) => itemKey(candidate.provider, candidate.eventId) === key,
          );
          if (freshIndex === -1) {
            return err(new Error("integration queue item disappeared during drain"));
          }
          if (!outcome.ok) {
            fresh.value.pending[freshIndex] = {
              ...fresh.value.pending[freshIndex],
              attempts: fresh.value.pending[freshIndex].attempts + 1,
            };
            const written = writeQueue(vaultRoot, fresh.value);
            return written.ok ? outcome : written;
          }
          fresh.value.pending.splice(freshIndex, 1);
          fresh.value.processedEvents.push({ key, processedAt: now().toISOString() });
          const written = writeQueue(vaultRoot, pruneProcessedEvents(fresh.value, now()));
          if (!written.ok) return written;
          processed += 1;
        }
      } finally {
        draining = false;
      }
    },
  };
}
