import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { canWrite } from "../access/rbac.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { RoleConfig } from "../utils/config.js";
import type {
  EngineDeps,
  EnrollmentContext,
  ProviderAdapter,
  ProviderStatus,
  UnavailableSourceEvent,
  WebhookRequest,
} from "./engine.js";
import {
  armProviderWebhookSetup,
  confirmProviderWebhookVerification,
  readProviderWebhookVerificationToken,
  verifyProviderLifecycleWebhook,
  verifyProviderWebhook,
} from "./engine.js";
import { beginAuthorizationRedirect, completeAuthorization } from "./oauth.js";
import type { IntegrationQueue } from "./queue.js";
import { appendUnavailableReview } from "./review.js";
import {
  readIntegrationState,
  resolveIntegrationStateKey,
  withIntegrationStateLock,
  writeIntegrationState,
} from "./state.js";
import {
  type EnrollmentRecord,
  type IntegrationConfig,
  PROVIDER_NAMES,
  type ProviderName,
} from "./types.js";

const DEFAULT_WEBHOOK_BODY_LIMIT = 256 * 1024;
const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 10_000;

export interface IntegrationRouteAuthorization {
  cookieAuthenticated: boolean;
  canManageIntegrations: boolean;
  /** U19: the resolved caller identity, for enrollment routes' collection-allowlist + canWrite gate. */
  user: string;
  role: RoleConfig | null;
  /** U19: the caller's role NAME (as opposed to its resolved RoleConfig above) — EnrollmentContext.role is a plain string. */
  roleName: string;
}

export interface IntegrationRouteLastOutcome {
  at: string;
  outcome: {
    distilledSourceIds: string[];
    unchangedSourceIds: string[];
    failedSourceIds: string[];
    unavailableSourceIds: string[];
  };
}

export interface IntegrationRouteDependencies {
  vaultRoot: string;
  config: IntegrationConfig;
  environment: NodeJS.ProcessEnv;
  adapters: Partial<Record<ProviderName, ProviderAdapter>>;
  engineDeps: EngineDeps;
  queue: IntegrationQueue;
  publicBaseUrl?: string;
  authorize(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<IntegrationRouteAuthorization | null>;
  /** Admits an unauthenticated callback/webhook before body or state work. */
  admitPublic(request: IncomingMessage, response: ServerResponse): (() => void) | null;
  checkCsrf(request: IncomingMessage): string | null;
  maxWebhookBodyBytes?: number;
  webhookBodyTimeoutMs?: number;
  wake?: () => void;
  /** R36: the runtime's last-cycle summary for a provider, merged into the /status response. */
  lastOutcome?(provider: ProviderName): IntegrationRouteLastOutcome | undefined;
  /**
   * U19 follow-up: the runtime's existing error-surfacing channel (the same
   * `onError` a reconcile cycle logs through). Used so a failed unenroll
   * review-event write is surfaced rather than silently dropped — the
   * enrollment removal itself still succeeds; only the audit write's failure
   * needs somewhere to go.
   */
  onError?: (message: string) => void;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const PROVIDER_ROUTE_PATTERN = new RegExp(`^/integrations/(${PROVIDER_NAMES.join("|")})(?:/|$)`);

export function providerFrom(pathname: string): ProviderName | null {
  const matched = PROVIDER_ROUTE_PATTERN.exec(pathname);
  return matched === null ? null : (matched[1] as ProviderName);
}

function nodeHeaders(request: IncomingMessage): WebhookRequest["headers"] {
  const headers: WebhookRequest["headers"] = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name] = value;
  return headers;
}

function readBoundedBody(
  request: IncomingMessage,
  limit: number,
  timeoutMs: number,
): Promise<Result<Uint8Array, Error>> {
  return new Promise((resolve) => {
    const contentLength = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(contentLength) && contentLength > limit) {
      request.resume();
      resolve(err(new Error("request body is too large")));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: Result<Uint8Array, Error>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      request.resume();
      finish(err(new Error("request body timed out")));
    }, timeoutMs);
    timer.unref();
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        if (settled) return;
        finish(err(new Error("request body is too large")));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      finish(ok(Buffer.concat(chunks)));
    });
    request.on("error", () => {
      if (settled) return;
      finish(err(new Error("request body could not be read")));
    });
  });
}

async function requireAuthorization(
  request: IncomingMessage,
  response: ServerResponse,
  deps: IntegrationRouteDependencies,
  csrfProtected: boolean,
): Promise<IntegrationRouteAuthorization | null> {
  const authorized = await deps.authorize(request, response);
  if (authorized === null) return null;
  if (!authorized.canManageIntegrations) {
    writeJson(response, 403, { error: "forbidden" });
    return null;
  }
  if (csrfProtected && authorized.cookieAuthenticated) {
    const csrfError = deps.checkCsrf(request);
    if (csrfError !== null) {
      writeJson(response, 403, { error: "forbidden", message: csrfError });
      return null;
    }
  }
  return authorized;
}

const DEFAULT_ENROLLMENT_BODY_LIMIT = 1024 * 1024;
const DEFAULT_ENROLLMENT_BODY_TIMEOUT_MS = 10_000;

async function readJsonBody(
  request: IncomingMessage,
  limit: number,
  timeoutMs: number,
): Promise<Result<unknown, Error>> {
  const body = await readBoundedBody(request, limit, timeoutMs);
  if (!body.ok) return body;
  try {
    return ok(JSON.parse(Buffer.from(body.value).toString("utf8")) as unknown);
  } catch {
    return err(new Error("request body is not valid JSON"));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only Microsoft's provider config carries a `collections` enrollment
// allowlist (R33/R39) — Google/Notion never implement resolveEnrollment, so
// their providerConfig[provider] simply yields an empty allowlist here (moot,
// since those routes 404 on the missing-capability check before this is read).
function collectionAllowlist(config: IntegrationConfig, provider: ProviderName): string[] {
  const providerConfig = config[provider] as { collections?: string[] } | undefined;
  return providerConfig?.collections ?? [];
}

function includeSpeakerNotesDefault(config: IntegrationConfig, provider: ProviderName): boolean {
  const providerConfig = config[provider] as { includeSpeakerNotes?: boolean } | undefined;
  return providerConfig?.includeSpeakerNotes ?? true;
}

interface ParsedEnrollmentRequest {
  body: Record<string, unknown>;
  collection: string;
  includeSpeakerNotes: boolean;
}

// Shared by preview and the full enroll POST (U19 follow-up): parse the JSON
// body, then apply the two gates every enrollment route needs regardless of
// whether it persists — the collection allowlist (422) and canWrite (403).
// Writes the rejection response itself and returns null on any failure, so a
// caller only has to check for that.
async function parseEnrollmentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: IntegrationRouteDependencies,
  provider: ProviderName,
  authorized: IntegrationRouteAuthorization,
): Promise<ParsedEnrollmentRequest | null> {
  const parsedBody = await readJsonBody(
    request,
    DEFAULT_ENROLLMENT_BODY_LIMIT,
    DEFAULT_ENROLLMENT_BODY_TIMEOUT_MS,
  );
  if (!parsedBody.ok) {
    writeJson(response, 400, { error: "invalid_request", message: parsedBody.error.message });
    return null;
  }
  const body = isRecord(parsedBody.value) ? parsedBody.value : {};
  const collection = typeof body.collection === "string" ? body.collection : undefined;
  if (
    collection === undefined ||
    !collectionAllowlist(deps.config, provider).includes(collection)
  ) {
    writeJson(response, 422, { error: "collection_not_allowed" });
    return null;
  }
  if (!canWrite(authorized.role, collection)) {
    writeJson(response, 403, { error: "forbidden" });
    return null;
  }
  const includeSpeakerNotes =
    typeof body.includeSpeakerNotes === "boolean"
      ? body.includeSpeakerNotes
      : includeSpeakerNotesDefault(deps.config, provider);
  return { body, collection, includeSpeakerNotes };
}

export async function handleIntegrationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deps: IntegrationRouteDependencies,
): Promise<boolean> {
  if (!url.pathname.startsWith("/integrations/")) return false;
  const provider = providerFrom(url.pathname);
  if (provider === null) {
    writeJson(response, 404, { error: "not_found" });
    return true;
  }
  const adapter = deps.adapters[provider];
  if (adapter === undefined) {
    writeJson(response, 404, { error: "not_found" });
    return true;
  }

  if (url.pathname === `/integrations/${provider}/connect`) {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!(await requireAuthorization(request, response, deps, true))) return true;
    const started = await beginAuthorizationRedirect(
      deps.vaultRoot,
      adapter,
      deps.config,
      deps.environment,
    );
    if (!started.ok) {
      writeJson(response, 503, { error: "integration_unavailable" });
      return true;
    }
    response.writeHead(302, { location: started.value.url, "cache-control": "no-store" });
    response.end();
    return true;
  }

  if (url.pathname === `/integrations/${provider}/callback`) {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    const release = deps.admitPublic(request, response);
    if (release === null) return true;
    try {
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      const completed = await completeAuthorization(
        deps.vaultRoot,
        provider,
        state,
        code,
        deps.engineDeps,
      );
      if (!completed.ok) {
        writeJson(response, 400, { error: "oauth_callback_rejected" });
        return true;
      }
      writeJson(response, 200, { connected: true, provider });
      deps.wake?.();
      return true;
    } finally {
      release();
    }
  }

  if (url.pathname === `/integrations/${provider}/webhook/setup`) {
    if (adapter.webhookSetup !== "manual") {
      writeJson(response, 404, { error: "not_found" });
      return true;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!(await requireAuthorization(request, response, deps, true))) return true;
    if (deps.publicBaseUrl === undefined) {
      writeJson(response, 409, { error: "public_webhook_url_required" });
      return true;
    }
    const armed = await armProviderWebhookSetup(deps.vaultRoot, provider, deps.engineDeps);
    if (!armed.ok) {
      writeJson(response, 409, { error: "webhook_setup_unavailable" });
      return true;
    }
    const callback = new URL(
      `${deps.publicBaseUrl.replace(/\/$/, "")}/integrations/${provider}/webhook`,
    );
    callback.searchParams.set("setup_token", armed.value.setupToken);
    writeJson(response, 200, { provider, callbackUrl: callback.toString() });
    return true;
  }

  if (url.pathname === `/integrations/${provider}/webhook/verification`) {
    if (adapter.webhookSetup !== "manual") {
      writeJson(response, 404, { error: "not_found" });
      return true;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!(await requireAuthorization(request, response, deps, true))) return true;
    const verification = readProviderWebhookVerificationToken(
      deps.vaultRoot,
      provider,
      deps.engineDeps,
    );
    if (!verification.ok) {
      writeJson(response, 404, { error: "verification_not_pending" });
      return true;
    }
    writeJson(response, 200, {
      provider,
      verificationToken: verification.value.verificationToken,
    });
    return true;
  }

  if (url.pathname === `/integrations/${provider}/webhook/verification/confirm`) {
    if (adapter.webhookSetup !== "manual") {
      writeJson(response, 404, { error: "not_found" });
      return true;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!(await requireAuthorization(request, response, deps, true))) return true;
    const confirmed = await confirmProviderWebhookVerification(
      deps.vaultRoot,
      provider,
      deps.engineDeps,
    );
    if (!confirmed.ok) {
      writeJson(response, 409, { error: "verification_not_pending" });
      return true;
    }
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  if (url.pathname === `/integrations/${provider}/webhook`) {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    const release = deps.admitPublic(request, response);
    if (release === null) return true;
    try {
      const body = await readBoundedBody(
        request,
        deps.maxWebhookBodyBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT,
        deps.webhookBodyTimeoutMs ?? DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
      );
      if (!body.ok) {
        const timedOut = body.error.message === "request body timed out";
        writeJson(response, timedOut ? 408 : 413, {
          error: timedOut ? "request_timeout" : "payload_too_large",
        });
        return true;
      }
      const webhookRequest: WebhookRequest = {
        headers: nodeHeaders(request),
        body: body.value,
        query: Object.fromEntries(url.searchParams),
        ...(url.searchParams.get("setup_token") === null
          ? {}
          : { setupToken: url.searchParams.get("setup_token") as string }),
      };
      // R16: a provider's webhook validation challenge is answered directly,
      // ahead of signature verification — it never touches state or the
      // durable queue.
      if (adapter.answerWebhookChallenge !== undefined) {
        const challenge = adapter.answerWebhookChallenge(webhookRequest);
        if (challenge !== undefined) {
          response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
          response.end(challenge);
          return true;
        }
      }
      const verified = await verifyProviderWebhook(
        deps.vaultRoot,
        adapter,
        webhookRequest,
        deps.engineDeps,
      );
      if (!verified.ok) {
        writeJson(response, 401, { error: "webhook_rejected" });
        return true;
      }
      if (verified.value.kind === "verification") {
        writeJson(response, 200, { verificationReceived: true });
        return true;
      }
      if (verified.value.kind === "lifecycle") {
        const queued = deps.queue.enqueue({
          provider,
          eventId: verified.value.eventId,
          hint: { kind: "lifecycle", action: verified.value.action },
        });
        if (!queued.ok) {
          writeJson(response, 503, { error: "queue_unavailable" });
          return true;
        }
        writeJson(response, 202, { accepted: true });
        deps.wake?.();
        return true;
      }
      const queued = deps.queue.enqueue({
        provider,
        eventId: verified.value.eventId,
        hint: verified.value.hint,
      });
      if (!queued.ok) {
        writeJson(response, 503, { error: "queue_unavailable" });
        return true;
      }
      writeJson(response, 202, { accepted: true });
      deps.wake?.();
      return true;
    } finally {
      release();
    }
  }

  if (url.pathname === `/integrations/${provider}/webhook/lifecycle`) {
    if (adapter.verifyLifecycleWebhook === undefined) {
      writeJson(response, 404, { error: "not_found" });
      return true;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    const release = deps.admitPublic(request, response);
    if (release === null) return true;
    try {
      const body = await readBoundedBody(
        request,
        deps.maxWebhookBodyBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT,
        deps.webhookBodyTimeoutMs ?? DEFAULT_WEBHOOK_BODY_TIMEOUT_MS,
      );
      if (!body.ok) {
        const timedOut = body.error.message === "request body timed out";
        writeJson(response, timedOut ? 408 : 413, {
          error: timedOut ? "request_timeout" : "payload_too_large",
        });
        return true;
      }
      const verified = await verifyProviderLifecycleWebhook(
        deps.vaultRoot,
        adapter,
        {
          headers: nodeHeaders(request),
          body: body.value,
          query: Object.fromEntries(url.searchParams),
        },
        deps.engineDeps,
      );
      if (!verified.ok) {
        writeJson(response, 401, { error: "webhook_rejected" });
        return true;
      }
      // R18 (route side): the verified lifecycle notification is durably
      // enqueued through the same queue the change-notification path uses,
      // carrying its `action` unchanged — dispatch on that action is a later
      // task's concern (U16), not this route's.
      const queued = deps.queue.enqueue({
        provider,
        eventId: verified.value.eventId,
        hint: { kind: "lifecycle", action: verified.value.action },
      });
      if (!queued.ok) {
        writeJson(response, 503, { error: "queue_unavailable" });
        return true;
      }
      writeJson(response, 202, { accepted: true });
      deps.wake?.();
      return true;
    } finally {
      release();
    }
  }

  // U19: enrollment/status routes (R10, R13, R14, R33, R36, R39). Provider-
  // neutral — Google/Notion never implement resolveEnrollment/
  // estimateEnrollment/describeStatus, so these 404 for them before any
  // authorization work happens, exactly like the webhookSetup/
  // verifyLifecycleWebhook capability checks above.
  if (url.pathname === `/integrations/${provider}/enrollments/preview`) {
    if (adapter.resolveEnrollment === undefined || adapter.estimateEnrollment === undefined) {
      writeJson(response, 404, { error: "not_found" });
      return true;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    const authorized = await requireAuthorization(request, response, deps, true);
    if (authorized === null) return true;

    const parsed = await parseEnrollmentRequest(request, response, deps, provider, authorized);
    if (parsed === null) return true;
    const { body, collection, includeSpeakerNotes } = parsed;

    const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
    if (!key.ok) {
      writeJson(response, 500, { error: "internal" });
      return true;
    }
    const persisted = readIntegrationState(deps.vaultRoot, key.value);
    if (!persisted.ok) {
      writeJson(response, 500, { error: "internal" });
      return true;
    }
    const providerState = persisted.value.providers[provider];
    if (providerState === undefined) {
      writeJson(response, 409, { error: "provider_not_connected" });
      return true;
    }

    const ctx: EnrollmentContext = {
      user: authorized.user,
      role: authorized.roleName,
      collection,
      includeSpeakerNotes,
    };
    const draft = await adapter.resolveEnrollment(body.selection, providerState, ctx);
    if (!draft.ok) {
      writeJson(response, 422, { error: "enrollment_rejected", message: draft.error.message });
      return true;
    }
    const estimate = await adapter.estimateEnrollment(draft.value, providerState);
    if (!estimate.ok) {
      writeJson(response, 422, { error: "enrollment_rejected", message: estimate.error.message });
      return true;
    }
    writeJson(response, 200, estimate.value);
    return true;
  }

  if (url.pathname === `/integrations/${provider}/enrollments`) {
    const resolveEnrollment = adapter.resolveEnrollment;
    if (resolveEnrollment === undefined) {
      writeJson(response, 404, { error: "not_found" });
      return true;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    const authorized = await requireAuthorization(request, response, deps, true);
    if (authorized === null) return true;

    const parsed = await parseEnrollmentRequest(request, response, deps, provider, authorized);
    if (parsed === null) return true;
    const { body, collection, includeSpeakerNotes } = parsed;
    // R33: the audience ACL disclosure must be explicitly acknowledged by the
    // enrolling caller — never inferred from the request merely existing.
    if (body.acknowledged !== true) {
      writeJson(response, 422, { error: "acknowledgement_required" });
      return true;
    }

    const selection = body.selection;

    const created = await withIntegrationStateLock(deps.vaultRoot, async () => {
      const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
      if (!key.ok) return key;
      const persisted = readIntegrationState(deps.vaultRoot, key.value);
      if (!persisted.ok) return persisted;
      const providerState = persisted.value.providers[provider];
      if (providerState === undefined) {
        return err(new Error("provider is not connected"));
      }
      const ctx: EnrollmentContext = {
        user: authorized.user,
        role: authorized.roleName,
        collection,
        includeSpeakerNotes,
      };
      const draft = await resolveEnrollment(selection, providerState, ctx);
      if (!draft.ok) return draft;

      const now = deps.engineDeps.now?.() ?? new Date();
      const nowIso = now.toISOString();
      const records: EnrollmentRecord[] = draft.value.items.map((item) => {
        const id = randomUUID();
        return {
          id,
          kind: item.kind,
          driveId: item.driveId,
          remoteId: item.remoteId,
          label: item.label,
          ...(item.webUrl === undefined ? {} : { webUrl: item.webUrl }),
          collection: draft.value.collection,
          includeSpeakerNotes: draft.value.includeSpeakerNotes,
          enrolledBy: authorized.user,
          enrolledAt: nowIso,
          audienceAckAt: nowIso,
          readersAtEnrollment: draft.value.readersAtEnrollment,
          // §7.1 cursorKey convention: one container enrollment is its own
          // delta root; item enrollments sharing a drive share one root.
          cursorKey: item.kind === "container" ? `enrollment:${id}` : `drive:${item.driveId}`,
        };
      });
      const enrollments = { ...(providerState.enrollments ?? {}) };
      for (const record of records) enrollments[record.id] = record;
      persisted.value.providers[provider] = { ...providerState, enrollments };
      const written = writeIntegrationState(deps.vaultRoot, persisted.value, key.value);
      if (!written.ok) return written;
      return ok(records);
    });

    if (!created.ok) {
      writeJson(response, 422, { error: "enrollment_rejected", message: created.error.message });
      return true;
    }
    writeJson(response, 201, { enrollmentIds: created.value.map((record) => record.id) });
    deps.wake?.();
    return true;
  }

  if (url.pathname === `/integrations/${provider}/status`) {
    if (adapter.describeStatus === undefined) {
      writeJson(response, 404, { error: "not_found" });
      return true;
    }
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    // Read-level: no CSRF requirement for a GET.
    const authorized = await requireAuthorization(request, response, deps, false);
    if (authorized === null) return true;

    const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
    if (!key.ok) {
      writeJson(response, 500, { error: "internal" });
      return true;
    }
    const persisted = readIntegrationState(deps.vaultRoot, key.value);
    if (!persisted.ok) {
      writeJson(response, 500, { error: "internal" });
      return true;
    }
    // A provider that is configured but never connected still reports status
    // (as "disconnected") rather than 404ing — describeStatus is a pure
    // projection that tolerates an empty ProviderState.
    const providerState = persisted.value.providers[provider] ?? {
      accessToken: "",
      refreshToken: "",
      sources: {},
    };
    const status: ProviderStatus = adapter.describeStatus(providerState);
    const lastOutcome = deps.lastOutcome?.(provider);
    const merged: ProviderStatus =
      lastOutcome === undefined
        ? status
        : {
            ...status,
            lastCycle: {
              at: lastOutcome.at,
              distilled: lastOutcome.outcome.distilledSourceIds.length,
              unchanged: lastOutcome.outcome.unchangedSourceIds.length,
              failed: lastOutcome.outcome.failedSourceIds.length,
              unavailable: lastOutcome.outcome.unavailableSourceIds.length,
            },
          };
    writeJson(response, 200, merged);
    return true;
  }

  const enrollmentIdMatch = new RegExp(`^/integrations/${provider}/enrollments/([^/]+)$`).exec(
    url.pathname,
  );
  if (enrollmentIdMatch !== null && enrollmentIdMatch[1] !== "preview") {
    // Same provider-neutral capability gate as preview/POST/GET above: a
    // provider that never implements resolveEnrollment never has enrollments
    // to unenroll either, so the 404 must not depend on the enrollment id
    // happening to be absent — otherwise google/notion would run real
    // manage_integrations + CSRF work before falling through to a 404.
    if (adapter.resolveEnrollment === undefined) {
      writeJson(response, 404, { error: "not_found" });
      return true;
    }
    if (request.method !== "DELETE") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    const authorized = await requireAuthorization(request, response, deps, true);
    if (authorized === null) return true;

    const enrollmentId = decodeURIComponent(enrollmentIdMatch[1]);
    const key = resolveIntegrationStateKey(deps.config.encryptionKeyEnv, deps.environment);
    if (!key.ok) {
      writeJson(response, 500, { error: "internal" });
      return true;
    }
    const snapshot = readIntegrationState(deps.vaultRoot, key.value);
    if (!snapshot.ok) {
      writeJson(response, 500, { error: "internal" });
      return true;
    }
    const snapshotRecord = snapshot.value.providers[provider]?.enrollments?.[enrollmentId];
    if (snapshotRecord === undefined) {
      writeJson(response, 404, { error: "not_found" });
      return true;
    }
    if (!canWrite(authorized.role, snapshotRecord.collection)) {
      writeJson(response, 403, { error: "forbidden" });
      return true;
    }

    const removed = await withIntegrationStateLock(deps.vaultRoot, async () => {
      const persisted = readIntegrationState(deps.vaultRoot, key.value);
      if (!persisted.ok) return persisted;
      const providerState = persisted.value.providers[provider];
      const record = providerState?.enrollments?.[enrollmentId];
      if (providerState === undefined || record === undefined) {
        // Already gone (a concurrent delete won the race) — idempotent no-op.
        return ok([]);
      }
      const enrollments = { ...providerState.enrollments };
      delete enrollments[enrollmentId];
      // R38: source metadata is RETAINED, never deleted — only the
      // enrollment record and its grouping are removed. The sources
      // themselves (and their contentHash/available history) are untouched.
      const orphanedSources = Object.values(providerState.sources).filter(
        (source) => source.enrollmentId === enrollmentId,
      );
      persisted.value.providers[provider] = { ...providerState, enrollments };
      const written = writeIntegrationState(deps.vaultRoot, persisted.value, key.value);
      if (!written.ok) return written;
      return ok(orphanedSources);
    });
    if (!removed.ok) {
      writeJson(response, 500, { error: "internal" });
      return true;
    }

    const now = deps.engineDeps.now?.() ?? new Date();
    for (const source of removed.value) {
      const event: UnavailableSourceEvent = {
        idempotencyKey: `${provider}:${source.id}:${source.revision}:unenrolled`,
        providerSourceId: source.id,
        reason: "unenrolled",
        revision: source.revision,
        occurredAt: now.toISOString(),
      };
      // The enrollment removal above already committed — a failed audit
      // write must not be silently dropped, but it also must not turn a
      // successful removal into an error response. Surface it through the
      // runtime's existing error channel instead.
      const appended = appendUnavailableReview(deps.vaultRoot, event);
      if (!appended.ok) {
        deps.onError?.(
          `integration ${provider} unenrolled-review write failed for source ${source.id}: ${appended.error.message}`,
        );
      }
    }
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    deps.wake?.();
    return true;
  }

  writeJson(response, 404, { error: "not_found" });
  return true;
}
