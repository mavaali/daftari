// Tests for the distill compile arm (U10 / R16).
//
// The distill arm runs Daftari's own compile-on-ingest pipeline (chunk →
// extract → propose → ratify-to-land) over each benchmark day, so recall-bench
// can score the distiller's compile quality on the fixed internal compiler.
//
// HERMETIC block (ungated): landing and determinism are pure filesystem work —
// the LLM is a deterministic stub and no MiniLM/reindex runs, so these assert
// the compile→land invariant and its reproducibility with no network.
//
// INTEGRATION block (gated RB_INTEGRATION): full finalizeIngestion → reindex →
// queryDetail against a real index, proving the landed claims are queryable.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "../../../dist/frontmatter/types.js";
import type { CompleteJsonOpts, LlmClient } from "../../../dist/eval/llm.js";
import { createDaftariAdapter } from "./adapter.js";
import type { DayMetadata } from "./types.js";

const RUN = !!process.env.RB_INTEGRATION;

// A deterministic extraction stub: one claim per day whose statement is the
// message body (the day's content, with the "[ts] sender: " prefix stripped).
// Same input ⇒ same statement ⇒ same claim_key ⇒ same landed path.
function distillStub(): LlmClient {
  return {
    completeJson: async (opts: CompleteJsonOpts) => {
      const body = opts.user.replace(/^\[[^\]]*\]\s+[^:]+:\s*/, "").trim();
      return ok({
        text: "",
        input_tokens: 0,
        output_tokens: 0,
        stop_reason: "end_turn",
        parsed: { claims: [{ statement: body }] },
      });
    },
    complete: async () => {
      throw new Error("distillStub.complete not implemented");
    },
    completeWithTools: async () => {
      throw new Error("distillStub.completeWithTools not implemented");
    },
  } as unknown as LlmClient;
}

const META = (n: number, persona: string): DayMetadata => ({
  dayNumber: n,
  date: `2026-01-${String(n).padStart(2, "0")}`,
  personaId: persona,
});

// Every landed .md file under the vault's `distill/` collection, vault-relative.
function landedDistillDocs(vaultRoot: string): string[] {
  const root = join(vaultRoot, "distill");
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no distill/ dir yet
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else if (e.name.endsWith(".md")) out.push(`distill/${childRel}`);
    }
  };
  walk(root, "");
  return out.sort();
}

async function distillAdapter() {
  return createDaftariAdapter({ answererModel: "stub", compile: "distill" }, { llm: distillStub() });
}

describe("distill compile arm — landing (hermetic)", () => {
  it("compiles a benchmark day into a landed, ratified claim doc", async () => {
    const adapter = await distillAdapter();
    const vault = await adapter.setup();
    try {
      await adapter.ingestDay(1, "The secret gemstone is sapphire.", META(1, "gemstones"));

      const landed = landedDistillDocs(vault);
      expect(landed.length).toBe(1);
      const body = readFileSync(join(vault, landed[0]), "utf8");
      // The compiled note carries the extracted claim...
      expect(body).toContain("The secret gemstone is sapphire.");
      // ...as a synthesized, ratified (not still-draft-pending) landing.
      expect(body).toContain("provenance: synthesized");
    } finally {
      await adapter.teardown();
    }
  });

  it("lands one doc per distinct day", async () => {
    const adapter = await distillAdapter();
    const vault = await adapter.setup();
    try {
      await adapter.ingestDay(1, "The secret gemstone is sapphire.", META(1, "gemstones"));
      await adapter.ingestDay(2, "Lunch was ramen near the office.", META(2, "food"));
      expect(landedDistillDocs(vault).length).toBe(2);
    } finally {
      await adapter.teardown();
    }
  });
});

describe("distill compile arm — determinism (hermetic)", () => {
  it("lands the identical set of claim paths across two identical runs", async () => {
    const run = async (): Promise<string[]> => {
      const adapter = await distillAdapter();
      const vault = await adapter.setup();
      try {
        await adapter.ingestDay(1, "The secret gemstone is sapphire.", META(1, "gemstones"));
        await adapter.ingestDay(2, "Lunch was ramen near the office.", META(2, "food"));
        return landedDistillDocs(vault);
      } finally {
        await adapter.teardown();
      }
    };
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.length).toBe(2);
    expect(a).toEqual(b);
  });
});

describe.skipIf(!RUN)("distill compile arm — queryable (integration)", () => {
  it("reindexes the landed distilled claims cleanly (the R16 gate)", async () => {
    const adapter = await distillAdapter();
    const vault = await adapter.setup();
    try {
      await adapter.ingestDay(1, "The secret gemstone is sapphire.", META(1, "gemstones"));
      await adapter.ingestDay(2, "Lunch was ramen near the office.", META(2, "food"));
      // Real MiniLM reindex; assertCleanReindex inside must NOT throw on the
      // landed synthesized/draft docs (no coerced frontmatter, none skipped,
      // vectors on). That clean reindex is what makes the arm queryable and the
      // benchmark number reproducible.
      await expect(adapter.finalizeIngestion()).resolves.toBeUndefined();
      expect(landedDistillDocs(vault).length).toBe(2);
    } finally {
      await adapter.teardown();
    }
  });
});
