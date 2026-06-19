// End-to-end test for `daftari import obsidian … --external-git-dir=<path>`.
//
// Proves the full adoption-with-external-git path: a non-git vault is adopted in
// place, but its git data lives OUTSIDE the vault. After the import we expect a
// static `.git` FILE in the vault (not a directory), the real repo at the
// external path, the imported doc committed (read back through the `.git` file,
// which proves the external repo is correctly wired), the doc rewritten with
// Daftari frontmatter, and config.yaml carrying `git_dir`/`auto_commit:true`.
//
// Crucially the vault is NOT pre-initialized as a git repo — the whole point is
// that `import` creates the external repo via `git init --separate-git-dir`. The
// apply path is non-TTY, so `--yes` is required.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { load } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";
import { runImport } from "../../src/import/index.js";
import { log } from "../../src/utils/git.js";

// A non-conformant Obsidian note: no Daftari frontmatter, just a body.
const NON_CONFORMANT = `# X

Some content that exists before adoption, with an inline #idea.
`;

describe("daftari import obsidian — external git-dir adoption (e2e)", () => {
  let tmpRoot: string;
  let vault: string;
  let extDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "daftari-extgit-"));
    vault = join(tmpRoot, "vault");
    extDir = join(tmpRoot, "ext-git"); // must NOT exist yet — import creates it
    mkdirSync(vault, { recursive: true });

    const doc = join(vault, "notes", "x.md");
    mkdirSync(dirname(doc), { recursive: true });
    writeFileSync(doc, NON_CONFORMANT);
  });

  afterEach(() => {
    // rm both the vault and the external git dir (both under tmpRoot).
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("adopts the vault with git data outside it: .git FILE, external repo, committed doc", async () => {
    // The CLI apply path is plan-gated: --apply reads .daftari/backfill-plan.jsonl
    // staged by a prior --plan run. Stage the plan first, then apply.
    const planCode = await runImport(["obsidian", vault, "--plan", "--scope", "notes"]);
    expect(planCode).toBe(0);

    const code = await runImport([
      "obsidian",
      vault,
      "--apply",
      "--scope",
      "notes",
      "--yes",
      `--external-git-dir=${extDir}`,
    ]);
    expect(code).toBe(0);

    // The vault holds a static `.git` FILE (the separate-git-dir pointer), not a
    // `.git/` directory.
    const dotGit = statSync(join(vault, ".git"));
    expect(dotGit.isFile()).toBe(true);
    expect(dotGit.isDirectory()).toBe(false);

    // The real repo lives at the external path.
    expect(existsSync(join(extDir, "HEAD"))).toBe(true);

    // The doc was committed — reading history through the `.git` file proves the
    // external repo is wired correctly.
    const history = await log(vault, { limit: 1 });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.length).toBeGreaterThanOrEqual(1);

    // notes/x.md now carries Daftari frontmatter.
    const parsed = parseDocument(readFileSync(join(vault, "notes", "x.md"), "utf-8"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frontmatter.status).toBeTruthy();

    // config.yaml was written with git_dir = extDir and auto_commit:true.
    const cfg = load(readFileSync(join(vault, ".daftari", "config.yaml"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(cfg.git_dir).toBe(extDir);
    expect(cfg.auto_commit).toBe(true);
  });
});
