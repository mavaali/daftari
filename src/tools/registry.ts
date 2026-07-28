// The full tool registry, assembled once at module load — moved out of
// server.ts (spec 2026-07-26-context-packs-progressive-disclosure-design.md,
// Phase 1.1) to break an import cycle: `vault_tools` needs to close over the
// full `allTools` array, and it needs to live somewhere every tools/*.ts file
// can be assembled without server.ts importing back into a tools file (or a
// tools file importing server.ts).
//
// `serializeToolDefinition` is the SINGLE wire-shape serializer, used by both
// server.ts's ListTools handler and vault_tools' expand mode, so the two can
// never drift (spec Phase 1.1's stated purpose for extracting it).

import type { AccessContext } from "../access/rbac.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { loadConfig } from "../utils/config.js";
import { consumesTools } from "./consumes.js";
import { contextTools } from "./context.js";
import { curationTools } from "./curation.js";
import { edgeStalenessTools } from "./edge-staleness.js";
import { edgeTools } from "./edges.js";
import { readTools, type ToolAnnotations, type ToolDefinition } from "./read.js";
import { receiptTools } from "./receipt.js";
import { searchTools } from "./search.js";
import { stagedActionTools } from "./staged-actions.js";
import { themesTools } from "./themes.js";
import { tier1Tools } from "./tier1.js";
import { tier2Tools } from "./tier2.js";
import { witnessTools } from "./witness.js";
import { writeTools } from "./write.js";

// Every tool EXCEPT vault_tools itself — vault_tools is appended below, once
// defined, so its own entry appears in its own index (a caller asking "what
// tools exist" should see vault_tools listed, not have to already know it
// exists to call it).
const registeredTools: ToolDefinition[] = [
  ...readTools,
  ...receiptTools,
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
  ...contextTools,
];

// The wire shape ListTools ships (name, title?, description, inputSchema,
// outputSchema, annotations?) — the SAME projection vault_tools' expand mode
// returns, so the two surfaces can never describe a tool differently.
export interface SerializedToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export function serializeToolDefinition(t: ToolDefinition): SerializedToolDefinition {
  return {
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  };
}

// ---------------------------------------------------------------------------
// vault_tools (spec Decision 1 / Phase 1.3)
// ---------------------------------------------------------------------------

export interface VaultToolsIndexEntry {
  name: string;
  oneLine: string;
}

export type VaultToolsResult =
  | { mode: "index"; count: number; tools: VaultToolsIndexEntry[] }
  | { mode: "expand"; tools: SerializedToolDefinition[]; unknown: string[] };

// The vault's `exclude` list applies to vault_tools too — "exclude always
// wins" (#104) extends to the in-band catalog (C2). Tier and `include` do
// NOT affect vault_tools: making tiered-out tools discoverable is the whole
// point of this tool. A config-load failure degrades to "nothing excluded"
// (the same posture #104's own exclude filtering takes when it cannot read
// config — a missing/malformed config yields the empty ToolsConfig default
// upstream, never a hard failure here).
function loadExcludeSet(vaultRoot: string): Set<string> {
  const cfg = loadConfig(vaultRoot);
  return new Set(cfg.ok ? cfg.value.tools.exclude : []);
}

export async function vaultTools(
  vaultRoot: string,
  args: Record<string, unknown>,
  _access?: AccessContext,
): Promise<Result<VaultToolsResult, Error>> {
  const excluded = loadExcludeSet(vaultRoot);

  // Index mode: `expand` omitted entirely. An explicit empty array is still
  // an expand request (of zero names) — distinct from "browse everything" —
  // so the branch keys on `undefined`, not falsiness or emptiness.
  if (args.expand === undefined) {
    const tools = allTools
      .filter((t) => !excluded.has(t.name))
      .map((t): VaultToolsIndexEntry => ({ name: t.name, oneLine: t.oneLine }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return ok({ mode: "index", count: tools.length, tools });
  }

  if (!Array.isArray(args.expand) || !args.expand.every((n) => typeof n === "string")) {
    return err(new Error("vault_tools: 'expand' must be an array of tool name strings"));
  }

  const byName = new Map(allTools.map((t) => [t.name, t]));
  const unknown: string[] = [];
  const tools: SerializedToolDefinition[] = [];
  // Excluded names in an expand request land in `unknown`, identical to
  // unregistered names — omission, shaped as if the tool does not exist
  // (spec C2: definitions are not documents, so this is a consistency
  // choice, not an existence-leak requirement).
  for (const name of args.expand as string[]) {
    const tool = byName.get(name);
    if (!tool || excluded.has(name)) {
      unknown.push(name);
      continue;
    }
    tools.push(serializeToolDefinition(tool));
  }
  return ok({ mode: "expand", tools, unknown });
}

const VAULT_TOOLS_INDEX_ENTRY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: "string" },
    oneLine: { type: "string" },
  },
  required: ["name", "oneLine"],
  additionalProperties: false,
};

// Expanded entries carry each tool's own inputSchema/outputSchema — nested,
// arbitrary-shaped JSON Schema fragments. A permissive object schema here is
// deliberate (spec Phase 1.3): the only alternative is describing "any JSON
// Schema" recursively, which strict ajv compilation does not make cheap and
// this contract does not need — the wire shape is already pinned by
// SerializedToolDefinition and the ListTools-drift test.
const VAULT_TOOLS_EXPANDED_ENTRY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    annotations: { type: "object" },
  },
  required: ["name", "description", "inputSchema", "outputSchema"],
};

function summarizeVaultTools(value: unknown): string {
  const r = value as VaultToolsResult;
  if (r.mode === "index") {
    const lines = [`${r.count} tool(s):`, ...r.tools.map((t) => `${t.name} — ${t.oneLine}`)];
    return lines.join("\n");
  }
  const lines = [`expanded ${r.tools.length} tool(s)`];
  for (const name of r.unknown) lines.push(`unknown tool: ${name}`);
  return lines.join("\n");
}

const vaultToolsDefinition: ToolDefinition = {
  name: "vault_tools",
  title: "Browse or expand the tool catalog",
  oneLine: "List every vault tool (one line each), or expand named tools to full schemas.",
  annotations: { readOnlyHint: true },
  description:
    "List every tool this vault offers, one line each, or expand named tools " +
    "to their full schemas (description, inputSchema, outputSchema). Call " +
    "with no arguments to browse; call with 'expand' before first use of a " +
    "non-core tool. Every registered tool remains callable regardless of " +
    "what this index shows — this is advertisement only, never a gate. " +
    "Names excluded by the vault's config are omitted from the index and " +
    "reported in 'unknown' on expand, the same as an unregistered name.",
  inputSchema: {
    type: "object",
    properties: {
      expand: {
        type: "array",
        items: { type: "string" },
        description:
          "Tool names to expand to full schemas. Omit entirely to get the " +
          "one-line index instead.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    oneOf: [
      {
        type: "object",
        properties: {
          mode: { const: "index" },
          count: { type: "integer", minimum: 0 },
          tools: { type: "array", items: VAULT_TOOLS_INDEX_ENTRY_SCHEMA },
        },
        required: ["mode", "count", "tools"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          mode: { const: "expand" },
          tools: { type: "array", items: VAULT_TOOLS_EXPANDED_ENTRY_SCHEMA },
          unknown: {
            type: "array",
            items: { type: "string" },
            description: "Requested names that are unregistered or excluded by config.",
          },
        },
        required: ["mode", "tools", "unknown"],
        additionalProperties: false,
      },
    ],
  },
  summarize: summarizeVaultTools,
  handler: (vaultRoot, args, access) => vaultTools(vaultRoot, args, access),
};

// The full registry. Static — assembled once at module load, shared by every
// server instance and by the tier-exposure helpers in server.ts.
// `vaultToolsDefinition`'s handler closes over this binding by name (see
// `vaultTools` above); that is a plain forward reference, not a cycle — the
// handler only runs after this module has finished evaluating.
export const allTools: ToolDefinition[] = [...registeredTools, vaultToolsDefinition];

export function registeredToolNames(): string[] {
  return allTools.map((t) => t.name);
}

// The full ToolDefinition registry, for tests that need more than the name
// (output-schema compilation, summarize/docLinks presence checks).
export function allRegisteredTools(): ToolDefinition[] {
  return allTools;
}
