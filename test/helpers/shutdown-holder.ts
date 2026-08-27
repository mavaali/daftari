import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { installShutdownHandlers } from "../../src/index.js";
import { acquireLock } from "../../src/lifecycle/lock.js";

const [vaultRoot, eventsPath, gatePath, mode] = process.argv.slice(2);

if (vaultRoot === undefined || eventsPath === undefined || gatePath === undefined) {
  process.stderr.write("shutdown-holder: missing fixture arguments\n");
  process.exit(2);
}

const lock = await acquireLock(vaultRoot, "shutdown-test", { mode: "serve" });
if (!lock.ok) {
  process.stderr.write(`shutdown-holder: ${lock.error.message}\n`);
  process.exit(2);
}

installShutdownHandlers(vaultRoot, async () => {
  appendFileSync(eventsPath, "close-start\n", "utf-8");
  if (mode === "never") {
    await new Promise<void>(() => undefined);
  } else {
    while (!existsSync(gatePath)) await sleep(10);
    appendFileSync(eventsPath, "close-end\n", "utf-8");
  }
});

appendFileSync(eventsPath, "ready\n", "utf-8");
setInterval(() => undefined, 1_000);
