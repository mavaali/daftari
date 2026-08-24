import type { IncomingMessage, ServerResponse } from "node:http";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { EngineDeps, ProviderAdapter, WebhookRequest } from "./engine.js";
import {
  armProviderWebhookSetup,
  confirmProviderWebhookVerification,
  readProviderWebhookVerificationToken,
  verifyProviderWebhook,
} from "./engine.js";
import { beginAuthorizationRedirect, completeAuthorization } from "./oauth.js";
import type { IntegrationQueue } from "./queue.js";
import type { IntegrationConfig, ProviderName } from "./types.js";

const DEFAULT_WEBHOOK_BODY_LIMIT = 256 * 1024;

export interface IntegrationRouteAuthorization {
  cookieAuthenticated: boolean;
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
  checkCsrf(request: IncomingMessage): string | null;
  maxWebhookBodyBytes?: number;
  wake?: () => void;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function providerFrom(pathname: string): ProviderName | null {
  const matched = /^\/integrations\/(google|notion)(?:\/|$)/.exec(pathname);
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
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        if (settled) return;
        settled = true;
        resolve(err(new Error("request body is too large")));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(ok(Buffer.concat(chunks)));
    });
    request.on("error", () => {
      if (settled) return;
      settled = true;
      resolve(err(new Error("request body could not be read")));
    });
  });
}

async function requireAuthorization(
  request: IncomingMessage,
  response: ServerResponse,
  deps: IntegrationRouteDependencies,
  csrfProtected: boolean,
): Promise<boolean> {
  const authorized = await deps.authorize(request, response);
  if (authorized === null) return false;
  if (csrfProtected && authorized.cookieAuthenticated) {
    const csrfError = deps.checkCsrf(request);
    if (csrfError !== null) {
      writeJson(response, 403, { error: "forbidden", message: csrfError });
      return false;
    }
  }
  return true;
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
    const started = beginAuthorizationRedirect(
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
    const armed = armProviderWebhookSetup(deps.vaultRoot, provider, deps.engineDeps);
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
    const confirmed = confirmProviderWebhookVerification(deps.vaultRoot, provider, deps.engineDeps);
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
    const body = await readBoundedBody(
      request,
      deps.maxWebhookBodyBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT,
    );
    if (!body.ok) {
      writeJson(response, 413, { error: "payload_too_large" });
      return true;
    }
    const verified = await verifyProviderWebhook(
      deps.vaultRoot,
      adapter,
      {
        headers: nodeHeaders(request),
        body: body.value,
        ...(url.searchParams.get("setup_token") === null
          ? {}
          : { setupToken: url.searchParams.get("setup_token") as string }),
      },
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
  }

  writeJson(response, 404, { error: "not_found" });
  return true;
}
