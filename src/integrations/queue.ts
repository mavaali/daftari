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

const QUEUE_VERSION = 1;
const MAX_PROCESSED_EVENT_IDS = 10_000;

export interface IntegrationQueueInput {
  provider: ProviderName;
  eventId: string;
  hint: RefreshHint;
}

export interface IntegrationQueueItem extends IntegrationQueueInput {
  enqueuedAt: string;
  attempts: number;
}

interface QueueState {
  version: typeof QUEUE_VERSION;
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
  return { version: QUEUE_VERSION, pending: [], processedEventIds: [] };
}

function itemKey(provider: ProviderName, eventId: string): string {
  return `${provider}:${eventId}`;
}

function hintKey(input: Pick<IntegrationQueueInput, "provider" | "hint">): string {
  const hint =
    input.hint.kind === "reconcile"
      ? input.hint
      : {
          ...input.hint,
          sourceIds: [...new Set(input.hint.sourceIds)].sort(),
        };
  return `${input.provider}:${JSON.stringify(hint)}`;
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

function readQueue(vaultRoot: string): Result<QueueState, Error> {
  const path = integrationQueuePath(vaultRoot);
  if (!existsSync(path)) return ok(emptyQueue());
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<QueueState>;
    if (
      parsed.version !== QUEUE_VERSION ||
      !Array.isArray(parsed.pending) ||
      !parsed.pending.every(validQueueItem) ||
      !Array.isArray(parsed.processedEventIds) ||
      !parsed.processedEventIds.every((id) => typeof id === "string")
    ) {
      return err(new Error("integration queue is malformed"));
    }
    return ok(parsed as QueueState);
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
      const read = readQueue(vaultRoot);
      if (!read.ok) return read;
      const key = itemKey(input.provider, input.eventId);
      const duplicateEvent =
        read.value.processedEventIds.includes(key) ||
        read.value.pending.some((item) => itemKey(item.provider, item.eventId) === key);
      const duplicatePendingHint = read.value.pending.some(
        (item) => hintKey(item) === hintKey(input),
      );
      if (duplicateEvent || duplicatePendingHint) return ok({ enqueued: false });
      read.value.pending.push({ ...input, enqueuedAt: now().toISOString(), attempts: 0 });
      const written = writeQueue(vaultRoot, read.value);
      return written.ok ? ok({ enqueued: true }) : err(written.error);
    },

    pending() {
      const read = readQueue(vaultRoot);
      return read.ok ? ok(read.value.pending.map((item) => ({ ...item }))) : err(read.error);
    },

    async drain(worker) {
      if (draining) return ok({ processed: 0, skipped: true });
      draining = true;
      let processed = 0;
      try {
        while (true) {
          const read = readQueue(vaultRoot);
          if (!read.ok) return read;
          const item = read.value.pending[0];
          if (item === undefined) return ok({ processed, skipped: false });
          let outcome: Result<void, Error>;
          try {
            outcome = await worker({ ...item });
          } catch {
            outcome = err(new Error("integration queue worker failed"));
          }
          if (!outcome.ok) {
            read.value.pending[0] = { ...item, attempts: item.attempts + 1 };
            const written = writeQueue(vaultRoot, read.value);
            return written.ok ? outcome : written;
          }
          read.value.pending.shift();
          read.value.processedEventIds.push(itemKey(item.provider, item.eventId));
          if (read.value.processedEventIds.length > MAX_PROCESSED_EVENT_IDS) {
            read.value.processedEventIds.splice(
              0,
              read.value.processedEventIds.length - MAX_PROCESSED_EVENT_IDS,
            );
          }
          const written = writeQueue(vaultRoot, read.value);
          if (!written.ok) return written;
          processed += 1;
        }
      } finally {
        draining = false;
      }
    },
  };
}
