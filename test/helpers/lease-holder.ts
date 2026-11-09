// A real lease-lock holder in its own process, for the lock tests. It acquires
// the vault lock with the given mode and (short) heartbeat/lease, prints one
// line to stdout ("ok" or "refused: <message>"), and then stays alive
// heartbeating until it is signalled. SIGTERM releases the lock and exits 0,
// like the real servers' shutdown path.
//
// The vault path arrives via the environment, NOT argv, on purpose: the old
// ps-based liveness check keyed on the vault path in the holder's command
// line, so a holder without it is exactly the "live holder judged stale"
// case the lease lock must get right.
//
// env: LEASE_VAULT. argv: <mode stdio|serve> <heartbeatMs> <leaseMs> [takeover]

import { acquireLock, releaseLock } from "../../src/lifecycle/lock.js";

const vaultRoot = process.env.LEASE_VAULT;
const [mode, heartbeatMs, leaseMs, takeover] = process.argv.slice(2);

if (vaultRoot === undefined || (mode !== "stdio" && mode !== "serve")) {
  process.stderr.write(
    "lease-holder: usage: LEASE_VAULT=<vault> <stdio|serve> <heartbeatMs> <leaseMs>\n",
  );
  process.exit(2);
}

process.once("SIGTERM", () => {
  releaseLock(vaultRoot);
  process.exit(0);
});

const r = await acquireLock(vaultRoot, "lease-holder", {
  mode,
  heartbeatMs: Number(heartbeatMs),
  leaseMs: Number(leaseMs),
  takeover: takeover === "takeover",
  onLeaseLost: () => {
    process.stdout.write("lost\n");
  },
});
process.stdout.write(r.ok ? "ok\n" : `refused: ${r.error.message}\n`);
if (!r.ok) process.exit(3);
setInterval(() => undefined, 1_000);
