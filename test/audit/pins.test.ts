// test/audit/pins.test.ts
// checkPins: batch pin classification for `daftari audit` (2026-07-26 spec,
// Decision 3).

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPins } from "../../src/audit/checks/pins.js";
import { classifyDescribesEdges } from "../../src/audit/describes.js";
import type { DocSnapshot, RepoSnapshot } from "../../src/audit/types.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
}

function doc(relPath: string, describes: string[]): DocSnapshot {
  return {
    relPath,
    absPath: `/x/${relPath}`,
    mtime: "2026-01-01T00:00:00.000Z",
    mtimeSource: "git",
    headings: new Set(),
    links: [],
    describes,
  };
}

function docsRepo(docs: DocSnapshot[]): RepoSnapshot {
  return {
    config: { name: "docs", path: "/docs", docsGlob: "**/*.md", urls: [], type: "docs" },
    docs: new Map(docs.map((d) => [d.relPath, d])),
  };
}

describe("checkPins", () => {
  let codeRepo: string;

  beforeEach(() => {
    codeRepo = realpathSync(mkdtempSync(join(tmpdir(), "daftari-audit-pins-")));
    git(codeRepo, ["init", "-q"]);
    writeFileSync(join(codeRepo, "retry.ts"), "export function retry() {}\n");
    git(codeRepo, ["add", "."]);
    git(codeRepo, ["commit", "-q", "-m", "init"]);
  });

  afterEach(() => {
    rmSync(codeRepo, { recursive: true, force: true });
  });

  function codeSnap(): RepoSnapshot {
    return {
      config: { name: "svc", path: codeRepo, docsGlob: "**/*", urls: [], type: "code" },
      docs: new Map(),
    };
  }

  function sha(): string {
    return execFileSync("git", ["-C", codeRepo, "hash-object", "retry.ts"], { env: GIT_ENV })
      .toString()
      .trim();
  }

  it("returns [] when no bindings are pinned", async () => {
    const snaps = [docsRepo([doc("a.md", ["svc:retry.ts"])]), codeSnap()];
    const edges = classifyDescribesEdges(snaps);
    expect(await checkPins(snaps, edges)).toEqual([]);
  });

  it("classifies an intact whole-file pin", async () => {
    const snaps = [docsRepo([doc("a.md", [`svc:retry.ts@${sha()}`])]), codeSnap()];
    const edges = classifyDescribesEdges(snaps);
    const findings = await checkPins(snaps, edges);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.state).toBe("intact");
    expect(findings[0]?.source).toEqual({ repo: "docs", path: "a.md" });
    expect(findings[0]?.target).toEqual({ repo: "svc", path: "retry.ts" });
  });

  it("classifies a moved pin (blob changed)", async () => {
    const snaps = [docsRepo([doc("a.md", ["svc:retry.ts@0000000"])]), codeSnap()];
    const edges = classifyDescribesEdges(snaps);
    const findings = await checkPins(snaps, edges);
    expect(findings[0]?.state).toBe("moved");
  });

  it("classifies missing when the target file is absent", async () => {
    const snaps = [docsRepo([doc("a.md", ["svc:gone.ts@0000000"])]), codeSnap()];
    const edges = classifyDescribesEdges(snaps);
    const findings = await checkPins(snaps, edges);
    expect(findings[0]?.state).toBe("missing");
  });

  it("classifies missing when the target repo isn't in the snapshot set", async () => {
    const snaps = [docsRepo([doc("a.md", ["ghost:retry.ts@0000000"])])];
    const edges = classifyDescribesEdges(snaps);
    const findings = await checkPins(snaps, edges);
    expect(findings[0]?.state).toBe("missing");
  });

  it("batches multiple pins against the same repo into one classification pass", async () => {
    writeFileSync(join(codeRepo, "second.ts"), "export const y = 2;\n");
    git(codeRepo, ["add", "."]);
    git(codeRepo, ["commit", "-q", "-m", "second"]);
    const secondSha = execFileSync("git", ["-C", codeRepo, "hash-object", "second.ts"], {
      env: GIT_ENV,
    })
      .toString()
      .trim();

    const snaps = [
      docsRepo([doc("a.md", [`svc:retry.ts@${sha()}`, `svc:second.ts@${secondSha}`])]),
      codeSnap(),
    ];
    const edges = classifyDescribesEdges(snaps);
    const findings = await checkPins(snaps, edges);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.state === "intact")).toBe(true);
  });

  it("computes a relocated range for an intact range pin", async () => {
    const content =
      ["a", "TARGET LINE with enough content to pass the trivial-content floor", "c"].join("\n") +
      "\n";
    writeFileSync(join(codeRepo, "range.ts"), content);
    git(codeRepo, ["add", "."]);
    git(codeRepo, ["commit", "-q", "-m", "range"]);
    const rangeSha = execFileSync("git", ["-C", codeRepo, "hash-object", "range.ts"], {
      env: GIT_ENV,
    })
      .toString()
      .trim();

    // Move the line down by prepending content — blob differs, text intact.
    writeFileSync(
      join(codeRepo, "range.ts"),
      ["pad", "a", "TARGET LINE with enough content to pass the trivial-content floor", "c"].join(
        "\n",
      ) + "\n",
    );

    const snaps = [docsRepo([doc("a.md", [`svc:range.ts#L2-2@${rangeSha}`])]), codeSnap()];
    const edges = classifyDescribesEdges(snaps);
    const findings = await checkPins(snaps, edges);
    expect(findings[0]?.state).toBe("intact");
    expect(findings[0]?.relocated).toEqual({ start: 3, end: 3 });
  });
});
