// Run the REAL decorrelation report against the fixture, using an OpenRouter
// transport to reach Claude Haiku (the canonical daftari CLI needs
// ANTHROPIC_API_KEY, which is not reachable from this shell; OPENROUTER_API_KEY
// is). This imports runDecorrelation / formatDecorrelationReport from
// src/consolidate/decorrelation.ts UNCHANGED — now the SHARED foundational
// prompt (temp 0), the {related,premise}→fixture mapping, and the accuracy PASS
// gate. The shim forwards temperature so the run measures exactly what birth
// ships. Only the HTTP backend differs, pointed at a real Haiku model.
//
// The completeJson shim mirrors src/eval/llm.ts createAnthropicClient.completeJson:
// schema appended to system, fence-stripped JSON parse, retry on 429/5xx.

import { writeFileSync } from "node:fs";
import {
  loadFixture,
  runDecorrelation,
  formatDecorrelationReport,
} from "../src/consolidate/decorrelation.ts";

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY || !API_KEY.startsWith("sk-or-")) {
  console.error("FATAL: OPENROUTER_API_KEY missing/malformed.");
  process.exit(1);
}

const MODEL = process.argv[3] ?? "anthropic/claude-haiku-4.5";
const FIXTURE = process.argv[2] ?? "tests/fixtures/decorrelation-fixture.json";

function stripCodeFence(s) {
  const m = s.match(/^```(?:json)?\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : s;
}

async function openrouterComplete(model, system, user, temperature) {
  const MAX = 5;
  let lastErr = "unknown";
  for (let i = 0; i < MAX; i++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          ...(temperature !== undefined ? { temperature } : {}),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `http ${res.status}`;
      } else if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, err: `http ${res.status}: ${t.slice(0, 160)}` };
      } else {
        const json = await res.json();
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text !== "string") return { ok: false, err: "no content" };
        return {
          ok: true,
          text,
          in: json?.usage?.prompt_tokens ?? 0,
          out: json?.usage?.completion_tokens ?? 0,
        };
      }
    } catch (e) {
      lastErr = `net: ${e.message}`;
    }
    if (i < MAX - 1) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** i, 30000)));
  }
  return { ok: false, err: lastErr };
}

// LlmClient shim — only completeJson is used by runDecorrelation.
const llm = {
  complete: async () => ({ ok: false, error: { kind: "llm", message: "unused", retryable: false } }),
  completeWithTools: async () => ({ ok: false, error: { kind: "llm", message: "unused", retryable: false } }),
  completeJson: async (opts) => {
    const sysWithSchema = `${opts.system}\n\nReturn JSON matching:\n${JSON.stringify(opts.schema, null, 2)}\nReturn ONLY JSON, no prose.`;
    const r = await openrouterComplete(opts.model, sysWithSchema, opts.user, opts.temperature);
    if (!r.ok) return { ok: false, error: { kind: "llm", message: r.err, retryable: false } };
    try {
      const parsed = JSON.parse(stripCodeFence(r.text));
      return {
        ok: true,
        value: { text: r.text, parsed, input_tokens: r.in, output_tokens: r.out, stop_reason: "end_turn" },
      };
    } catch (e) {
      return { ok: false, error: { kind: "llm", message: `JSON parse: ${e.message} — ${r.text.slice(0, 160)}`, retryable: false } };
    }
  },
};

const fx = loadFixture(FIXTURE);
if (!fx.ok) {
  console.error("fixture load failed:", fx.error.message);
  process.exit(1);
}
console.error(`running decorrelation: ${fx.value.edges.length} edges × 3 axes against ${MODEL} (via OpenRouter)…`);
const t0 = Date.now();
const rep = await runDecorrelation(fx.value, { llm }, { model: MODEL, fixtureSource: FIXTURE });
if (!rep.ok) {
  console.error("report failed:", rep.error.message);
  process.exit(1);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

console.log(formatDecorrelationReport(rep.value));
console.log(`(wall: ${elapsed}s, transport: OpenRouter→${MODEL})`);

// Persist full report + per-edge detail for audit.
writeFileSync("scripts/pools/decorrelation-report.json", JSON.stringify(rep.value, null, 2) + "\n");
const errored = rep.value.perEdge.flatMap((p) => p.votes.filter((v) => v.verdict === "error").map((v) => `${p.id}:${v.axis}`));
if (errored.length) console.log(`error votes (${errored.length}): ${errored.slice(0, 20).join(", ")}`);
