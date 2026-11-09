// #640 — vault_patch: change named frontmatter fields and exact-match body
// spans without resending the document. It shares vault_write's write core, so
// these tests pin the patch contract and the guards it must inherit rather
// than re-testing the core's merge, hook, and leak-gate machinery wholesale.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { listStagedActions } from "../../src/curation/staged-actions.js";
import { parseDocument } from "../../src/frontmatter/parser.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultRatify } from "../../src/tools/staged-actions.js";
import { vaultAppend, vaultPatch, writeTools } from "../../src/tools/write.js";
import { sha256Hex } from "../../src/utils/hash.js";
import { withInjectedRace } from "../helpers/inject-race.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";
const REASON = "correcting the audited figures";
const PATH = "pricing/plan.md";
const BODY = "# Plan\n\nThe price is 100 and the seat cap is 25.\n\nNotes follow.\n";

function seed(vault: string, relPath: string, fields: string[] = [], body = BODY): void {
  const abs = join(vault, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    "---\ntitle: Plan\ndomain: accumulation\ncollection: pricing\nstatus: canonical\n" +
      "confidence: high\ncreated: 2026-05-01\nupdated: 2026-05-01\nupdated_by: human:mihir\n" +
      `provenance: direct\nttl_days: 30\ntags:\n  - pricing\n${fields.join("\n")}${
        fields.length > 0 ? "\n" : ""
      }---\n\n${body}`,
  );
}

function onDisk(vault: string, relPath: string = PATH): string {
  return readFileSync(join(vault, relPath), "utf-8");
}

function raw(vault: string, relPath: string = PATH): Record<string, unknown> {
  const parsed = parseDocument(onDisk(vault, relPath));
  if (!parsed.ok) throw parsed.error;
  return parsed.value.raw;
}

function bodyOf(vault: string, relPath: string = PATH): string {
  const parsed = parseDocument(onDisk(vault, relPath));
  if (!parsed.ok) throw parsed.error;
  return parsed.value.content;
}

function patch(args: Record<string, unknown> = {}): Record<string, unknown> {
  return { path: PATH, agent: AGENT, reason: REASON, ...args };
}

describe("vault_patch (#640)", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
    seed(vault, PATH);
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  describe("frontmatter", () => {
    it("changes one field and leaves the body byte-identical", async () => {
      const bodyBefore = bodyOf(vault);
      const result = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }));
      if (!result.ok) throw result.error;

      expect(result.value.action).toBe("patch");
      expect(raw(vault).ttl_days).toBe(90);
      expect(raw(vault).title).toBe("Plan");
      expect(bodyOf(vault)).toBe(bodyBefore);
    });

    it("merges tags and sources as whole-field replacements", async () => {
      const result = await vaultPatch(
        vault,
        patch({ frontmatter: { tags: ["pricing", "audited"], sources: ["https://a.example"] } }),
      );
      if (!result.ok) throw result.error;
      expect(raw(vault).tags).toEqual(["pricing", "audited"]);
      expect(raw(vault).sources).toEqual(["https://a.example"]);
    });

    it("warns about amends only when the patch sets them (#643)", async () => {
      seed(vault, PATH, ["amends:", "  - pricing/nope.md"]);
      const unrelated = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }));
      if (!unrelated.ok) throw unrelated.error;
      expect(unrelated.value.amends_warnings).toBeUndefined();

      const set = await vaultPatch(vault, patch({ frontmatter: { amends: ["pricing/gone.md"] } }));
      if (!set.ok) throw set.error;
      expect(set.value.amends_warnings?.[0]).toContain("pricing/gone.md");
    });

    it("deletes a field on explicit null, matching vault_write's opt-in deletion", async () => {
      seed(vault, PATH, ["custom_note: remove me"]);
      const result = await vaultPatch(vault, patch({ frontmatter: { custom_note: null } }));
      if (!result.ok) throw result.error;
      expect(raw(vault)).not.toHaveProperty("custom_note");
    });

    it("preserves undeclared custom fields it was not asked to touch (#113)", async () => {
      seed(vault, PATH, ["custom_note: keep me"]);
      const result = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }));
      if (!result.ok) throw result.error;
      expect(raw(vault).custom_note).toBe("keep me");
    });

    it("patches an undeclared custom field (the no-change guard must see raw keys)", async () => {
      seed(vault, PATH, ["custom_note: old"]);
      const result = await vaultPatch(vault, patch({ frontmatter: { custom_note: "new" } }));
      if (!result.ok) throw result.error;
      expect(raw(vault).custom_note).toBe("new");
    });

    it("stamps updated and updated_by, and preserves created", async () => {
      const result = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }));
      if (!result.ok) throw result.error;
      const today = new Date().toISOString().slice(0, 10);
      expect(result.value.updated).toBe(today);
      expect(raw(vault).updated_by).toBe(AGENT);
      expect(String(raw(vault).created)).toContain("2026-05-01");
    });

    it("rejects a value the schema rejects, writing nothing", async () => {
      const before = onDisk(vault);
      const result = await vaultPatch(vault, patch({ frontmatter: { domain: "nonsense" } }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("invalid frontmatter");
      expect(onDisk(vault)).toBe(before);
    });

    it("refuses to delete a required field", async () => {
      const result = await vaultPatch(vault, patch({ frontmatter: { title: null } }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("title");
    });

    it.each([
      ["status", "canonical", "vault_unsupersede"],
      ["superseded_by", "pricing/other.md", "vault_supersede"],
      ["superseded_by", null, "vault_unsupersede"],
      ["tier", "manual", "vault_set_tier"],
      ["collection", "secrets", "vault_write"],
      ["positions", [], "vault_assert"],
      ["org_position", null, "vault_assert"],
      ["contested", null, "vault_assert"],
      ["created", "2020-01-01", "server"],
      ["updated", "2020-01-01", "server"],
      ["updated_by", "human:someone", "server"],
    ])("refuses reserved field %s = %j, pointing at %s", async (field, value, pointer) => {
      const before = onDisk(vault);
      const result = await vaultPatch(vault, patch({ frontmatter: { [field]: value } }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain(`'${field}'`);
      expect(result.error.message).toContain(pointer);
      expect(onDisk(vault)).toBe(before);
    });

    it("allows confidence and the validity window", async () => {
      const result = await vaultPatch(
        vault,
        patch({ frontmatter: { confidence: "low", valid_until: "2026-06-01" } }),
      );
      if (!result.ok) throw result.error;
      expect(raw(vault).confidence).toBe("low");
      expect(String(raw(vault).valid_until)).toContain("2026-06-01");
    });
  });

  describe("body_edits", () => {
    it("replaces an exact span and leaves frontmatter alone", async () => {
      const result = await vaultPatch(
        vault,
        patch({ body_edits: [{ old: "price is 100", new: "price is 120" }] }),
      );
      if (!result.ok) throw result.error;
      expect(bodyOf(vault)).toContain("The price is 120 and the seat cap is 25.");
      expect(raw(vault).ttl_days).toBe(30);
    });

    it("applies several edits in order, each against the running body", async () => {
      const result = await vaultPatch(
        vault,
        patch({
          body_edits: [
            { old: "price is 100", new: "price is 120" },
            { old: "price is 120 and", new: "price is 130 and" },
            { old: "seat cap is 25", new: "seat cap is 50" },
          ],
        }),
      );
      if (!result.ok) throw result.error;
      expect(bodyOf(vault)).toContain("The price is 130 and the seat cap is 50.");
    });

    it("deletes a span when new is empty", async () => {
      const result = await vaultPatch(
        vault,
        patch({ body_edits: [{ old: "\n\nNotes follow.", new: "" }] }),
      );
      if (!result.ok) throw result.error;
      expect(bodyOf(vault)).not.toContain("Notes follow.");
    });

    it("refuses an edit with no match, naming the index but not the text", async () => {
      const before = onDisk(vault);
      const result = await vaultPatch(
        vault,
        patch({
          body_edits: [
            { old: "price is 100", new: "price is 120" },
            { old: "SECRET-PROBE-TEXT", new: "x" },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("body_edits[1]");
      expect(result.error.message).toContain("0");
      expect(result.error.message).not.toContain("SECRET-PROBE-TEXT");
      // All-or-nothing: the first, matching edit did not land either.
      expect(onDisk(vault)).toBe(before);
    });

    it("refuses an edit matching more than once, naming the count", async () => {
      seed(vault, PATH, [], "alpha beta\n\nalpha gamma\n");
      const result = await vaultPatch(vault, patch({ body_edits: [{ old: "alpha", new: "z" }] }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("body_edits[0]");
      expect(result.error.message).toContain("2");
    });

    it.each([
      ["an empty old", [{ old: "", new: "x" }]],
      ["old equal to new", [{ old: "price", new: "price" }]],
      ["a non-string new", [{ old: "price", new: 3 }]],
      ["a non-object entry", ["price"]],
      ["an empty array alongside nothing else", []],
    ])("refuses %s", async (_label, body_edits) => {
      const result = await vaultPatch(vault, patch({ body_edits }));
      expect(result.ok).toBe(false);
    });

    it("refuses more than 50 edits", async () => {
      const body_edits = Array.from({ length: 51 }, (_, i) => ({ old: `a${i}`, new: `b${i}` }));
      const result = await vaultPatch(vault, patch({ body_edits }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("50");
    });

    it("carries supersede_hint on a body patch but not on a frontmatter-only patch", async () => {
      const fm = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }));
      if (!fm.ok) throw fm.error;
      expect(fm.value.supersede_hint).toBeUndefined();

      const body = await vaultPatch(
        vault,
        patch({ body_edits: [{ old: "price is 100", new: "price is 120" }] }),
      );
      if (!body.ok) throw body.error;
      expect(body.value.supersede_hint).toBeDefined();
    });
  });

  describe("input and no-op refusals", () => {
    it("requires a reason", async () => {
      const result = await vaultPatch(vault, {
        path: PATH,
        agent: AGENT,
        frontmatter: { ttl_days: 90 },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("'reason'");
    });

    it("requires frontmatter or body_edits", async () => {
      const result = await vaultPatch(vault, patch());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("frontmatter");
      expect(result.error.message).toContain("body_edits");
    });

    it("refuses a non-object frontmatter", async () => {
      const result = await vaultPatch(vault, patch({ frontmatter: ["ttl_days"] }));
      expect(result.ok).toBe(false);
    });

    it("refuses a patch to a document that does not exist, never creating it", async () => {
      const result = await vaultPatch(
        vault,
        patch({ path: "pricing/absent.md", frontmatter: { ttl_days: 90 } }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("document not found");
    });

    it("refuses a patch that changes nothing, without a churn commit", async () => {
      const before = onDisk(vault);
      const result = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 30 } }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("changes nothing");
      expect(onDisk(vault)).toBe(before);
    });
  });

  describe("provenance and commit", () => {
    it("logs tool, action, who, why, and the frontmatter diff", async () => {
      const result = await vaultPatch(
        vault,
        patch({ frontmatter: { ttl_days: 90 }, run_id: "run-640" }),
      );
      if (!result.ok) throw result.error;

      const log = await readProvenanceLog(vault);
      if (!log.ok) throw log.error;
      const entry = log.value.find((e) => e.tool === "vault_patch");
      expect(entry).toMatchObject({
        action: "patch",
        file: PATH,
        agent: AGENT,
        reason: REASON,
        run_id: "run-640",
        body_changed: false,
      });
      expect(entry?.frontmatter_diff?.ttl_days).toEqual({ before: 30, after: 90 });
    });

    it("marks body_changed on a body patch", async () => {
      const result = await vaultPatch(
        vault,
        patch({ body_edits: [{ old: "price is 100", new: "price is 120" }] }),
      );
      if (!result.ok) throw result.error;
      const log = await readProvenanceLog(vault);
      if (!log.ok) throw log.error;
      expect(log.value.find((e) => e.tool === "vault_patch")?.body_changed).toBe(true);
    });

    it("auto-commits with the reason in the subject", async () => {
      const result = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }));
      if (!result.ok) throw result.error;
      expect(result.value.committed).toBe(true);
      expect(result.value.commit).toBeTruthy();
      const subject = execFileSync("git", ["log", "-1", "--format=%s"], {
        cwd: vault,
        encoding: "utf-8",
      });
      expect(subject).toContain("vault_patch");
      expect(subject).toContain(REASON);
    });
  });

  describe("optimistic concurrency", () => {
    it("accepts the version vault_read returned", async () => {
      const read = await vaultRead(vault, PATH);
      if (!read.ok) throw read.error;
      const result = await vaultPatch(
        vault,
        patch({ base_version: read.value.version, frontmatter: { ttl_days: 90 } }),
      );
      expect(result.ok).toBe(true);
    });

    it("rejects an explicit stale base_version as stale, not as a failed match", async () => {
      const stale = sha256Hex(onDisk(vault));
      const moved = await vaultPatch(
        vault,
        patch({ body_edits: [{ old: "price is 100", new: "price is 120" }] }),
      );
      if (!moved.ok) throw moved.error;

      const before = onDisk(vault);
      const result = await vaultPatch(
        vault,
        patch({
          base_version: stale,
          body_edits: [{ old: "price is 100", new: "price is 130" }],
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/^stale write:/);
      expect(onDisk(vault)).toBe(before);

      const log = await readProvenanceLog(vault);
      if (!log.ok) throw log.error;
      expect(log.value.map((e) => e.action)).toContain("rejected_stale");
    });

    it("retries once when base_version is omitted, keeping the concurrent change", async () => {
      const result = await withInjectedRace(
        join(vault, PATH),
        async () => {
          const appended = await vaultAppend(vault, {
            path: PATH,
            section: "## Concurrent\n\nLanded mid-patch.",
            agent: "agent:other",
          });
          if (!appended.ok) throw appended.error;
        },
        () =>
          vaultPatch(
            vault,
            patch({
              frontmatter: { ttl_days: 90 },
              body_edits: [{ old: "price is 100", new: "price is 120" }],
            }),
          ),
      );
      if (!result.ok) throw result.error;
      expect(raw(vault).ttl_days).toBe(90);
      expect(bodyOf(vault)).toContain("price is 120");
      expect(bodyOf(vault)).toContain("Landed mid-patch.");
    });
  });

  describe("inherited write guards", () => {
    it("refuses a body edit on tier: source but allows a frontmatter patch", async () => {
      seed(vault, PATH, ["tier: source"]);
      const body = await vaultPatch(
        vault,
        patch({ body_edits: [{ old: "price is 100", new: "price is 120" }] }),
      );
      expect(body.ok).toBe(false);
      if (!body.ok) expect(body.error.message).toContain("vault_patch");

      const fm = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }));
      expect(fm.ok).toBe(true);
    });

    it("refuses an agent's body edit on tier: manual but allows a human's", async () => {
      seed(vault, PATH, ["tier: manual"]);
      const agentEdit = await vaultPatch(
        vault,
        patch({ body_edits: [{ old: "price is 100", new: "price is 120" }] }),
      );
      expect(agentEdit.ok).toBe(false);

      const humanEdit = await vaultPatch(
        vault,
        patch({
          agent: "human:mihir",
          body_edits: [{ old: "price is 100", new: "price is 120" }],
        }),
      );
      expect(humanEdit.ok).toBe(true);
    });

    it("runs pre_write hooks, and a hook issue blocks the patch", async () => {
      mkdirSync(join(vault, ".daftari/hooks"), { recursive: true });
      writeFileSync(
        join(vault, ".daftari/hooks/block.mjs"),
        'export default () => [{ field: "ttl_days", message: "hook says no" }];\n',
      );
      writeFileSync(
        join(vault, ".daftari/config.yaml"),
        "hooks:\n  pre_write:\n    - path: .daftari/hooks/block.mjs\n",
      );
      const before = onDisk(vault);
      const result = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("hook says no");
      expect(onDisk(vault)).toBe(before);
    });

    it("writes nothing under shadow_mode", async () => {
      mkdirSync(join(vault, ".daftari"), { recursive: true });
      writeFileSync(join(vault, ".daftari/config.yaml"), "version: 1\nshadow_mode: true\n");
      const before = onDisk(vault);
      const result = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }));
      if (!result.ok) throw result.error;
      expect(result.value.shadow).toBe(true);
      expect(onDisk(vault)).toBe(before);
    });
  });

  describe("access control", () => {
    const WRITER = {
      user: "alice",
      roleName: "writer",
      role: { read: ["pricing"], write: ["pricing"] },
    };

    it("denies a role that cannot write the collection, before any I/O", async () => {
      const result = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }), {
        user: "bob",
        roleName: "reader",
        role: { read: ["pricing"], write: [] },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("cannot write");
    });

    it("gives a write-only role no read oracle: denied, and the same for absent docs", async () => {
      const writeOnly = {
        user: "carol",
        roleName: "write-only",
        role: { read: [], write: ["pricing"] },
      };
      const present = await vaultPatch(
        vault,
        patch({ body_edits: [{ old: "price is 100", new: "x" }] }),
        writeOnly,
      );
      const absent = await vaultPatch(
        vault,
        patch({ path: "pricing/absent.md", body_edits: [{ old: "price is 100", new: "x" }] }),
        writeOnly,
      );
      expect(present.ok).toBe(false);
      expect(absent.ok).toBe(false);
      if (present.ok || absent.ok) return;
      expect(present.error.message).toContain("cannot read");
      expect(absent.error.message).toBe(present.error.message);
    });

    it("also gates the declared collection, not only the physical directory", async () => {
      writeFileSync(
        join(vault, PATH),
        onDisk(vault).replace("collection: pricing", "collection: secrets"),
      );
      const result = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }), WRITER);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("secrets");
    });

    it("lands for a role that can read and write", async () => {
      const result = await vaultPatch(vault, patch({ frontmatter: { ttl_days: 90 } }), WRITER);
      if (!result.ok) throw result.error;
      expect(raw(vault).ttl_days).toBe(90);

      const log = await readProvenanceLog(vault);
      if (!log.ok) throw log.error;
      expect(log.value.find((e) => e.tool === "vault_patch")?.principal).toBe("alice");
    });
  });

  describe("propose-only", () => {
    const PROPOSER = {
      user: "agent:proposer",
      roleName: "agent-proposer",
      role: { read: ["*"], write: ["*"], promote: false, ratify: false, proposeOnly: true },
    };
    const ADMIN = {
      user: "human:mihir",
      roleName: "admin",
      role: { read: ["*"], write: ["*"], promote: true, ratify: true },
    };
    const EDITS = [{ old: "price is 100", new: "price is 120" }];

    it("stages a write proposal, using the reason and carrying the edits for display", async () => {
      const before = onDisk(vault);
      const result = await vaultPatch(
        vault,
        patch({ agent: "agent:proposer", frontmatter: { ttl_days: 90 }, body_edits: EDITS }),
        PROPOSER,
      );
      if (!result.ok) throw result.error;
      expect(result.value.action).toBe("staged");
      expect(onDisk(vault)).toBe(before);

      const staged = await listStagedActions(vault, "pending");
      if (!staged.ok) throw staged.error;
      const action = staged.value.find((a) => a.id === result.value.staged_id);
      expect(action?.actionType).toBe("write");
      expect(action?.rationale).toBe(REASON);
      expect(action?.proposedDiff).toMatchObject({
        frontmatter: { ttl_days: 90 },
        body_edits: EDITS,
      });
    });

    it("lands the same change on ratify", async () => {
      const staged = await vaultPatch(
        vault,
        patch({ agent: "agent:proposer", frontmatter: { ttl_days: 90 }, body_edits: EDITS }),
        PROPOSER,
      );
      if (!staged.ok) throw staged.error;
      const ratified = await vaultRatify(
        vault,
        { id: staged.value.staged_id, decision: "approve", principal: "human:mihir" },
        ADMIN,
      );
      if (!ratified.ok) throw ratified.error;
      expect(raw(vault).ttl_days).toBe(90);
      expect(bodyOf(vault)).toContain("price is 120");
      expect(raw(vault).title).toBe("Plan");
    });

    it("refuses a patch that changes nothing, staging no proposal", async () => {
      const result = await vaultPatch(
        vault,
        patch({ agent: "agent:proposer", frontmatter: { ttl_days: 30 } }),
        PROPOSER,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("changes nothing");
      const staged = await listStagedActions(vault, "pending");
      if (!staged.ok) throw staged.error;
      expect(staged.value).toHaveLength(0);
    });

    it("refuses reserved fields before staging", async () => {
      const result = await vaultPatch(
        vault,
        patch({ agent: "agent:proposer", frontmatter: { status: "draft" } }),
        PROPOSER,
      );
      expect(result.ok).toBe(false);
      const staged = await listStagedActions(vault, "pending");
      if (!staged.ok) throw staged.error;
      expect(staged.value).toHaveLength(0);
    });
  });

  it("sends under 1 KB to change ttl_days on a 15 KB document (acceptance)", async () => {
    const paragraph = "A paragraph of accumulated pricing notes, ".repeat(10);
    seed(vault, PATH, [], `# Plan\n\n${`${paragraph}\n\n`.repeat(40)}`);
    expect(Buffer.byteLength(onDisk(vault))).toBeGreaterThan(15_000);

    const request = patch({
      base_version: sha256Hex(onDisk(vault)),
      frontmatter: { ttl_days: 90 },
    });
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(1024);

    const result = await vaultPatch(vault, request);
    if (!result.ok) throw result.error;
    expect(raw(vault).ttl_days).toBe(90);
  });

  it("is registered with the patch action in its output schema", () => {
    const tool = writeTools.find((t) => t.name === "vault_patch");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool?.outputSchema)).toContain('"patch"');
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });
});
