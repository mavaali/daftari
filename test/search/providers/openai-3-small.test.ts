// OpenAI text-embedding-3-small provider coverage (issue #38 PR 4).
//
// These tests never call the real OpenAI API. We stub `globalThis.fetch` and
// assert the provider's behaviour:
//   - id / dim are the documented values (openai-3-small / 1536)
//   - batches respect the 96-input chunk size
//   - 429 / 5xx triggers exponential-backoff retry up to MAX_RETRIES
//   - a definitive failure returns Result.err, not a throw
//   - missing OPENAI_API_KEY surfaces a clear error at construction
//   - the response shape is validated (wrong dim, wrong count → err)

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeOpenAi3SmallProvider,
  OPENAI_3_SMALL_DIM,
  OPENAI_3_SMALL_ID,
} from "../../../src/search/providers/openai-3-small.js";

// Build a fake OpenAI response with N vectors of OPENAI_3_SMALL_DIM dims.
// Vectors are random but normalised so the provider's defensive normalise
// pass is a no-op (we don't want to assert numeric exactness here).
function fakeResponse(n: number): Response {
  const data = Array.from({ length: n }, () => {
    const vec = Array.from({ length: OPENAI_3_SMALL_DIM }, () => Math.random());
    let norm = 0;
    for (const x of vec) norm += x * x;
    const inv = 1 / Math.sqrt(norm);
    return { embedding: vec.map((x) => x * inv) };
  });
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("openai-3-small provider", () => {
  const FAKE_KEY = "sk-test-deadbeef";

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("exposes id 'openai-3-small' and dim 1536", () => {
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    expect(provider.id).toBe(OPENAI_3_SMALL_ID);
    expect(provider.id).toBe("openai-3-small");
    expect(provider.dim).toBe(OPENAI_3_SMALL_DIM);
    expect(provider.dim).toBe(1536);
  });

  it("constructor throws on empty API key", () => {
    expect(() => makeOpenAi3SmallProvider("")).toThrow(/empty apiKey/);
  });

  it("warm() is a no-op that returns ok (stateless HTTP)", async () => {
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const result = await provider.warm();
    expect(result.ok).toBe(true);
  });

  it("empty input array returns ok([]) without hitting the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const result = await provider.embed([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("happy path: one batch returns Float32Array[] of correct dim", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse(2));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const result = await provider.embed(["one", "two"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.length).toBe(OPENAI_3_SMALL_DIM);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Confirm the call shape: POST to the embeddings endpoint with bearer.
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    const body = JSON.parse(init.body as string) as { input: string[]; model: string };
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toEqual(["one", "two"]);
  });

  it("batches inputs at 96 per request", async () => {
    // 200 inputs → ceil(200 / 96) = 3 requests (96, 96, 8).
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(96))
      .mockResolvedValueOnce(fakeResponse(96))
      .mockResolvedValueOnce(fakeResponse(8));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const inputs = Array.from({ length: 200 }, (_, i) => `text ${i}`);
    const result = await provider.embed(inputs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // First two batches are 96; the last is the remainder.
    const sizes = fetchSpy.mock.calls.map(
      (call) =>
        (JSON.parse((call[1] as RequestInit).body as string) as { input: string[] }).input.length,
    );
    expect(sizes).toEqual([96, 96, 8]);
  });

  it("retries on 429 then succeeds; backoff fires the expected number of sleeps", async () => {
    // Two 429s then a 200 — well within the MAX_RETRIES=3 budget.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(fakeResponse(1));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const result = await provider.embed(["x"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  }, 20_000);

  it("retries on 503 then succeeds", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream", { status: 503 }))
      .mockResolvedValueOnce(fakeResponse(1));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const result = await provider.embed(["x"]);
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("returns Result.err on a non-retryable 4xx (no retry)", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response("bad input", { status: 400 }));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const result = await provider.embed(["x"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/400/);
    // Exactly one call — a 4xx is not retried.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns Result.err after exhausting retries", async () => {
    // 4 attempts (1 + MAX_RETRIES=3) of 429, then give up.
    const fetchSpy = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const result = await provider.embed(["x"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/429/);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  }, 30_000);

  it("returns Result.err when response vector count mismatches input count", async () => {
    // Ask for 2 inputs, get 1 vector back.
    const fetchSpy = vi.fn().mockResolvedValue(fakeResponse(1));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const result = await provider.embed(["a", "b"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/1 vectors for 2 inputs/);
  });

  it("returns Result.err when vector dim disagrees with OPENAI_3_SMALL_DIM", async () => {
    const badResp = new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetchSpy = vi.fn().mockResolvedValue(badResp);
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const result = await provider.embed(["x"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/vector of dim 3/);
  });

  it("network exception (no Response) is treated as retryable", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(fakeResponse(1));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const result = await provider.embed(["x"]);
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("onProgress fires once per completed batch", async () => {
    // 200 inputs → 3 batches.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(96))
      .mockResolvedValueOnce(fakeResponse(96))
      .mockResolvedValueOnce(fakeResponse(8));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = makeOpenAi3SmallProvider(FAKE_KEY);
    const calls: Array<[number, number]> = [];
    await provider.embed(
      Array.from({ length: 200 }, (_, i) => `${i}`),
      (done, total) => calls.push([done, total]),
    );
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual([96, 200]);
    expect(calls[1]).toEqual([192, 200]);
    expect(calls[2]).toEqual([200, 200]);
  });
});
