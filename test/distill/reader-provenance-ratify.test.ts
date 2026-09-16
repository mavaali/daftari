// test/distill/reader-provenance-ratify.test.ts
//
// THE H3 PROOF (f3h). End-to-end: build a temp vault whose .daftari/config.yaml
// declares the reader_* fields as DECLARED-OPTIONAL schema_extensions, stage a
// distill proposal carrying run_meta, and assert:
//
//   1. vault_ratify APPROVE lands the write (applied: true, real commit), and
//   2. the reader_* fields serialize TYPED into the landed file (numbers as
//      numbers, booleans as booleans, the readers SET as a YAML sequence), and
//   3. a subsequent FRONTMATTER-ONLY rewrite (vault_set_tier) PRESERVES every
//      reader field — including reader_via_retry: false (false must survive;
//      only null is dropped by the extension serializer).
//
// This proves reader provenance stamped at ingest ratifies cleanly and is
// durable across later frontmatter edits.

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStagedActionById } from "../../src/curation/staged-actions.js";
import type { ClaimRunMeta, ExtractedClaim } from "../../src/distill/extract.js";
import { proposeAllClaims } from "../../src/distill/propose.js";
import { encodeReader, READER_PROMPT_VERSION } from "../../src/distill/reader-fingerprint.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultRatify } from "../../src/tools/staged-actions.js";
import { vaultSetTier } from "../../src/tools/write.js";
import { clearConfigCache } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const HUMAN = "human:mihir";

// A vault config declaring the reader_* fields as OPTIONAL schema extensions —
// the exact block an operator copies from docs/schema-extensions.md. Order here
// is the serialization order for the extension fields.
const READER_EXTENSIONS_CONFIG = `version: 1
vault_name: reader-prov-test
schema_extensions:
  reader_model:
    type: string
  reader_served_model:
    type: string
  reader_temperature:
    type: number
  reader_via_retry:
    type: boolean
  reader_prompt_version:
    type: string
  reader_chunk_window:
    type: number
  reader_input_cap:
    type: number
  readers:
    type: array
    items: string
`;

function makeRunMeta(overrides: Partial<ClaimRunMeta> = {}): ClaimRunMeta {
  return {
    requestedModel: "claude-opus-4",
    servedModel: "claude-opus-4-20260101",
    effectiveTemperature: 0,
    viaRetry: false,
    chunkWindow: 12,
    inputCap: 8000,
    ...overrides,
  };
}

function makeClaim(runMeta: ClaimRunMeta): ExtractedClaim {
  return {
    claim_key: "chunk-h3:reader-ratify-proof-abcd1234",
    statement: "The reader fingerprint must ratify cleanly and serialize typed.",
    proposed_frontmatter: { title: "Reader ratify proof" },
    run_meta: runMeta,
  };
}

describe("f3h H3 proof: distill reader provenance ratifies and persists", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
    // makeTempVault skips the fixture's .daftari dir — write our own config
    // declaring the reader_* extensions, then clear the config cache so the
    // fresh declaration is picked up by loadConfig on this vault path.
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, ".daftari", "config.yaml"), READER_EXTENSIONS_CONFIG, "utf-8");
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    cleanupVault(vault);
  });

  it("stage → ratify approve lands the write, reader_* serialize typed, and survive a later set_tier", async () => {
    const runMeta = makeRunMeta();
    const claim = makeClaim(runMeta);
    const runId = "run-h3-proof";

    // --- Stage the distill proposal carrying run_meta ---------------------
    const outcome = await proposeAllClaims(vault, [claim], { sourceId: "chat-export-h3", runId });
    expect(outcome.proposed).toBe(1);
    expect(outcome.errors).toHaveLength(0);
    const [staged] = outcome.results;
    if (!staged) throw new Error("expected a staged result");
    const targetPath = staged.targetPath;

    // --- Ratify APPROVE — this is the H3 assertion ------------------------
    const ratified = await vaultRatify(vault, {
      id: staged.id,
      decision: "approve",
      principal: HUMAN,
      reason: "reader provenance proof",
    });
    // H3 PROOF: the ratify lands the write.
    expect(ratified.ok).toBe(true);
    if (!ratified.ok) throw ratified.error;
    expect(ratified.value.applied).toBe(true);
    expect(ratified.value.commit).toMatch(/^[0-9a-f]+$/);

    // The staged action collapsed to ratified.
    const action = await getStagedActionById(vault, staged.id);
    expect(action.ok && action.value?.status).toBe("ratified");

    // --- The reader_* fields serialized TYPED into the landed file --------
    // Parse the file's raw YAML frontmatter directly so we assert on YAML
    // TYPES, not on the validator's coercions.
    const fileText = await readFile(join(vault, targetPath), "utf-8");
    const fmBlock = fileText.split("---")[1] ?? "";
    const raw = loadYaml(fmBlock) as Record<string, unknown>;

    expect(raw.reader_model).toBe("claude-opus-4");
    expect(typeof raw.reader_model).toBe("string");
    expect(raw.reader_served_model).toBe("claude-opus-4-20260101");
    // number stays a number
    expect(raw.reader_temperature).toBe(0);
    expect(typeof raw.reader_temperature).toBe("number");
    expect(raw.reader_chunk_window).toBe(12);
    expect(typeof raw.reader_chunk_window).toBe("number");
    expect(raw.reader_input_cap).toBe(8000);
    expect(typeof raw.reader_input_cap).toBe("number");
    // boolean stays a boolean
    expect(raw.reader_via_retry).toBe(false);
    expect(typeof raw.reader_via_retry).toBe("boolean");
    expect(raw.reader_prompt_version).toBe(READER_PROMPT_VERSION);
    // the readers SET is a YAML sequence with the one ingest entry
    expect(Array.isArray(raw.readers)).toBe(true);
    expect(raw.readers).toEqual([encodeReader(runMeta, READER_PROMPT_VERSION)]);

    // vaultRead surfaces the extension fields in parsed raw too.
    const read = await vaultRead(vault, targetPath);
    expect(read.ok).toBe(true);
    if (!read.ok) throw read.error;
    expect(read.value.raw.reader_via_retry).toBe(false);

    // --- A frontmatter-only rewrite preserves them (incl. false) ----------
    const setTier = await vaultSetTier(vault, {
      path: targetPath,
      agent: HUMAN,
      reason: "protect the belief",
      tier: "compiled",
    });
    if (!setTier.ok) throw setTier.error;
    expect(setTier.ok).toBe(true);

    const afterText = await readFile(join(vault, targetPath), "utf-8");
    const afterFm = loadYaml(afterText.split("---")[1] ?? "") as Record<string, unknown>;

    // Every reader field survives the set_tier rewrite.
    expect(afterFm.reader_model).toBe("claude-opus-4");
    expect(afterFm.reader_served_model).toBe("claude-opus-4-20260101");
    expect(afterFm.reader_temperature).toBe(0);
    expect(afterFm.reader_chunk_window).toBe(12);
    expect(afterFm.reader_input_cap).toBe(8000);
    expect(afterFm.reader_prompt_version).toBe(READER_PROMPT_VERSION);
    expect(afterFm.readers).toEqual([encodeReader(runMeta, READER_PROMPT_VERSION)]);
    // The load-bearing case: false is NOT dropped (only null is).
    expect(afterFm.reader_via_retry).toBe(false);
    expect(typeof afterFm.reader_via_retry).toBe("boolean");
    // And the tier edit did land.
    expect(afterFm.tier).toBe("compiled");
  }, 60_000);
});
