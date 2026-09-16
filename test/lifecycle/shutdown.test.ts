import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

function events(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
}

function lockHolderPid(vaultRoot: string): number | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(vaultRoot, ".daftari", "process.lock"), "utf-8"),
    ) as { pid?: number };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

describe("signal shutdown", () => {
  const children: ChildProcess[] = [];
  const vaults: string[] = [];

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForExit(child, 2_000);
    }
    for (const vault of vaults) rmSync(vault, { recursive: true, force: true });
    children.length = 0;
    vaults.length = 0;
  });

  function startHolder(mode: "gated" | "never") {
    const vaultRoot = mkdtempSync(join(tmpdir(), "daftari-shutdown-"));
    const eventsPath = join(vaultRoot, "shutdown-events");
    const gatePath = join(vaultRoot, "allow-close");
    const fixture = resolve("test/helpers/shutdown-holder.ts");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fixture, vaultRoot, eventsPath, gatePath, mode],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child.stderr?.on("data", () => undefined);
    children.push(child);
    vaults.push(vaultRoot);
    return { child, eventsPath, gatePath, vaultRoot };
  }

  it("awaits one async close before releasing the vault lock and exiting", async () => {
    const holder = startHolder("gated");
    expect(await waitUntil(() => events(holder.eventsPath).includes("ready"), 15_000)).toBe(true);

    holder.child.kill("SIGTERM");
    expect(await waitUntil(() => events(holder.eventsPath).includes("close-start"), 5_000)).toBe(
      true,
    );
    holder.child.kill("SIGINT");
    await sleep(100);

    expect(lockHolderPid(holder.vaultRoot)).toBe(holder.child.pid);
    expect(holder.child.exitCode).toBeNull();
    expect(events(holder.eventsPath).filter((event) => event === "close-start")).toHaveLength(1);

    writeFileSync(holder.gatePath, "close", "utf-8");
    expect(await waitForExit(holder.child, 5_000)).toBe(true);
    expect(events(holder.eventsPath)).toEqual(["ready", "close-start", "close-end"]);
    expect(lockHolderPid(holder.vaultRoot)).toBeNull();
  }, 25_000);

  it("bounds a close that never settles before releasing the lock and exiting", async () => {
    const holder = startHolder("never");
    expect(await waitUntil(() => events(holder.eventsPath).includes("ready"), 15_000)).toBe(true);

    holder.child.kill("SIGTERM");
    expect(await waitUntil(() => events(holder.eventsPath).includes("close-start"), 5_000)).toBe(
      true,
    );
    await sleep(100);

    expect(lockHolderPid(holder.vaultRoot)).toBe(holder.child.pid);
    expect(await waitForExit(holder.child, 5_000)).toBe(true);
    expect(lockHolderPid(holder.vaultRoot)).toBeNull();
  }, 25_000);
});
