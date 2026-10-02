import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExecFn, mergeJsonConfig, planInstall, runInstall } from "../../src/install/index.js";

const CONFIG = `roles:
  admin:
    read: ["*"]
    write: ["*"]
  reader:
    read: ["*"]
`;

describe("daftari install", () => {
  let home: string;
  let vault: string;
  let out: string[];
  let err: string[];
  let calls: { cmd: string; args: string[] }[];
  let execResult: "ok" | "missing" | "fail";

  const exec: ExecFn = (cmd, args) => {
    calls.push({ cmd, args });
    if (execResult === "missing") return { ok: false, missing: true };
    return execResult === "ok" ? { ok: true } : { ok: false, missing: false };
  };
  const io = () => ({
    exec,
    home,
    platform: "darwin" as NodeJS.Platform,
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "daftari-install-"));
    vault = join(home, "vault");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(join(vault, ".daftari", "config.yaml"), CONFIG);
    out = [];
    err = [];
    calls = [];
    execResult = "ok";
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("server spec uses an absolute vault path and the named role", () => {
    const plan = planInstall("cursor", { vault, user: "me", role: "admin", name: "daftari" }, io());
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.value.kind !== "json") throw new Error("expected json plan");
    expect(plan.value.entry.command).toBe("npx");
    expect(plan.value.entry.args).toEqual([
      "-y",
      "daftari@latest",
      "--vault",
      vault,
      "--user",
      "me",
      "--role",
      "admin",
    ]);
  });

  it("refuses a role the vault does not define (deny-all guest footgun)", async () => {
    const code = await runInstall(["cursor", "--vault", vault, "--role", "owner"], io());
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/role "owner".*admin, reader/s);
  });

  it("refuses a path that is not a Daftari vault", async () => {
    const code = await runInstall(["cursor", "--vault", home], io());
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/not a Daftari vault/);
  });

  it("rejects unknown clients and lists the supported ones", async () => {
    const code = await runInstall(["emacs", "--vault", vault], io());
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/claude-code.*cursor/s);
  });

  it("claude-code shells out to `claude mcp add` at user scope", async () => {
    expect(await runInstall(["claude-code", "--vault", vault], io())).toBe(0);
    expect(calls[0]?.cmd).toBe("claude");
    expect(calls[0]?.args.slice(0, 7)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "daftari",
      "--",
      "npx",
    ]);
  });

  it("codex and gemini shell out to their own mcp add", async () => {
    await runInstall(["codex", "--vault", vault], io());
    await runInstall(["gemini", "--vault", vault], io());
    expect(calls[0]?.cmd).toBe("codex");
    expect(calls[0]?.args.slice(0, 4)).toEqual(["mcp", "add", "daftari", "--"]);
    expect(calls[1]?.cmd).toBe("gemini");
    expect(calls[1]?.args.slice(0, 6)).toEqual(["mcp", "add", "-s", "user", "daftari", "npx"]);
  });

  it("vscode passes a JSON server definition to `code --add-mcp`", async () => {
    await runInstall(["vscode", "--vault", vault], io());
    expect(calls[0]?.cmd).toBe("code");
    expect(calls[0]?.args[0]).toBe("--add-mcp");
    const def = JSON.parse(calls[0]?.args[1] ?? "{}");
    expect(def).toMatchObject({ name: "daftari", type: "stdio", command: "npx" });
  });

  it("prints a copy-paste fallback when the client CLI is not installed", async () => {
    execResult = "missing";
    const code = await runInstall(["codex", "--vault", vault], io());
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/codex mcp add daftari -- npx -y daftari@latest/);
  });

  it("--print shows the change without running or writing anything", async () => {
    expect(await runInstall(["claude-code", "--vault", vault, "--print"], io())).toBe(0);
    expect(await runInstall(["cursor", "--vault", vault, "--print"], io())).toBe(0);
    expect(calls).toHaveLength(0);
    expect(out.join("")).toMatch(/claude mcp add --scope user daftari/);
    expect(out.join("")).toMatch(/"mcpServers"/);
  });

  it("cursor merges into ~/.cursor/mcp.json, keeping other servers", async () => {
    const path = join(home, ".cursor", "mcp.json");
    mkdirSync(join(home, ".cursor"));
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect(await runInstall(["cursor", "--vault", vault], io())).toBe(0);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["daftari", "other"]);
    expect(readFileSync(`${path}.bak`, "utf8")).toContain("other");
  });

  it("claude-desktop writes the macOS config path", async () => {
    expect(await runInstall(["claude-desktop", "--vault", vault], io())).toBe(0);
    const path = join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.daftari.command).toBe("npx");
  });

  it("--name lets two vaults coexist", async () => {
    await runInstall(["cursor", "--vault", vault, "--name", "work"], io());
    await runInstall(["cursor", "--vault", vault, "--name", "family"], io());
    const cfg = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["family", "work"]);
  });
});

describe("mergeJsonConfig", () => {
  const entry = { command: "npx", args: ["daftari"] };

  it("refuses to overwrite an unparseable file (no data loss)", () => {
    const r = mergeJsonConfig("{ not json", "mcpServers", "daftari", entry, false);
    expect(r.ok).toBe(false);
  });

  it("refuses to replace a different existing entry without --force", () => {
    const existing = JSON.stringify({ mcpServers: { daftari: { command: "other" } } });
    expect(mergeJsonConfig(existing, "mcpServers", "daftari", entry, false).ok).toBe(false);
    expect(mergeJsonConfig(existing, "mcpServers", "daftari", entry, true).ok).toBe(true);
  });

  it("is idempotent for an identical entry", () => {
    const existing = JSON.stringify({ mcpServers: { daftari: entry } });
    const r = mergeJsonConfig(existing, "mcpServers", "daftari", entry, false);
    expect(r.ok && r.value.changed).toBe(false);
  });

  it("creates the file contents from empty", () => {
    const r = mergeJsonConfig("", "mcpServers", "daftari", entry, false);
    expect(r.ok && JSON.parse(r.value.text).mcpServers.daftari).toEqual(entry);
  });
});
