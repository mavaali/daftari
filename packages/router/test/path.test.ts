import { describe, expect, it } from "vitest";
import { formatVaultPath, parseVaultPath } from "../src/path.js";

describe("vault path", () => {
  it("parses vault:path", () => {
    expect(parseVaultPath("devops:runbooks/k8s.md")).toEqual({
      vault: "devops",
      path: "runbooks/k8s.md",
    });
  });
  it("handles nested colons in path correctly (only first colon splits)", () => {
    expect(parseVaultPath("devops:runbooks/k8s:notes.md")).toEqual({
      vault: "devops",
      path: "runbooks/k8s:notes.md",
    });
  });
  it("returns null vault when no prefix", () => {
    expect(parseVaultPath("runbooks/k8s.md")).toEqual({ vault: null, path: "runbooks/k8s.md" });
  });
  it("formats vault + path", () => {
    expect(formatVaultPath("devops", "runbooks/k8s.md")).toBe("devops:runbooks/k8s.md");
  });
});
