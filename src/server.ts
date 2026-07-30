// MCP server wiring. Builds a Server, registers the read-path tools, and
// bridges each tool's Result<T, Error> into the MCP tool-call response shape.
//
// Tool handlers never throw; they return Result. The CallTool request handler
// additionally guards against unexpected throws at the transport boundary so a
// bug cannot take the stdio connection down.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  acceptedContent,
  type CallToolResult,
  createRequestStateCodec,
  type InputRequiredResult,
  inputRequired,
  ResourceNotFoundError,
  Server,
  type ServerContext,
  type Tool,
} from "@modelcontextprotocol/server";
import { type AccessContext, guestAccess } from "./access/rbac.js";
import { docUri, listResources, readResource, resourceTemplates } from "./resources.js";
import { canonTools } from "./tools/canon.js";
import { consumesTools } from "./tools/consumes.js";
import { curationTools } from "./tools/curation.js";
import { edgeStalenessTools } from "./tools/edge-staleness.js";
import { edgeTools } from "./tools/edges.js";
import { readTools, type ToolDefinition } from "./tools/read.js";
import { receiptTools } from "./tools/receipt.js";
import { searchTools } from "./tools/search.js";
import { describeRatifyElicitation, stagedActionTools } from "./tools/staged-actions.js";
import { themesTools } from "./tools/themes.js";
import { tier1Tools } from "./tools/tier1.js";
import { tier2Tools } from "./tools/tier2.js";
import { witnessTools } from "./tools/witness.js";
import { writeTools } from "./tools/write.js";
import type { ToolsConfig } from "./utils/config.js";

export const SERVER_NAME = "daftari";

// The version is read from the package manifest so it never drifts from the
// published version. src/server.ts and dist/server.js both sit one level under
// the package root, so this relative path resolves the same in dev and build.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  version: string;
};
export const SERVER_VERSION = manifest.version;

// The full registry. Static — assembled once at module load, shared by every
// server instance and by the tier-exposure helpers below.
const allTools: ToolDefinition[] = [
  ...readTools,
  ...receiptTools,
  ...canonTools,
  ...witnessTools,
  ...searchTools,
  ...themesTools,
  ...writeTools,
  ...curationTools,
  ...stagedActionTools,
  ...edgeTools,
  ...consumesTools,
  ...tier1Tools,
  ...tier2Tools,
  ...edgeStalenessTools,
];

export function registeredToolNames(): string[] {
  return allTools.map((t) => t.name);
}

// Tool-exposure tiers (#103). Tiers are additive: standard = core + its own
// list; full = the whole registry (never enumerated, so a new tool is
// full-tier by default and only joins a leaner tier deliberately).
//
// core is the search-before-derive loop end to end; standard adds the full
// document lifecycle — including propose/ratify, which IS the write path for
// RBAC vaults with propose-only roles — plus index diagnostics. Everything
// else (tensions, themes, witness/receipt epistemics, the edge graph,
// tier-1/tier-2 dispatch, staleness) is specialist curation surface: full.
export const CORE_TOOLS: readonly string[] = [
  "vault_search",
  "vault_read",
  "vault_write",
  "vault_index",
  "vault_lint",
  "vault_status",
];

export const STANDARD_TOOLS: readonly string[] = [
  ...CORE_TOOLS,
  "vault_append",
  "vault_promote",
  "vault_deprecate",
  "vault_supersede",
  "vault_merge",
  "vault_set_confidence",
  "vault_set_tier",
  "vault_stage_action",
  "vault_ratify",
  "vault_search_related",
  "vault_provenance",
  "vault_reindex",
];

export interface ToolExposure {
  exposed: Set<string>;
  // include/exclude entries naming no registered tool — the caller's warning.
  // Deliberately not an error: a config written for a future daftari must
  // keep loading on today's build (#104).
  unknown: string[];
}

// Resolves which tool names ListTools advertises: tier set, plus include,
// minus exclude — exclude always wins (#104). Pure; exported for tests and
// for the startup warning in index.ts.
export function resolveToolExposure(tools: ToolsConfig): ToolExposure {
  const registered = new Set(registeredToolNames());
  const exposed =
    tools.tier === "full"
      ? new Set(registered)
      : new Set(
          (tools.tier === "core" ? CORE_TOOLS : STANDARD_TOOLS).filter((n) => registered.has(n)),
        );
  // A Set, not an array: the same unknown name in BOTH lists must warn once,
  // not twice.
  const unknown = new Set<string>();
  for (const name of tools.include) {
    if (registered.has(name)) exposed.add(name);
    else unknown.add(name);
  }
  for (const name of tools.exclude) {
    if (registered.has(name)) exposed.delete(name);
    else unknown.add(name);
  }
  return { exposed, unknown: [...unknown] };
}

// vault_ratify form-mode elicitation (spec 2026-07-26, Decision 5): called
// without a decision, the tool answers with an input_required form instead of
// an error — the server proposes, the human disposes, and the wire format
// itself says so. The opaque request state carries the action id, the vault
// HEAD at proposal time, and the deciding user, HMAC-signed so it round-trips
// untampered; the server remembers nothing between the two requests.
//
// A per-process random key is sound here because the process lock guarantees
// exactly one daftari process serves every round of a flow (2026-07-20
// Decision 4); a restart invalidates in-flight forms, and the client simply
// re-calls. TTL matches the codec default posture: a stale form must not
// ratify.
interface RatifyElicitState {
  action: string;
  head: string | null;
  user: string;
}

const ratifyStateCodec = createRequestStateCodec<RatifyElicitState>({
  key: randomBytes(32),
  ttlSeconds: 600,
});

// One round of the vault_ratify elicitation flow, entered only when the call
// carries no decision. Returns a `reply` to short-circuit with (the form, a
// declined-form acknowledgement, or a gate error), or the args augmented with
// the elicited decision to fall through to the normal dispatch — which
// re-validates pending/conflict-free exactly as a direct call would.
async function ratifyElicitationRound(
  vaultRoot: string,
  args: Record<string, unknown>,
  access: AccessContext,
  ctx: ServerContext,
): Promise<
  | { reply: CallToolResult | InputRequiredResult; args?: undefined }
  | { reply?: undefined; args: Record<string, unknown> }
> {
  // Resubmit path: a verified state minted by THIS process, bound to the
  // same user and the same action. The state is bearer proof of nothing more
  // than "this identity was shown this form" — the ratify grant and the
  // action's pending/conflict-free status are re-checked downstream.
  const state = ctx.mcpReq.requestState<RatifyElicitState>();
  if (state && state.user === access.user && state.action === args.id) {
    const answer = acceptedContent<{ decision?: unknown }>(ctx.mcpReq.inputResponses, "decision");
    const decision = answer?.decision;
    if (decision === "approve" || decision === "reject") {
      return { args: { ...args, decision } };
    }
    // Declined or cancelled: apply nothing, record nothing. The action
    // stays pending — the safe answer is the one that changes nothing.
    return {
      reply: {
        content: [
          {
            type: "text" as const,
            text:
              `vault_ratify: elicitation declined — staged action ` +
              `${state.action} remains pending`,
          },
        ],
      },
    };
  }

  // First round: run the same gates vaultRatify would (grant, propose-only,
  // unknown/decided action) so a caller that could not ratify never sees a
  // form, then hand the client the form plus the signed state.
  const form = await describeRatifyElicitation(vaultRoot, args, access);
  if (!form.ok) {
    return {
      reply: {
        isError: true,
        content: [{ type: "text" as const, text: `Error: ${form.error.message}` }],
      },
    };
  }
  return {
    reply: inputRequired({
      inputRequests: {
        decision: inputRequired.elicit({
          message: form.value.message,
          requestedSchema: {
            type: "object",
            required: ["decision"],
            properties: {
              decision: {
                type: "string",
                enum: ["approve", "reject"],
                default: "reject",
                description: "Approve applies the staged action; reject records the refusal.",
              },
            },
          },
        }),
      },
      requestState: await ratifyStateCodec.mint({
        action: form.value.actionId,
        head: form.value.head,
        user: access.user,
      }),
    }),
  };
}

// The server runs as one access identity for its whole lifetime — the
// --user / --role it was started with. Every tool call is enforced against it.
// Absent an explicit context the server falls back to the deny-all guest.
// `toolsConfig` (#103/#104) narrows what ListTools ADVERTISES; CallTool still
// accepts every registered name, so an agent holding a cached tool name from
// a prior session keeps working across a tier change.
export function createServer(
  vaultRoot: string,
  access: AccessContext = guestAccess(),
  toolsConfig?: ToolsConfig,
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      // Decision 5: echoed request state is attacker-controlled input; the
      // codec's verify hook is what makes ctx.mcpReq.requestState() trusted.
      requestState: { verify: ratifyStateCodec.verify },
    },
  );

  const byName = new Map(allTools.map((t) => [t.name, t]));
  const exposedNames = toolsConfig ? resolveToolExposure(toolsConfig).exposed : null;
  const exposed = exposedNames ? allTools.filter((t) => exposedNames.has(t.name)) : allTools;

  server.setRequestHandler("tools/list", async () => ({
    tools: exposed.map((t) => ({
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      description: t.description,
      // ToolDefinition keeps schemas as plain Record JSON Schema (2020-12);
      // the wire type narrows the root to `type: "object"`, which every
      // registered schema satisfies by construction.
      inputSchema: t.inputSchema as Tool["inputSchema"],
      outputSchema: t.outputSchema as Tool["outputSchema"],
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));

  // Resources (spec 2026-07-26, Decision 2). Every listing and read resolves
  // against this server's access context, exactly as tools do — a resource is
  // not a back door around RBAC. src/resources.ts holds the disclosure rules.
  server.setRequestHandler("resources/templates/list", async () => ({
    resourceTemplates: resourceTemplates(),
  }));

  server.setRequestHandler("resources/list", async () => {
    const result = await listResources(vaultRoot, access);
    // A listing failure yields an empty list rather than an error: a doc list
    // that fails loudly for some callers and not others is itself a signal.
    return { resources: result.ok ? result.value : [] };
  });

  server.setRequestHandler("resources/read", async (request) => {
    const uri = request.params.uri;
    const result = await readResource(vaultRoot, uri, access);
    // One error for "no such document" and "you may not read it" alike —
    // resources.ts keeps the messages byte-identical (omission over
    // redaction), and this single throw site keeps the wire code identical.
    if (!result.ok) throw new ResourceNotFoundError(uri, result.error.message);
    return { contents: [result.value] };
  });

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const name = request.params.name;
    const tool = byName.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
      };
    }
    try {
      let args = (request.params.arguments ?? {}) as Record<string, unknown>;
      // vault_ratify without a decision speaks form-mode elicitation
      // (Decision 5). A direct call with the decision inline never enters
      // this branch — it keeps working for clients that don't do
      // elicitation, and on 2025-era connections the SDK's legacy shim
      // fulfils the form over the session.
      if (name === "vault_ratify" && typeof args.decision !== "string") {
        const round = await ratifyElicitationRound(vaultRoot, args, access, ctx);
        if (round.reply !== undefined) return round.reply;
        args = round.args;
      }
      const result = await tool.handler(vaultRoot, args, access);
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${result.error.message}` }],
        };
      }
      // Three channels (spec 2026-07-26, Decision 3):
      //   structuredContent — the full typed result, matching outputSchema;
      //   content           — a compact, model-facing summary;
      //   resource_link     — handles for the docs the result references,
      //                       so the agent reads the two it needs at full
      //                       fidelity instead of receiving twenty bodies it
      //                       will truncate in context anyway.
      //
      // A tool with no `summarize` falls back to the pretty-printed value, so
      // this is backward compatible for any tool that has not opted in.
      const summary = tool.summarize
        ? tool.summarize(result.value)
        : JSON.stringify(result.value, null, 2);
      const links = tool.docLinks ? tool.docLinks(result.value) : [];
      return {
        content: [
          { type: "text" as const, text: summary },
          // Links inherit read-gating: a handler only ever names docs the
          // caller may read, so every link emitted here is readable by
          // construction (Decision 3).
          ...links.map((path) => ({
            type: "resource_link" as const,
            uri: docUri(path),
            name: path,
            mimeType: "text/markdown",
          })),
        ],
        structuredContent: result.value as Record<string, unknown>,
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unexpected error in ${name}: ${reason}` }],
      };
    }
  });

  return server;
}
