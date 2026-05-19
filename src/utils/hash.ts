// SHA-256 content hashing.
//
// Used to derive version tokens for optimistic concurrency: vault_read hands a
// caller the hash of the file as read, and the write path rejects a write
// whose declared base_version no longer matches what is on disk.

import { createHash } from "node:crypto";

// Hex-encoded SHA-256 of `text`. Pure — same input always yields the same hash.
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}
