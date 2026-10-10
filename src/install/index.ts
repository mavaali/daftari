// src/install/index.ts
//
// `daftari install <client> --vault <path>` — register a vault with an MCP
// client in one command. Clients that ship their own `mcp add` CLI (Claude
// Code, Codex, Gemini CLI, VS Code) are driven through it, so each client stays
// the owner of its config format. Clients without one (Cursor, Claude Desktop)
// get a JSON merge that keeps other servers, backs up the original, and refuses
// to touch a file it cannot parse.
//
// The role is checked against the vault's config before anything is written:
// a misspelled role would otherwise start the server as a deny-all guest.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ok, type Result } from "../frontmatter/types.js";
import { loadConfig } from "../utils/config.js";
import { parseFlag } from "../utils/flags.js";

export const CLIENTS = [
  "claude-code",
  "claude-desktop",
  "codex",
  "cursor",
  "gemini",
  "vscode",
] as const;
type Client = (typeof CLIENTS)[number];

export type ExecFn = (
  cmd: string,
  args: string[],
) => { ok: true } | { ok: false; missing: boolean };

interface Io {
  exec: ExecFn;
  home: string;
  platform: NodeJS.Platform;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

interface Options {
  vault: string;
  user: string;
  role: string;
  name: string;
}

interface ServerEntry {
  command: string;
  args: string[];
}

type Plan =
  | { kind: "exec"; cmd: string; args: string[]; remove?: string[] }
  | { kind: "json"; path: string; key: string; entry: ServerEntry };

const HELP = `daftari install — register a vault with an MCP client.

Usage:
  daftari install <client> --vault <path> [options]

Clients: ${CLIENTS.join(", ")}

Options:
  --user <name>   Identity the server runs as (default: me)
  --role <role>   Role from the vault's .daftari/config.yaml (default: admin)
  --name <name>   Server name in the client (default: daftari) — use one per vault
  --print         Show the command or config change without applying it
  --force         Replace an existing entry with the same name (not vscode)
`;

function serverEntry(o: Options): ServerEntry {
  return {
    command: "npx",
    args: ["-y", "daftari@latest", "--vault", o.vault, "--user", o.user, "--role", o.role],
  };
}

function claudeDesktopPath(io: Io): string | null {
  if (io.platform === "darwin")
    return join(io.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (io.platform === "win32" && process.env.APPDATA)
    return join(process.env.APPDATA, "Claude", "claude_desktop_config.json");
  return null;
}

export function planInstall(client: Client, o: Options, io: Io): Result<Plan> {
  const e = serverEntry(o);
  switch (client) {
    case "claude-code":
      return ok({
        kind: "exec",
        cmd: "claude",
        args: ["mcp", "add", "--scope", "user", o.name, "--", e.command, ...e.args],
        remove: ["mcp", "remove", "--scope", "user", o.name],
      });
    case "codex":
      return ok({
        kind: "exec",
        cmd: "codex",
        args: ["mcp", "add", o.name, "--", e.command, ...e.args],
        remove: ["mcp", "remove", o.name],
      });
    // No `--` here: gemini's parser rejects it (checked against gemini 0.59),
    // and passes the server's own flags through as args without it.
    case "gemini":
      return ok({
        kind: "exec",
        cmd: "gemini",
        args: ["mcp", "add", "-s", "user", o.name, e.command, ...e.args],
        remove: ["mcp", "remove", "-s", "user", o.name],
      });
    case "vscode":
      return ok({
        kind: "exec",
        cmd: "code",
        args: ["--add-mcp", JSON.stringify({ name: o.name, type: "stdio", ...e })],
      });
    case "cursor":
      return ok({
        kind: "json",
        path: join(io.home, ".cursor", "mcp.json"),
        key: "mcpServers",
        entry: e,
      });
    case "claude-desktop": {
      const path = claudeDesktopPath(io);
      if (!path) return fail("Claude Desktop is only available on macOS and Windows");
      return ok({ kind: "json", path, key: "mcpServers", entry: e });
    }
  }
}

export function mergeJsonConfig(
  existing: string,
  key: string,
  name: string,
  entry: ServerEntry,
  force: boolean,
): Result<{ text: string; changed: boolean }> {
  let cfg: Record<string, unknown> = {};
  if (existing.trim()) {
    try {
      const parsed = JSON.parse(existing);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return fail("config is not a JSON object");
      cfg = parsed;
    } catch (e) {
      return fail(`config is not valid JSON (${(e as Error).message}); fix it by hand first`);
    }
  }
  const servers = (cfg[key] ?? {}) as Record<string, unknown>;
  const current = servers[name];
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(entry))
    return ok({ text: existing, changed: false });
  if (current !== undefined && !force)
    return fail(`an MCP server named "${name}" already exists; pass --force or pick --name`);
  cfg[key] = { ...servers, [name]: entry };
  return ok({ text: `${JSON.stringify(cfg, null, 2)}\n`, changed: true });
}

function shellQuote(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

// PowerShell quoting, for showing Windows users a command to run themselves.
function psQuote(a: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`;
}

// On Windows the client CLIs are .cmd shims, which Node only runs through
// cmd.exe — and with `shell: true` Node joins the args unquoted. Quote each
// arg ourselves, and refuse what cmd.exe quoting cannot contain (`"`, `%`, `!`,
// newlines), so a hostile vault path cannot run a second command.
export function cmdQuote(a: string): string | null {
  if (/["%!\r\n\0]/.test(a)) return null;
  return `"${a.replace(/(\\+)$/, "$1$1")}"`;
}

function describePlan(plan: Plan, name: string, platform: NodeJS.Platform): string {
  const quote = platform === "win32" ? psQuote : shellQuote;
  if (plan.kind === "exec") return `${[plan.cmd, ...plan.args].map(quote).join(" ")}\n`;
  return `${plan.path}:\n${JSON.stringify({ [plan.key]: { [name]: plan.entry } }, null, 2)}\n`;
}

function validateVault(vault: string, role: string): Result<void> {
  if (!existsSync(join(vault, ".daftari", "config.yaml")))
    return fail(
      `${vault} is not a Daftari vault (no .daftari/config.yaml) — run: npx daftari --init ${vault}`,
    );
  const cfg = loadConfig(vault);
  if (!cfg.ok) return fail(`could not read the vault config: ${cfg.error.message}`);
  const roles = Object.keys(cfg.value.roles);
  if (!roles.includes(role))
    return fail(
      `role "${role}" is not defined in the vault config (defined: ${roles.join(", ") || "none"}); ` +
        "the server would start as a deny-all guest",
    );
  return ok(undefined);
}

const defaultExec: ExecFn = (cmd, args) => {
  const win = process.platform === "win32";
  const quoted = win ? args.map(cmdQuote) : args;
  if (quoted.some((a) => a === null)) return { ok: false, missing: false };
  const r = spawnSync(cmd, quoted as string[], { stdio: "inherit", shell: win });
  if (r.error) return { ok: false, missing: (r.error as NodeJS.ErrnoException).code === "ENOENT" };
  return r.status === 0 ? { ok: true } : { ok: false, missing: false };
};

const defaultIo: Io = {
  exec: defaultExec,
  home: homedir(),
  platform: process.platform,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

export async function runInstall(argv: string[], io: Io = defaultIo): Promise<number> {
  const client = argv[0];
  if (!client || client === "--help" || client === "-h") {
    io.stdout(HELP);
    return client ? 0 : 1;
  }
  if (!(CLIENTS as readonly string[]).includes(client)) {
    io.stderr(`daftari install: unknown client "${client}". Supported: ${CLIENTS.join(", ")}\n`);
    return 1;
  }
  const vaultArg = parseFlag(argv, "vault");
  if (!vaultArg) {
    io.stderr("daftari install: --vault <path> is required\n");
    return 1;
  }
  const opts: Options = {
    vault: resolve(vaultArg),
    user: parseFlag(argv, "user") ?? "me",
    role: parseFlag(argv, "role") ?? "admin",
    name: parseFlag(argv, "name") ?? "daftari",
  };

  const valid = validateVault(opts.vault, opts.role);
  if (!valid.ok) {
    io.stderr(`daftari install: ${valid.error.message}\n`);
    return 1;
  }
  const plan = planInstall(client as Client, opts, io);
  if (!plan.ok) {
    io.stderr(`daftari install: ${plan.error.message}\n`);
    return 1;
  }

  if (argv.includes("--print")) {
    io.stdout(describePlan(plan.value, opts.name, io.platform));
    return 0;
  }

  if (plan.value.kind === "exec") {
    // Not even a printed command is safe here (a .cmd shim re-parses its args),
    // so hand over the server definition to paste into the client's MCP config.
    if (io.platform === "win32" && plan.value.args.some((a) => cmdQuote(a) === null)) {
      io.stderr(
        client === "vscode"
          ? "daftari install: on Windows, `code --add-mcp` takes a JSON argument that cmd.exe " +
              "cannot pass safely. In VS Code run 'MCP: Add Server' and use this definition:\n"
          : "daftari install: the vault path or another option contains a character cmd.exe " +
              `cannot pass safely (" % ! or a newline). Add this server in ${client}'s MCP settings instead:\n`,
      );
      io.stderr(`${JSON.stringify({ [opts.name]: serverEntry(opts) }, null, 2)}\n`);
      return 1;
    }
    // --force: drop any existing entry first; if there is none, the remove just fails.
    if (plan.value.remove && argv.includes("--force")) io.exec(plan.value.cmd, plan.value.remove);
    const r = io.exec(plan.value.cmd, plan.value.args);
    if (r.ok) {
      io.stdout(`Registered "${opts.name}" with ${client}. Restart the client to load it.\n`);
      return 0;
    }
    io.stderr(
      r.missing
        ? `daftari install: \`${plan.value.cmd}\` is not on your PATH. Run this once it is:\n  `
        : `daftari install: \`${plan.value.cmd}\` failed. The command was:\n  `,
    );
    io.stderr(describePlan(plan.value, opts.name, io.platform));
    return 1;
  }

  const { path, key, entry } = plan.value;
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const merged = mergeJsonConfig(existing, key, opts.name, entry, argv.includes("--force"));
  if (!merged.ok) {
    io.stderr(`daftari install: ${path}: ${merged.error.message}\n`);
    return 1;
  }
  if (!merged.value.changed) {
    io.stdout(`"${opts.name}" is already registered in ${path}.\n`);
    return 0;
  }
  mkdirSync(dirname(path), { recursive: true });
  // Back up only once, so a later --force or second --name keeps the user's original.
  if (existing && !existsSync(`${path}.bak`)) writeFileSync(`${path}.bak`, existing);
  writeFileSync(path, merged.value.text);
  io.stdout(`Registered "${opts.name}" in ${path}. Restart ${client} to load it.\n`);
  return 0;
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: new Error(message) };
}
