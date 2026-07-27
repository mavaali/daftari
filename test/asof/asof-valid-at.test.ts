// `daftari asof <ref> --valid <date>` — the actual bi-temporal query.
//
//   "On <ref>, what did the vault believe was true on <valid-at>?"
//
// The honest headline: this is answerable only for facts whose intervals were
// authored BEFORE the question was asked. Every commit predating the feature
// carries no validity fields, so a historical ref returns 100% unknown —
// permanently, by construction, since valid time is never inferred. The report
// has to say that in words rather than show a bare zero, or a reader will
// mistake "nobody recorded this" for "nothing was true".

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAsofCommit } from "../../src/asof/git-read.js";
import { runAsof } from "../../src/asof/index.js";
import { beliefSnapshot } from "../../src/asof/snapshot.js";
import { listTensions } from "../../src/curation/tension.js";

let vault: string;
let preAdoption: string;

function git(args: string[], date: string): void {
  execFileSync("git", ["-C", vault, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `${date}T12:00:00`,
      GIT_COMMITTER_DATE: `${date}T12:00:00`,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@daftari.local",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@daftari.local",
    },
  });
}

function md(path: string, validity: Record<string, string>): void {
  const fm: Record<string, string> = {
    title: `Doc ${path}`,
    domain: "accumulation",
    collection: path.split("/")[0] ?? "",
    status: "canonical",
    confidence: "medium",
    created: "2026-01-15",
    updated: "2026-01-15",
    updated_by: "agent:test",
    provenance: "direct",
    ...validity,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: "${v}"`);
  mkdirSync(join(vault, path.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(
    join(vault, path),
    `---\n${lines.join("\n")}\nsources: []\ntags: []\n---\n\nBody of ${path}.\n`,
    "utf-8",
  );
}

beforeAll(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-asof-validity-"));
  execFileSync("git", ["-C", vault, "init", "-q", "-b", "main"]);

  // Commit 1 — the pre-adoption state: no validity fields anywhere.
  md("pricing/base.md", {});
  md("pricing/other.md", {});
  git(["add", "-A"], "2026-01-15");
  git(["commit", "-q", "-m", "v1 pre-adoption"], "2026-01-15");
  preAdoption = execFileSync("git", ["-C", vault, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();

  // Commit 2 — intervals authored.
  md("pricing/base.md", { valid_from: "2026-01-01", valid_until: "2026-03-31" });
  md("pricing/other.md", { valid_from: "2026-04-01" });
  git(["add", "-A"], "2026-06-20");
  git(["commit", "-q", "-m", "v2 intervals authored"], "2026-06-20");
});

afterAll(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("beliefSnapshot — validity partition", () => {
  it("omits the partition when validAt is not requested", async () => {
    const commit = await resolveAsofCommit(vault, "HEAD");
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const snap = await beliefSnapshot(vault, commit.value, tensions.value);
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.value.validity).toBeUndefined();
  });

  it("partitions in-window / out-of-window / unwindowed at a date", async () => {
    const commit = await resolveAsofCommit(vault, "HEAD");
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const snap = await beliefSnapshot(vault, commit.value, tensions.value, "2026-02-15");
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.value.validity?.date).toBe("2026-02-15");
    expect(snap.value.validity?.inWindow).toBe(1); // base.md
    expect(snap.value.validity?.outOfWindow).toBe(1); // other.md, not_yet
    expect(snap.value.validity?.unwindowed).toBe(0);
  });

  it("reports 100% unwindowed for a pre-adoption ref", async () => {
    // The C7 limitation, asserted rather than described.
    const commit = await resolveAsofCommit(vault, preAdoption);
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const snap = await beliefSnapshot(vault, commit.value, tensions.value, "2026-02-15");
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.value.validity?.unwindowed).toBe(2);
    expect(snap.value.validity?.inWindow).toBe(0);
    expect(snap.value.validity?.outOfWindow).toBe(0);
  });

  it("leaves drift untouched — drift is a transaction-time notion", async () => {
    const commit = await resolveAsofCommit(vault, preAdoption);
    if (!commit.ok) return;
    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const withDate = await beliefSnapshot(vault, commit.value, tensions.value, "2026-02-15");
    const without = await beliefSnapshot(vault, commit.value, tensions.value);
    expect(withDate.ok && without.ok).toBe(true);
    if (!withDate.ok || !without.ok) return;
    expect(withDate.value.drift).toEqual(without.value.drift);
    expect(withDate.value.byStatus).toEqual(without.value.byStatus);
  });
});

describe("daftari asof --valid (CLI)", () => {
  it("does not consume the --valid value as the positional ref", async () => {
    // The VALUE_FLAGS regression: omitting --valid from that list makes the
    // positional finder mistake the DATE for the ref. Asserting exit 0 is not
    // enough — "2026-02-15" resolves as a date-ref perfectly well and reports
    // the WRONG commit. So assert the report names HEAD's commit.
    const head = execFileSync("git", ["-C", vault, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    const out = join(vault, "..", `asof-flag-${head.slice(0, 8)}.md`);
    const code = await runAsof([
      "--vault",
      vault,
      "--valid",
      "2026-02-15",
      "HEAD",
      "--output",
      out,
    ]);
    expect(code).toBe(0);
    expect(readFileSync(out, "utf-8")).toContain(head.slice(0, 8));
    rmSync(out, { force: true });
  });

  it("exits 2 on a malformed --valid", async () => {
    // Must fail on the DATE, not incidentally on ref resolution — so pass a
    // ref that resolves fine.
    const code = await runAsof(["--vault", vault, "HEAD", "--valid", "February 2026"]);
    expect(code).toBe(2);
  });

  it("emits a Valid at section only when the flag is present", async () => {
    const out = join(vault, "..", `asof-${Date.now()}.md`);
    await runAsof(["--vault", vault, "HEAD", "--output", out]);
    const plain = readFileSync(out, "utf-8");
    expect(plain).not.toContain("## Valid at");

    const out2 = join(vault, "..", `asof2-${Date.now()}.md`);
    await runAsof(["--vault", vault, "HEAD", "--valid", "2026-02-15", "--output", out2]);
    const dated = readFileSync(out2, "utf-8");
    expect(dated).toContain("## Valid at 2026-02-15");
    rmSync(out, { force: true });
    rmSync(out2, { force: true });
  });

  it("says so in words when nothing at the ref carries validity", async () => {
    const out = join(vault, "..", `asof3-${Date.now()}.md`);
    await runAsof(["--vault", vault, preAdoption, "--valid", "2026-02-15", "--output", out]);
    const text = readFileSync(out, "utf-8");
    // A bare "0 covering" would read as "nothing was true then".
    expect(text).toMatch(/no document at this ref carries authored validity/i);
    rmSync(out, { force: true });
  });
});
