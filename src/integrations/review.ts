import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { UnavailableSourceEvent } from "./engine.js";

export function integrationReviewPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "integration-review.jsonl");
}

export function appendUnavailableReview(
  vaultRoot: string,
  event: UnavailableSourceEvent,
): Result<void, Error> {
  const path = integrationReviewPath(vaultRoot);
  try {
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        const parsed = JSON.parse(line) as { idempotencyKey?: unknown };
        if (parsed.idempotencyKey === event.idempotencyKey) return ok(undefined);
      }
    }
    mkdirSync(dirname(path), { recursive: true });
    const descriptor = openSync(path, "a", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(event)}\n`, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return ok(undefined);
  } catch (cause) {
    return err(
      new Error("failed to append integration unavailable review", {
        cause: cause instanceof Error ? cause : undefined,
      }),
    );
  }
}
