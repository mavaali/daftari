// src/audit/config.ts
// Parses CLI argv + an optional audit.yaml into an AuditConfig. CLI wins on
// overlap with YAML; for --output flags only, a stderr warning is emitted so
// operators see when the file they expected to be written has been displaced.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { err, ok, type Result } from "../frontmatter/types.js";
import { type AuditConfig, type AuditError, configError, type RepoConfig } from "./types.js";

// Inner helpers throw tagged AuditError objects (not class instances). The
// top-level parseAuditConfig wraps in try/catch and converts to Result.
function isAuditError(e: unknown): e is AuditError {
  return (
    typeof e === "object" &&
    e !== null &&
    ((e as { kind?: unknown }).kind === "config" || (e as { kind?: unknown }).kind === "runtime")
  );
}

const DEFAULTS = {
  docsGlob: "**/*.md",
  thresholdDays: 540,
  failOn: { brokenRefs: 1, transitiveStaleness: 100 },
};

type RawRepoYaml = {
  name?: unknown;
  path?: unknown;
  docs_glob?: unknown;
  urls?: unknown;
};

type RawYaml = {
  repos?: unknown;
  output?: { markdown?: unknown; json?: unknown };
  staleness?: { threshold_days?: unknown };
  fail_on?: { broken_refs?: unknown; transitive_staleness?: unknown };
};

function readArg(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    const prefix = `${flag}=`;
    if (argv[i]?.startsWith(prefix)) return argv[i]?.slice(prefix.length);
  }
  return undefined;
}

function readMulti(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) {
      out.push(argv[i + 1] as string);
      i++;
    } else {
      const prefix = `${flag}=`;
      if (argv[i]?.startsWith(prefix)) out.push((argv[i] as string).slice(prefix.length));
    }
  }
  return out;
}

function validateRepoPath(p: string, label: string): string {
  if (!existsSync(p)) {
    throw configError(`${label}: path does not exist: ${p}`);
  }
  if (!statSync(p).isDirectory()) {
    throw configError(`${label}: not a directory: ${p}`);
  }
  return realpathSync(p);
}

function parseYamlRepos(raw: RawRepoYaml[] | undefined): RepoConfig[] {
  if (!raw) return [];
  return raw.map((r, i) => {
    if (typeof r.name !== "string" || r.name.length === 0) {
      throw configError(`repos[${i}]: missing name`);
    }
    if (typeof r.path !== "string" || r.path.length === 0) {
      throw configError(`repos[${i}] (${r.name}): missing path`);
    }
    const path = validateRepoPath(resolve(r.path), `repos[${i}] (${r.name})`);
    const docsGlob = typeof r.docs_glob === "string" ? r.docs_glob : DEFAULTS.docsGlob;
    const urls = Array.isArray(r.urls)
      ? r.urls.filter((u): u is string => typeof u === "string")
      : [];
    return { name: r.name, path, docsGlob, urls };
  });
}

function ensureUnique(repos: RepoConfig[]): void {
  const seenName = new Set<string>();
  const seenPath = new Set<string>();
  for (const r of repos) {
    if (seenName.has(r.name)) {
      throw configError(`duplicate repo name: ${r.name}`);
    }
    if (seenPath.has(r.path)) {
      throw configError(`duplicate repo path: ${r.path}`);
    }
    seenName.add(r.name);
    seenPath.add(r.path);
  }
}

function warn(msg: string): void {
  process.stderr.write(`daftari audit: warning: ${msg}\n`);
}

export function parseAuditConfig(
  argv: string[],
  yamlLoader?: (path: string) => string,
): Result<AuditConfig, AuditError> {
  try {
    const configPath = readArg(argv, "--config");
    let yamlRaw: RawYaml = {};
    if (configPath !== undefined) {
      const load = yamlLoader ?? ((p: string) => readFileSync(p, "utf-8"));
      let text: string;
      try {
        text = load(configPath);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw configError(`cannot read --config ${configPath}: ${reason}`);
      }
      try {
        const raw = yaml.load(text);
        if (raw === null || raw === undefined) {
          yamlRaw = {};
        } else if (typeof raw !== "object" || Array.isArray(raw)) {
          throw configError(
            `${configPath}: expected a YAML map at top level, got ${Array.isArray(raw) ? "array" : typeof raw}`,
          );
        } else {
          yamlRaw = raw as RawYaml;
        }
      } catch (e) {
        if (isAuditError(e)) throw e;
        const reason = e instanceof Error ? e.message : String(e);
        throw configError(`malformed YAML in ${configPath}: ${reason}`);
      }
    }

    const yamlRepos = parseYamlRepos(yamlRaw.repos as RawRepoYaml[] | undefined);

    const cliRepoPaths = readMulti(argv, "--repo");
    const cliRepos: RepoConfig[] = cliRepoPaths.map((rawPath, i) => {
      const path = validateRepoPath(resolve(rawPath), `--repo ${rawPath}`);
      return {
        name: `repo-${i}`,
        path,
        docsGlob: DEFAULTS.docsGlob,
        urls: [],
      };
    });

    const repos = [...yamlRepos, ...cliRepos];
    if (repos.length === 0) {
      throw configError("no repos configured: pass --repo or --config");
    }
    ensureUnique(repos);

    // Output handling: CLI wins, warn if it displaces YAML.
    const yamlMd =
      typeof yamlRaw.output?.markdown === "string" ? yamlRaw.output.markdown : undefined;
    const yamlJson = typeof yamlRaw.output?.json === "string" ? yamlRaw.output.json : undefined;
    const cliMd = readArg(argv, "--output");
    const cliJson = readArg(argv, "--output-json");
    if (cliMd && yamlMd && cliMd !== yamlMd) {
      warn(`--output overrides output.markdown from config (${yamlMd} → ${cliMd})`);
    }
    if (cliJson && yamlJson && cliJson !== yamlJson) {
      warn(`--output-json overrides output.json from config (${yamlJson} → ${cliJson})`);
    }
    const output = {
      markdown: cliMd ?? yamlMd,
      json: cliJson ?? yamlJson,
    };

    const thresholdDays =
      typeof yamlRaw.staleness?.threshold_days === "number"
        ? yamlRaw.staleness.threshold_days
        : DEFAULTS.thresholdDays;

    const failOn = {
      brokenRefs:
        typeof yamlRaw.fail_on?.broken_refs === "number"
          ? yamlRaw.fail_on.broken_refs
          : DEFAULTS.failOn.brokenRefs,
      transitiveStaleness:
        typeof yamlRaw.fail_on?.transitive_staleness === "number"
          ? yamlRaw.fail_on.transitive_staleness
          : DEFAULTS.failOn.transitiveStaleness,
    };

    return ok({ repos, output, staleness: { thresholdDays }, failOn });
  } catch (e) {
    if (isAuditError(e)) return err(e);
    throw e; // not ours; let it propagate
  }
}
