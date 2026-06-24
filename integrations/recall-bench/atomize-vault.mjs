import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/mihirwagle/projects/daftari";
const CORPUS = "/tmp/recall-review/packages/recall-bench/personas/executive-assistant/memories-180d";
const ATOM_VAULT = "/tmp/cov-recall/atom-vault";
const BASE_DATE = "2026-01-01";

if (!existsSync(CORPUS)) {
  console.error(`CORPUS missing: ${CORPUS}\nRe-clone Stevenic/recall.`);
  process.exit(1);
}

function dayDate(n) {
  const d = new Date(`${BASE_DATE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - 1));
  return d.toISOString().slice(0, 10);
}
function stripFrontmatter(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

// Split a day body into atoms. Returns [{ session, title, lines }].
function atomize(body) {
  const lines = body.split("\n");
  const atoms = [];
  let session = "";
  let cur = null; // { title, lines: [] }
  const flush = () => {
    if (cur && cur.lines.join("").trim()) atoms.push({ session, title: cur.title, lines: cur.lines });
    cur = null;
  };
  for (const line of lines) {
    if (/^# /.test(line)) {
      flush();
      session = line.replace(/^# /, "").trim();
      continue;
    }
    if (/^### /.test(line)) {
      flush();
      cur = { title: line.replace(/^### /, "").trim(), lines: [line] };
      continue;
    }
    if (cur) cur.lines.push(line);
    // text before the first ### in a session is pure session preamble (none in this corpus).
  }
  flush();
  return atoms;
}

const files = readdirSync(CORPUS)
  .filter((f) => /^day-\d+\.md$/.test(f))
  .sort();
if (files.length !== 180) throw new Error(`expected 180 day-files, got ${files.length}`);

rmSync(ATOM_VAULT, { recursive: true, force: true });
mkdirSync(join(ATOM_VAULT, "notes"), { recursive: true });

let total = 0;
const perDay = [];
for (const f of files) {
  const n = Number(/day-(\d+)/.exec(f)[1]);
  const created = dayDate(n);
  const body = stripFrontmatter(readFileSync(join(CORPUS, f), "utf8"));
  const atoms = atomize(body);
  if (atoms.length === 0) throw new Error(`day ${n} produced 0 atoms`);
  const atomChars = atoms.reduce((s, a) => s + a.lines.join("\n").length, 0);
  const dayHashChars = body
    .split("\n")
    .filter((l) => !/^# /.test(l))
    .join("\n").length; // body minus session lines
  perDay.push({ n, atoms: atoms.length, atomChars, dayHashChars });
  atoms.forEach((a, k) => {
    const atomBody = `## session: ${a.session}\n\n${a.lines.join("\n")}`;
    // JSON.stringify => a double-quoted YAML flow scalar: robust against colons,
    // quotes, leading specials, and `#` in the topic title (those were silently
    // making frontmatter unparseable -> reindex skipped the atom).
    const safeTitle = JSON.stringify(a.title.replace(/\n/g, " ").slice(0, 120));
    const fm =
      `---\ntitle: ${safeTitle}\ndomain: accumulation\n` +
      `collection: notes\nstatus: canonical\nconfidence: high\ncreated: ${created}\n` +
      `updated: ${created}\nupdated_by: agent:atomize\nprovenance: direct\ntags: [daily]\n---\n\n`;
    writeFileSync(
      join(ATOM_VAULT, "notes", `day-${String(n).padStart(4, "0")}-a${String(k).padStart(2, "0")}.md`),
      fm + atomBody,
    );
    total++;
  });
}
console.log(
  `atomize: ${total} atoms from 180 days (mean ${(total / 180).toFixed(1)}/day, min ${Math.min(...perDay.map((p) => p.atoms))}, max ${Math.max(...perDay.map((p) => p.atoms))})`,
);

const shrunk = perDay.filter((p) => p.atomChars < 0.9 * p.dayHashChars);
if (shrunk.length)
  console.warn(`WARN: ${shrunk.length} days lost >10% content in atomization (investigate split rule)`, shrunk.slice(0, 3));

const { reindexVault } = await import(`${ROOT}/dist/search/reindex.js`);
const r = await reindexVault(ATOM_VAULT);
if (!r.ok) {
  console.error("reindex failed:", r.error.message);
  process.exit(1);
}
console.log(`atomize: indexed ${r.value.documentCount} atoms`);
if (r.value.documentCount !== total) throw new Error(`indexed ${r.value.documentCount} != written ${total}`);
