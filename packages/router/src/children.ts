import { type ChildClient, startChild } from "./client.js";
import type { RouterConfig, VaultConfig } from "./config.js";

export type ChildPool = {
  get: (name: string) => ChildClient | null;
  all: () => ChildClient[];
  close: () => Promise<void>;
};

export function createPool(children: ChildClient[]): ChildPool {
  const byName = new Map(children.map((c) => [c.name, c]));
  return {
    get: (n) => byName.get(n) ?? null,
    all: () => [...children],
    close: async () => {
      await Promise.allSettled(children.map((c) => c.close()));
    },
  };
}

export async function startPool(
  config: RouterConfig,
  daftariBin = "daftari",
  spawner: (vault: VaultConfig, bin: string) => Promise<ChildClient> = startChild,
): Promise<ChildPool> {
  const started: ChildClient[] = [];
  try {
    for (const v of config.vaults) {
      process.stderr.write(`router: starting vault '${v.name}' at ${v.path}\n`);
      started.push(await spawner(v, daftariBin));
    }
    return createPool(started);
  } catch (e) {
    await Promise.allSettled(started.map((c) => c.close()));
    throw e;
  }
}
