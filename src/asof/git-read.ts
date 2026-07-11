// Read-only git plumbing for `daftari asof` — belief archaeology.
//
// Git is Daftari's version layer, so "what did we believe on March 3?" is a
// question git can already answer: resolve the date to a commit, read the
// tree at that commit, parse the same markdown the live tools parse. This
// module is strictly read-only — it never touches the work tree, never
// creates a worktree or checkout, and writes nothing to the repo. All reads
// go through `git ls-tree` / `git cat-file --batch` / `git log`.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { err, ok, type Result } from "../frontmatter/types.js";

const run = promisify(execFile);

async function git(vaultRoot: string, args: string[]): Promise<Result<string, Error>> {
  try {
    const { stdout } = await run("git", ["-C", vaultRoot, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return ok(stdout);
  } catch (e) {
    const reason =
      e instanceof Error && "stderr" in e && typeof e.stderr === "string"
        ? e.stderr.trim() || e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return err(new Error(`git ${args[0]} failed: ${reason}`));
  }
}

export interface AsofCommit {
  hash: string;
  date: string; // committer date, YYYY-MM-DD
  subject: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Resolves the user's `<ref-or-date>` to a commit. A YYYY-MM-DD date means
// "the last commit made on or before the end of that day" (committer date,
// local time — the same clock the commits were made on). Anything else is
// handed to rev-parse as a ref (HEAD~3, a branch, a hash, a tag).
export async function resolveAsofCommit(
  vaultRoot: string,
  refOrDate: string,
): Promise<Result<AsofCommit, Error>> {
  if (typeof refOrDate !== "string" || refOrDate.trim().length === 0) {
    return err(new Error("asof requires a non-empty ref or YYYY-MM-DD date"));
  }
  const input = refOrDate.trim();

  let hash: string;
  if (DATE_RE.test(input)) {
    const listed = await git(vaultRoot, ["rev-list", "-1", `--before=${input} 23:59:59`, "HEAD"]);
    if (!listed.ok) return listed;
    hash = listed.value.trim();
    if (hash.length === 0) {
      return err(new Error(`no commit exists on or before ${input}`));
    }
  } else {
    const parsed = await git(vaultRoot, ["rev-parse", "--verify", `${input}^{commit}`]);
    if (!parsed.ok) return err(new Error(`cannot resolve '${input}' to a commit`));
    hash = parsed.value.trim();
  }

  const meta = await git(vaultRoot, ["show", "-s", "--format=%H%x1f%cs%x1f%s", hash]);
  if (!meta.ok) return meta;
  const [fullHash, date, subject] = meta.value.trim().split("\x1f");
  return ok({ hash: fullHash ?? hash, date: date ?? "", subject: subject ?? "" });
}

// Path segments the live loader never sees (listFiles ignores dotfiles,
// .daftari, node_modules, .obsidian, .trash) — the historical tree must be
// filtered identically or then/now diffs would report phantom drift.
function isManagedDocPath(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  const segments = path.split("/");
  return segments.every((s) => !s.startsWith(".") && s !== "node_modules");
}

// Vault-relative paths of the managed markdown documents in the tree at
// `commit`, sorted (matching listFiles' sorted output).
export async function listTreeDocs(
  vaultRoot: string,
  commit: string,
): Promise<Result<string[], Error>> {
  const listed = await git(vaultRoot, ["ls-tree", "-r", "--name-only", "-z", commit]);
  if (!listed.ok) return listed;
  const paths = listed.value.split("\0").filter((p) => p.length > 0 && isManagedDocPath(p));
  paths.sort();
  return ok(paths);
}

// Reads many blobs from one commit in a single `git cat-file --batch`
// process. Returns a map of path → file content; a path that does not exist
// at the commit is simply absent from the map. One spawn total, so reading a
// 3,500-file historical tree costs one process, not 3,500.
export async function readBlobsAt(
  vaultRoot: string,
  commit: string,
  paths: string[],
): Promise<Result<Map<string, string>, Error>> {
  if (paths.length === 0) return ok(new Map());

  return new Promise((resolvePromise) => {
    const child = spawn("git", ["-C", vaultRoot, "cat-file", "--batch"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", (e) => {
      resolvePromise(err(new Error(`git cat-file failed to spawn: ${e.message}`)));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const reason = Buffer.concat(stderrChunks).toString("utf-8").trim();
        resolvePromise(err(new Error(`git cat-file exited ${code}: ${reason}`)));
        return;
      }

      // Batch output, per requested object, in request order:
      //   "<oid> <type> <size>\n" + <size> bytes + "\n"    — found
      //   "<input> missing\n"                              — absent
      // Sizes are BYTE counts, so parsing walks the raw Buffer, decoding
      // each content slice to UTF-8 only after it is bounded.
      const out = Buffer.concat(stdoutChunks);
      const contents = new Map<string, string>();
      let offset = 0;
      for (const path of paths) {
        const nl = out.indexOf(0x0a, offset);
        if (nl === -1) {
          resolvePromise(err(new Error("git cat-file: truncated batch output")));
          return;
        }
        const header = out.subarray(offset, nl).toString("utf-8");
        offset = nl + 1;
        if (header.endsWith(" missing")) continue;
        const parts = header.split(" ");
        const size = Number(parts[2]);
        if (!Number.isFinite(size) || size < 0) {
          resolvePromise(err(new Error(`git cat-file: unparseable header: ${header}`)));
          return;
        }
        contents.set(path, out.subarray(offset, offset + size).toString("utf-8"));
        offset += size + 1; // skip the trailing \n after the content
      }
      resolvePromise(ok(contents));
    });

    for (const path of paths) child.stdin.write(`${commit}:${path}\n`);
    child.stdin.end();
  });
}

export interface RangeCommit {
  hash: string;
  date: string; // committer date, YYYY-MM-DD
  author: string;
  subject: string;
}

// Commits in `<since>..HEAD` touching `path`, newest first. The trajectory
// view uses this to show every revision a document went through since the
// as-of point.
export async function logRangeForPath(
  vaultRoot: string,
  since: string,
  path: string,
): Promise<Result<RangeCommit[], Error>> {
  const result = await git(vaultRoot, [
    "log",
    "--format=%H%x1f%cs%x1f%aN%x1f%s%x1e",
    `${since}..HEAD`,
    "--",
    path,
  ]);
  if (!result.ok) return result;

  const commits: RangeCommit[] = [];
  for (const record of result.value.split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const [hash, date, author, subject] = trimmed.split("\x1f");
    if (!hash) continue;
    commits.push({ hash, date: date ?? "", author: author ?? "", subject: subject ?? "" });
  }
  return ok(commits);
}
