// vault_ratify form-mode elicitation (spec 2026-07-26, Decision 5), driven
// end-to-end over the 2026-07-28 wire: the server answers a decision-less
// vault_ratify with an input_required form plus HMAC-signed opaque state, the
// client fulfils it through its elicitation/create handler, and the SDK
// retries the call with the answer and the echoed state — the server
// remembers nothing in between. The default (and only safe preselection) is
// reject; a declined form applies nothing and leaves the action pending.

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../src/access/rbac.js";
import { getStagedActionById } from "../src/curation/staged-actions.js";
import { createServer } from "../src/server.js";
import { vaultStageAction } from "../src/tools/staged-actions.js";
import { cleanupVault, makeTempVault } from "./helpers/temp-vault.js";

const RATIFIER: AccessContext = {
  user: "human:mihir",
  roleName: "ratifier",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

const HUMAN = "human:mihir";

// A `write` proposal is the cleanest approve fixture: dispatch creates a new
// draft document, so no tier-0 gate participates in the assertion.
async function stageWrite(vault: string): Promise<string> {
  const staged = await vaultStageAction(vault, {
    action_type: "write",
    target_path: "pricing/elicited.md",
    proposed_by: "agent:loop",
    rationale: "Synthesized from run traces.",
    proposed_diff: {
      frontmatter: {
        title: "Elicited",
        domain: "accumulation",
        collection: "pricing",
        status: "draft",
        confidence: "medium",
        created: "2026-07-28",
        provenance: "direct",
        sources: [],
        superseded_by: null,
        ttl_days: 90,
        tags: ["spec"],
      },
      body: "# Elicited\n\nProposed content.\n",
    },
  });
  if (!staged.ok) throw staged.error;
  return staged.value.id;
}

type ElicitAnswer =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

interface Harness {
  client: Client;
  // Every elicitation request the client saw, for asserting the form shape.
  seen: Array<{ message?: string; requestedSchema?: Record<string, unknown> }>;
  close: () => Promise<void>;
}

async function connectHarness(
  vault: string,
  access: AccessContext | undefined,
  answer: ElicitAnswer,
): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // serveStdio owns the era decision (a bare Server.connect speaks legacy
  // only); the injected in-memory transport keeps the harness in-process.
  const handle: StdioServerHandle = serveStdio(
    () => (access ? createServer(vault, access) : createServer(vault)),
    { transport: serverTransport },
  );

  const seen: Harness["seen"] = [];
  const client = new Client(
    { name: "ratify-elicitation-test", version: "0.0.0" },
    {
      capabilities: { elicitation: {} },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  client.setRequestHandler("elicitation/create", async (request) => {
    const params = request.params as {
      message?: string;
      requestedSchema?: Record<string, unknown>;
    };
    seen.push({ message: params.message, requestedSchema: params.requestedSchema });
    return answer;
  });
  await client.connect(clientTransport);
  return {
    client,
    seen,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

describe("vault_ratify form-mode elicitation (Decision 5)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("a decision-less call elicits a form (default reject) and an accepted approve applies", async () => {
    const id = await stageWrite(vault);
    const h = await connectHarness(vault, RATIFIER, {
      action: "accept",
      content: { decision: "approve" },
    });
    try {
      const res = await h.client.callTool({
        name: "vault_ratify",
        arguments: { id, principal: HUMAN },
      });
      expect(res.isError).toBeFalsy();
      const payload = res.structuredContent as {
        action_id: string;
        decision: string;
        applied: boolean;
      };
      expect(payload.action_id).toBe(id);
      expect(payload.decision).toBe("approve");
      expect(payload.applied).toBe(true);

      // The form the human saw: the action named in the prompt, and reject
      // preselected — the safe answer is the default one.
      expect(h.seen).toHaveLength(1);
      expect(h.seen[0]?.message).toContain(`Ratify staged action ${id}`);
      const schema = h.seen[0]?.requestedSchema as {
        properties?: { decision?: { enum?: string[]; default?: string } };
      };
      expect(schema?.properties?.decision?.enum).toEqual(["approve", "reject"]);
      expect(schema?.properties?.decision?.default).toBe("reject");
    } finally {
      await h.close();
    }
  }, 60_000);

  it("a declined form applies nothing and leaves the action pending", async () => {
    const id = await stageWrite(vault);
    const h = await connectHarness(vault, RATIFIER, { action: "decline" });
    try {
      const res = await h.client.callTool({
        name: "vault_ratify",
        arguments: { id, principal: HUMAN },
      });
      expect(res.isError).toBeFalsy();
      const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(text).toContain("remains pending");

      const action = await getStagedActionById(vault, id);
      expect(action.ok && action.value?.status).toBe("pending");
      expect(h.seen).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 60_000);

  it("a direct call with the decision inline never elicits", async () => {
    const id = await stageWrite(vault);
    const h = await connectHarness(vault, RATIFIER, {
      action: "accept",
      content: { decision: "approve" },
    });
    try {
      const res = await h.client.callTool({
        name: "vault_ratify",
        arguments: { id, decision: "reject", principal: HUMAN },
      });
      expect(res.isError).toBeFalsy();
      const payload = res.structuredContent as { decision: string; applied: boolean };
      expect(payload.decision).toBe("reject");
      expect(payload.applied).toBe(false);
      expect(h.seen).toHaveLength(0);
    } finally {
      await h.close();
    }
  }, 60_000);

  it("the gates run before any form: an unknown action errors, a role without the grant is denied", async () => {
    const id = await stageWrite(vault);

    const unknown = await connectHarness(vault, RATIFIER, {
      action: "accept",
      content: { decision: "approve" },
    });
    try {
      const res = await unknown.client.callTool({
        name: "vault_ratify",
        arguments: { id: "stage-nope", principal: HUMAN },
      });
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text?: string }>)[0]?.text).toContain("unknown staged action");
      expect(unknown.seen).toHaveLength(0);
    } finally {
      await unknown.close();
    }

    // The deny-all guest never sees a form — access denied before the round.
    const guest = await connectHarness(vault, undefined, {
      action: "accept",
      content: { decision: "approve" },
    });
    try {
      const res = await guest.client.callTool({
        name: "vault_ratify",
        arguments: { id, principal: HUMAN },
      });
      expect(res.isError).toBe(true);
      expect((res.content as Array<{ text?: string }>)[0]?.text).toContain("access denied");
      expect(guest.seen).toHaveLength(0);
    } finally {
      await guest.close();
    }
  }, 60_000);
});
