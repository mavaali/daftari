import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("applies defaults when only answererModel is supplied", () => {
    const result = parseConfig({ answererModel: "claude-opus-4-8" });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value).toEqual({
      answererModel: "claude-opus-4-8",
      maxSearchResults: 15,
      agentMaxIterations: 6,
      timestamps: "on",
      answererTransport: "anthropic",
      compile: "raw",
      authoringModel: "claude-opus-4-8",
    });
  });

  it("honors supplied overrides", () => {
    const result = parseConfig({
      answererModel: "claude-sonnet-4-5",
      maxSearchResults: 30,
      agentMaxIterations: 10,
    });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value).toEqual({
      answererModel: "claude-sonnet-4-5",
      maxSearchResults: 30,
      agentMaxIterations: 10,
      timestamps: "on",
      answererTransport: "anthropic",
      compile: "raw",
      authoringModel: "claude-sonnet-4-5",
    });
  });

  it("defaults the timestamps axis to on", () => {
    const result = parseConfig({ answererModel: "claude-opus-4-8" });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value.timestamps).toBe("on");
  });

  it("honors an explicit timestamps: off", () => {
    const result = parseConfig({ answererModel: "claude-opus-4-8", timestamps: "off" });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value.timestamps).toBe("off");
  });

  it("errors on an invalid timestamps value", () => {
    expect(parseConfig({ answererModel: "claude-opus-4-8", timestamps: "maybe" }).ok).toBe(false);
  });

  it("defaults answererTransport to anthropic", () => {
    const result = parseConfig({ answererModel: "claude-opus-4-8" });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value.answererTransport).toBe("anthropic");
  });

  it("honors an explicit answererTransport: openrouter", () => {
    const result = parseConfig({
      answererModel: "anthropic/claude-haiku-4.5",
      answererTransport: "openrouter",
    });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value.answererTransport).toBe("openrouter");
  });

  it("errors on an invalid answererTransport value", () => {
    expect(
      parseConfig({ answererModel: "claude-opus-4-8", answererTransport: "grok" }).ok,
    ).toBe(false);
  });

  it("errors when answererModel is missing", () => {
    const result = parseConfig({});
    expect(result.ok).toBe(false);
  });

  it("errors when answererModel is empty or non-string", () => {
    expect(parseConfig({ answererModel: "" }).ok).toBe(false);
    expect(parseConfig({ answererModel: "   " }).ok).toBe(false);
    expect(parseConfig({ answererModel: 42 }).ok).toBe(false);
  });

  it("rejects non-positive-integer numeric overrides", () => {
    const model = "claude-opus-4-8";
    expect(parseConfig({ answererModel: model, maxSearchResults: 0 }).ok).toBe(false);
    expect(parseConfig({ answererModel: model, maxSearchResults: -1 }).ok).toBe(false);
    expect(parseConfig({ answererModel: model, maxSearchResults: 1.5 }).ok).toBe(false);
    expect(parseConfig({ answererModel: model, maxSearchResults: "15" }).ok).toBe(false);
    expect(parseConfig({ answererModel: model, agentMaxIterations: 0 }).ok).toBe(false);
  });

  it("defaults compile to raw", () => {
    const result = parseConfig({ answererModel: "claude-opus-4-8" });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value.compile).toBe("raw");
  });

  it("honors explicit compile: write", () => {
    const result = parseConfig({ answererModel: "claude-opus-4-8", compile: "write" });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value.compile).toBe("write");
  });

  it("honors explicit compile: write+consolidate", () => {
    const result = parseConfig({ answererModel: "claude-opus-4-8", compile: "write+consolidate" });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value.compile).toBe("write+consolidate");
  });

  it("errors on an invalid compile value", () => {
    expect(parseConfig({ answererModel: "claude-opus-4-8", compile: "nope" }).ok).toBe(false);
  });

  it("defaults authoringModel to answererModel when omitted", () => {
    const result = parseConfig({ answererModel: "claude-opus-4-8" });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value.authoringModel).toBe("claude-opus-4-8");
  });

  it("honors an explicit authoringModel", () => {
    const result = parseConfig({
      answererModel: "claude-opus-4-8",
      authoringModel: "claude-sonnet-5",
    });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value.authoringModel).toBe("claude-sonnet-5");
  });
});
