import { describe, expect, it } from "vitest";
import {
  derivationUserBody,
  parseDerivationVerdict,
} from "../../src/consolidate/derivation-prompt.js";

describe("parseDerivationVerdict", () => {
  it("accepts a directed verdict {related:true, premise:'A'}", () => {
    const r = parseDerivationVerdict({ related: true, premise: "A", reason: "A founds B" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ related: true, premise: "A", reason: "A founds B" });
  });

  it("accepts premise:'symmetric'", () => {
    const r = parseDerivationVerdict({ related: true, premise: "symmetric", reason: "mutual" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.premise).toBe("symmetric");
  });

  it("accepts related:false and ignores premise (-> null)", () => {
    const r = parseDerivationVerdict({ related: false, reason: "no dependency" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ related: false, premise: null, reason: "no dependency" });
  });

  it("rejects a bad premise when related is true", () => {
    const r = parseDerivationVerdict({ related: true, premise: "C", reason: "x" });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing/non-boolean related", () => {
    expect(parseDerivationVerdict({ premise: "A", reason: "x" }).ok).toBe(false);
    expect(parseDerivationVerdict({ related: "yes", premise: "A", reason: "x" }).ok).toBe(false);
  });

  it("rejects a missing reason", () => {
    expect(parseDerivationVerdict({ related: true, premise: "A" }).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(parseDerivationVerdict(null).ok).toBe(false);
    expect(parseDerivationVerdict("nope").ok).toBe(false);
    expect(parseDerivationVerdict([1]).ok).toBe(false);
  });
});

describe("derivationUserBody", () => {
  const body = derivationUserBody("a.md", "claim A content", "b.md", "claim B content");

  it("contains neither 'derive' nor a template tag", () => {
    expect(body.toLowerCase()).not.toContain("derive");
    expect(body).not.toContain("[template:");
  });

  it("asks for the foundational / premise framing and includes both docs", () => {
    expect(body.toLowerCase()).toContain("foundational");
    expect(body.toLowerCase()).toContain("premise");
    expect(body).toContain("claim A content");
    expect(body).toContain("claim B content");
    expect(body).toContain("a.md");
    expect(body).toContain("b.md");
  });
});
