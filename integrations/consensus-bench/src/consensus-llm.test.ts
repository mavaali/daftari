import { describe, expect, test } from "vitest";
import { openRouterClient } from "./consensus-llm.js";

describe("openRouterClient", () => {
  test("posts an OpenRouter chat request and returns the message content", async () => {
    let captured: any = null;
    const fakeFetch = async (url: any, init: any) => {
      captured = { url, init };
      return { json: async () => ({ choices: [{ message: { content: "hello" } }] }) } as any;
    };
    const client = openRouterClient("KEY", fakeFetch as any);
    const out = await client.complete({ model: "m", user: "hi" });
    expect(out).toBe("hello");
    expect(captured.url).toContain("openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(captured.init.body);
    expect(body).toMatchObject({ model: "m", temperature: 0 });
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(captured.init.headers.Authorization).toBe("Bearer KEY");
  });

  test("returns empty string when the response has no content", async () => {
    const fakeFetch = async () => ({ json: async () => ({}) }) as any;
    const client = openRouterClient("KEY", fakeFetch as any);
    expect(await client.complete({ model: "m", user: "x" })).toBe("");
  });
});
