// src/eval/transport.ts
// The one place an LlmTransport becomes a client. Lives in its own module (not
// llm-openrouter.ts) so both constructors are imported across a module
// boundary — callers' tests can mock either one and still exercise this dispatch.

import { err, ok, type Result } from "../frontmatter/types.js";
import { createAnthropicClient, type LlmClient } from "./llm.js";
import { createOpenRouterClient, type LlmTransport, ollamaBaseUrl } from "./llm-openrouter.js";

// Every caller (distill, sleep,
// consolidate, eval) goes through here so a new transport can never fall
// through a two-way ternary to the Anthropic key.
export function createTransportClient(transport: LlmTransport): Result<LlmClient, Error> {
  const keyVar = { anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY", ollama: null }[
    transport
  ];
  if (keyVar && !process.env[keyVar]) {
    return err(new Error(`${keyVar} env var is required (transport: ${transport})`));
  }
  try {
    if (transport === "anthropic") return ok(createAnthropicClient());
    if (transport === "openrouter") return ok(createOpenRouterClient());
    return ok(createOpenRouterClient({ baseUrl: ollamaBaseUrl(), apiKey: "ollama" }));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
