// Shared HTTP transport helpers for OAuth-based provider adapters (Google,
// Microsoft, ...). Every outbound request an adapter makes to a provider's
// token/API endpoints should go through providerResponse/boundedJson (or the
// jsonResponse convenience wrapper) so every adapter gets the same bounded
// size + timeout guarantee (design §11: 30s / 8MiB) instead of each adapter
// reimplementing (or forgetting) it.
//
// Extracted from google.ts, which was the first adapter to need this; this
// module must stay behavior-preserving for google — the providerLabel
// parameter exists precisely so each adapter keeps its own exact error
// message text (some tests/engine.ts message-sniffing pin those strings).

import { timingSafeEqual } from "node:crypto";
import { err, ok, type Result } from "../frontmatter/types.js";

export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface RequestLimits {
  timeoutMilliseconds: number;
  maxResponseBytes: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// A refresh failure whose HTTP status lands in this set is a definite
// terminal signal (bad grant / consent revoked / tenant-side block). Shared
// by engine.ts's isTerminalRefreshError classifier and any adapter (e.g.
// Microsoft) that wants to attach a precise `.status`/`.terminal` signal
// instead of relying on message sniffing.
export const TERMINAL_REFRESH_STATUSES = new Set([400, 401, 403]);

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Timing-safe secret/token comparison — the single canonical implementation
// for every trust-boundary compare across the provider adapters and the
// engine (a webhook clientState/token, a manual-setup nonce, ...). An
// unequal length is rejected outright rather than passed to
// timingSafeEqual (which throws on a length mismatch), so a length-derived
// timing side channel never opens up either. Previously duplicated
// verbatim in google.ts, microsoft.ts, and engine.ts (as `equalSecret`) —
// consolidated here so a future fix to this logic only needs to land, and
// be re-verified, once.
export function timingSafeSecretEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Rejects anything but an https:// URL — every provider's webhook callback must be public HTTPS. */
export function validHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function tokenExpiration(expiresIn: unknown, now: () => Date): string | undefined {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return undefined;
  }
  return new Date(now().getTime() + expiresIn * 1000).toISOString();
}

/** Reads a Response body as JSON, bounded by size and raced against a timeout. */
export async function boundedJson(
  providerLabel: string,
  response: Response,
  limits: RequestLimits,
): Promise<Result<unknown, Error>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > limits.maxResponseBytes) {
    return err(new Error(`${providerLabel} response body is too large`));
  }
  if (response.body === null) {
    return err(new Error(`${providerLabel} returned an invalid JSON response`));
  }
  const reader = response.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async (): Promise<Result<unknown, Error>> => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > limits.maxResponseBytes) {
          await reader.cancel();
          return err(new Error(`${providerLabel} response body is too large`));
        }
        chunks.push(next.value);
      }
      const body = Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        length,
      ).toString("utf8");
      try {
        return ok(JSON.parse(body));
      } catch {
        return err(new Error(`${providerLabel} returned an invalid JSON response`));
      }
    };
    return await Promise.race([
      read(),
      new Promise<Result<unknown, Error>>((resolve) => {
        timeout = setTimeout(() => {
          void reader.cancel();
          resolve(err(new Error(`${providerLabel} request failed`)));
        }, limits.timeoutMilliseconds);
      }),
    ]);
  } catch {
    return err(new Error(`${providerLabel} request failed`));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Issues one HTTP request, racing it against limits.timeoutMilliseconds. */
export async function providerResponse(
  providerLabel: string,
  transport: HttpTransport,
  url: string,
  init: RequestInit,
  limits: RequestLimits,
): Promise<Result<Response, Error>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("deadline"));
      }, limits.timeoutMilliseconds);
    });
    const response = await Promise.race([
      transport(url, { ...init, signal: controller.signal }),
      deadline,
    ]);
    return ok(response);
  } catch {
    return err(new Error(`${providerLabel} request failed`));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Convenience wrapper for the common case: a request that only cares about a
 * successful (2xx) JSON body and folds any non-2xx status into a single
 * generic error. Adapters that need the status code or body of a non-2xx
 * response (e.g. Microsoft's refreshTokens, to attach a terminal signal)
 * should compose providerResponse + boundedJson directly instead.
 */
export async function jsonResponse(
  providerLabel: string,
  transport: HttpTransport,
  url: string,
  init: RequestInit,
  limits: RequestLimits,
): Promise<Result<unknown, Error>> {
  const fetched = await providerResponse(providerLabel, transport, url, init, limits);
  if (!fetched.ok) return fetched;
  const response = fetched.value;
  if (!response.ok) {
    return err(new Error(`${providerLabel} request failed with status ${response.status}`));
  }
  return boundedJson(providerLabel, response, limits);
}
