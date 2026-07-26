// Decision 6 of the 2026-07-26 MCP readiness spec: daftari has never used MCP
// sampling and formally never will. SEP-2577 deprecates it, and the reasons are
// daftari's own — sampling routes the server's LLM calls through whichever
// client happens to be connected, so a shared serve would have maintenance
// quality vary by client and the vault's epistemics depend on an unpinned,
// uninspectable model. The witness track records and eval baselines assume the
// judging model is an operator choice; it stays one.
//
// This test is what makes the decision enforceable rather than merely written
// down: the LLM-calling features (eval's judging, consolidate's synthesis,
// audit --semantic) call the provider directly, CLI-side, on the operator's own
// key. If someone reaches for createMessage to power a judge loop, this fails.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src", import.meta.url).pathname;

// Markers of the MCP sampling capability. `createMessage` is the sampling
// request; the capability key and request schemas are how a server would
// advertise or handle it.
const SAMPLING_MARKERS = [
  "createMessage",
  "CreateMessageRequestSchema",
  "CreateMessageResultSchema",
  "sampling:",
  "capabilities.sampling",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("MCP sampling is never adopted (spec 2026-07-26, Decision 6)", () => {
  it("no source file references the sampling capability", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf-8");
      for (const marker of SAMPLING_MARKERS) {
        if (text.includes(marker)) offenders.push(`${file.slice(SRC.length + 1)}: ${marker}`);
      }
    }
    expect(
      offenders,
      "MCP sampling is deprecated (SEP-2577) and deliberately not adopted — " +
        "LLM calls stay CLI-side against the operator's own key. " +
        "See docs/superpowers/specs/2026-07-26-mcp-2026-07-28-readiness-design.md, Decision 6.",
    ).toEqual([]);
  });

  it("the server declares only the capabilities it implements", async () => {
    const serverSrc = readFileSync(join(SRC, "server.ts"), "utf-8");
    // tools and resources are implemented; sampling is not, and an unimplemented
    // capability declaration is a promise the server cannot keep.
    expect(serverSrc).toContain("capabilities: { tools: {}, resources: {} }");
    expect(serverSrc).not.toContain("sampling");
  });
});
