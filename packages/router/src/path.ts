export type VaultPath = { vault: string | null; path: string };

export function parseVaultPath(raw: string): VaultPath {
  const idx = raw.indexOf(":");
  if (idx === -1) return { vault: null, path: raw };
  return { vault: raw.slice(0, idx), path: raw.slice(idx + 1) };
}

export function formatVaultPath(vault: string, path: string): string {
  return `${vault}:${path}`;
}
