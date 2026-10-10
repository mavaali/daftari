// src/utils/flags.ts

// Reads `--name value` or `--name=value` from argv; null if absent.
export function parseFlag(argv: string[], name: string): string | null {
  const flag = `--${name}`;
  const flagIndex = argv.indexOf(flag);
  if (flagIndex !== -1 && flagIndex + 1 < argv.length) {
    return argv[flagIndex + 1] ?? null;
  }
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(`${flag}=`.length);
  return null;
}
