// consensus-llm — minimal OpenRouter chat seam. The bench calls OpenRouter
// directly (the daftari client is Anthropic-only). fetchImpl is injectable so
// unit tests stay offline; the real run passes the global fetch.
export interface LlmClient {
  complete(opts: { model: string; system?: string; user: string }): Promise<string>;
}

export function openRouterClient(apiKey: string, fetchImpl: typeof fetch = fetch): LlmClient {
  return {
    async complete({ model, system, user }) {
      const messages = system
        ? [{ role: "system", content: system }, { role: "user", content: user }]
        : [{ role: "user", content: user }];
      const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 1024, messages }),
      });
      const json: any = await res.json();
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}
