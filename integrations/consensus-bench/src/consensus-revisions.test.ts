import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadRevisionsFromFile } from "./consensus-revisions.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/revisions-synthetic.json", import.meta.url));

describe("loadRevisionsFromFile", () => {
  test("loads revisions with the expected fields", () => {
    const revs = loadRevisionsFromFile(FIXTURE);
    expect(revs).toHaveLength(6);
    expect(revs[0]).toMatchObject({ revid: 1001, parentid: 1000, user: "EditorA" });
    expect(revs[0].comment).toContain("tweak wording");
    expect(typeof revs[0].timestamp).toBe("string");
  });
});
