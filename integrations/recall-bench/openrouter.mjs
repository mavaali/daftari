// openrouter.mjs — minimal OpenAI-compatible client for OpenRouter.
const URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RETRIES = 5, BASE = 500, CAP = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createOpenRouter() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY env var is required");
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };

  async function raw({ model, system, user, temperature = 0, maxTokens = 1024, json = false }) {
    const body = {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    };
    let lastErr;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const res = await fetch(URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); }
        else if (!res.ok) { throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); }
        else {
          const j = await res.json();
          usage.input_tokens += j.usage?.prompt_tokens ?? 0;
          usage.output_tokens += j.usage?.completion_tokens ?? 0;
          usage.calls += 1;
          return j.choices?.[0]?.message?.content ?? "";
        }
      } catch (e) { lastErr = e; }
      if (i < MAX_RETRIES - 1) await sleep(Math.min(BASE * 2 ** i, CAP));
    }
    throw lastErr ?? new Error("retries exhausted");
  }

  return {
    usage,
    chat: (opts) => raw(opts),
    chatJson: async (opts) => {
      const txt = await raw({ ...opts, json: true });
      const stripped = txt.replace(/^```(?:json)?\n?/, "").replace(/\n?```\s*$/, "");
      return JSON.parse(stripped);
    },
  };
}
