import type { IncomingMessage, ServerResponse } from "node:http";
import { err, ok, type Result } from "../frontmatter/types.js";
import { type IntegrationDistill, prepareIntegrationDistill } from "./distill.js";
import {
  configuredCredential,
  type EngineDeps,
  ensureProviderWebhook,
  type ProviderAdapter,
  reconcileProvider,
  validateContinuousAdapterCapabilities,
} from "./engine.js";
import { createGoogleDocsAdapter } from "./google.js";
import { createNotionAdapter } from "./notion.js";
import { createIntegrationQueue } from "./queue.js";
import { appendUnavailableReview } from "./review.js";
import { handleIntegrationRoute, type IntegrationRouteAuthorization } from "./routes.js";
import { readIntegrationState, resolveIntegrationStateKey } from "./state.js";
import type { IntegrationConfig, ProviderName } from "./types.js";

const WEBHOOK_RENEWAL_LEAD_MILLISECONDS = 24 * 60 * 60 * 1000;

export type IntegrationAdapterFactory = (redirectUri: string) => ProviderAdapter;

export interface IntegrationRuntimeAuthorization {
  authorize(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<IntegrationRouteAuthorization | null>;
  admitPublic(request: IncomingMessage, response: ServerResponse): (() => void) | null;
  checkCsrf(request: IncomingMessage): string | null;
}

export interface IntegrationRuntime {
  start(localBaseUrl: string): Promise<Result<void, Error>>;
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    authorization: IntegrationRuntimeAuthorization,
  ): Promise<boolean>;
  runOnce(): Promise<void>;
  close(): Promise<void>;
}

export interface ConfiguredIntegrationRuntimeOptions {
  vaultRoot: string;
  config: IntegrationConfig;
  environment: NodeJS.ProcessEnv;
  publicBaseUrl?: string;
  adapterFactories?: Partial<Record<ProviderName, IntegrationAdapterFactory>>;
  now?: () => Date;
  onError?: (message: string) => void;
  /** Ready distill dependency for tests or callers that preflight externally. */
  distill?: IntegrationDistill;
}

const DEFAULT_FACTORIES: Record<ProviderName, IntegrationAdapterFactory> = {
  google: (redirectUri) => createGoogleDocsAdapter({ redirectUri }),
  notion: (redirectUri) => createNotionAdapter({ redirectUri }),
};

function configuredProviders(config: IntegrationConfig): ProviderName[] {
  return (["google", "notion"] as const).filter((provider) => config[provider] !== undefined);
}

function callbackUrl(baseUrl: string, provider: ProviderName): string {
  return integrationEndpoint(baseUrl, provider, "callback");
}

function webhookUrl(baseUrl: string, provider: ProviderName): string {
  return integrationEndpoint(baseUrl, provider, "webhook");
}

function integrationEndpoint(baseUrl: string, provider: ProviderName, leaf: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/integrations/${provider}/${leaf}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function routePrefix(baseUrl: string): string {
  const pathname = new URL(baseUrl).pathname.replace(/\/$/, "");
  return pathname === "/" ? "" : pathname;
}

function routedIntegrationUrl(url: URL, prefix: string): URL | null {
  const integrationRoot = `${prefix}/integrations/`;
  if (!url.pathname.startsWith(integrationRoot)) return null;
  const routed = new URL(url);
  routed.pathname = url.pathname.slice(prefix.length);
  return routed;
}

function validateBaseUrl(value: string): Result<string, Error> {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return err(new Error("integration callback base URL must use HTTP or HTTPS"));
    }
    return ok(parsed.toString().replace(/\/$/, ""));
  } catch {
    return err(new Error("integration callback base URL is invalid"));
  }
}

export function createConfiguredIntegrationRuntime(
  options: ConfiguredIntegrationRuntimeOptions,
): Result<IntegrationRuntime, Error> {
  if (options.publicBaseUrl !== undefined) {
    try {
      const publicUrl = new URL(options.publicBaseUrl);
      if (
        publicUrl.protocol !== "https:" ||
        publicUrl.username ||
        publicUrl.password ||
        publicUrl.search ||
        publicUrl.hash
      ) {
        return err(new Error("integration public base URL must be an absolute HTTPS URL"));
      }
    } catch {
      return err(new Error("integration public base URL must be an absolute HTTPS URL"));
    }
  }
  const providers = configuredProviders(options.config);
  const stateKey = resolveIntegrationStateKey(options.config.encryptionKeyEnv, options.environment);
  if (!stateKey.ok) return stateKey;
  const readableState = readIntegrationState(options.vaultRoot, stateKey.value);
  if (!readableState.ok) return readableState;
  for (const provider of providers) {
    const providerConfig = options.config[provider];
    if (providerConfig === undefined) continue;
    const clientId = configuredCredential(
      options.environment,
      providerConfig.clientIdEnv,
      `${provider} OAuth client ID`,
    );
    if (!clientId.ok) return clientId;
    const clientSecret = configuredCredential(
      options.environment,
      providerConfig.clientSecretEnv,
      `${provider} OAuth client secret`,
    );
    if (!clientSecret.ok) return clientSecret;
  }
  const preparedDistill =
    options.distill === undefined
      ? prepareIntegrationDistill(options.vaultRoot)
      : ok(options.distill);
  if (!preparedDistill.ok) return preparedDistill;

  const queue = createIntegrationQueue(options.vaultRoot, options.now);
  const readableQueue = queue.pending();
  if (!readableQueue.ok) return readableQueue;
  const factories = { ...DEFAULT_FACTORIES, ...options.adapterFactories };
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  let adapters: ProviderAdapter[] = [];
  let engineDeps: EngineDeps | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let currentCycle: Promise<void> | undefined;
  let rerunRequested = false;
  let routeBaseUrl: string | undefined;
  let integrationRoutePrefix =
    options.publicBaseUrl === undefined ? "" : routePrefix(options.publicBaseUrl);
  let started = false;

  async function cycle(): Promise<void> {
    const deps = engineDeps;
    if (deps === undefined) return;
    const drained = await queue.drain(async (item) => {
      const adapter = adapters.find((candidate) => candidate.name === item.provider);
      if (adapter === undefined) return err(new Error("integration queue provider is unavailable"));
      const reconciled = await reconcileProvider(options.vaultRoot, adapter, deps);
      if (!reconciled.ok) return reconciled;
      if (reconciled.value.failedSourceIds.length > 0) {
        const count = reconciled.value.failedSourceIds.length;
        onError(
          `integration ${adapter.name} reconcile incomplete (${count} source${count === 1 ? "" : "s"})`,
        );
        return err(new Error(`integration ${adapter.name} reconcile incomplete`));
      }
      return ok(undefined);
    });
    if (!drained.ok) onError("integration queue drain failed");

    for (const adapter of adapters) {
      const reconciled = await reconcileProvider(options.vaultRoot, adapter, deps);
      if (!reconciled.ok) {
        onError(`integration ${adapter.name} reconcile failed`);
        continue;
      }
      if (reconciled.value.failedSourceIds.length > 0) {
        const count = reconciled.value.failedSourceIds.length;
        onError(
          `integration ${adapter.name} reconcile incomplete (${count} source${count === 1 ? "" : "s"})`,
        );
      }
      if (options.publicBaseUrl === undefined) continue;
      if (adapter.webhookSetup === "manual") continue;
      const instant = now();
      const ensured = await ensureProviderWebhook(
        options.vaultRoot,
        adapter,
        {
          callbackUrl: webhookUrl(options.publicBaseUrl, adapter.name),
          now: instant,
          renewBefore: new Date(instant.getTime() + WEBHOOK_RENEWAL_LEAD_MILLISECONDS),
        },
        deps,
      );
      if (!ensured.ok) onError(`integration ${adapter.name} webhook renewal failed`);
    }
  }

  function runOnce(): Promise<void> {
    if (currentCycle !== undefined) {
      rerunRequested = true;
      return currentCycle;
    }
    currentCycle = (async () => {
      do {
        rerunRequested = false;
        await cycle();
      } while (rerunRequested);
    })()
      .catch(() => onError("integration cycle failed"))
      .finally(() => {
        currentCycle = undefined;
      });
    return currentCycle;
  }

  return ok({
    async start(localBaseUrl) {
      if (started) return err(new Error("integration runtime is already started"));
      const fallback = validateBaseUrl(localBaseUrl);
      if (!fallback.ok) return fallback;
      const resolvedRouteBaseUrl = options.publicBaseUrl ?? fallback.value;
      routeBaseUrl = resolvedRouteBaseUrl;
      integrationRoutePrefix = routePrefix(resolvedRouteBaseUrl);
      try {
        adapters = providers.map((provider) =>
          factories[provider](callbackUrl(resolvedRouteBaseUrl, provider)),
        );
      } catch {
        return err(new Error("integration adapter construction failed"));
      }
      for (const adapter of adapters) {
        const capability = validateContinuousAdapterCapabilities(adapter, {
          webhooksRequired: options.publicBaseUrl !== undefined,
        });
        if (!capability.ok) return capability;
      }
      engineDeps = {
        config: options.config,
        environment: options.environment,
        adapters: Object.fromEntries(adapters.map((adapter) => [adapter.name, adapter])),
        now,
        distill: preparedDistill.value,
        recordUnavailable: (event) => appendUnavailableReview(options.vaultRoot, event),
      };
      started = true;
      interval = setInterval(() => {
        void runOnce();
      }, options.config.pollingIntervalMinutes * 60_000);
      interval.unref();
      void runOnce();
      return ok(undefined);
    },

    async handle(request, response, url, authorization) {
      const routedUrl = routedIntegrationUrl(url, integrationRoutePrefix);
      if (routedUrl === null) return false;
      if (!started || engineDeps === undefined || routeBaseUrl === undefined) {
        response.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ error: "integration_runtime_unavailable" }));
        return true;
      }
      return handleIntegrationRoute(request, response, routedUrl, {
        vaultRoot: options.vaultRoot,
        config: options.config,
        environment: options.environment,
        adapters: engineDeps.adapters,
        engineDeps,
        queue,
        publicBaseUrl: options.publicBaseUrl,
        authorize: authorization.authorize,
        admitPublic: authorization.admitPublic,
        checkCsrf: authorization.checkCsrf,
        wake: () => {
          queueMicrotask(() => {
            void runOnce();
          });
        },
      });
    },

    runOnce,

    async close() {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      await currentCycle;
      started = false;
    },
  });
}
