export async function main(argv: string[]): Promise<number> {
  const configIdx = argv.indexOf("--config");
  if (configIdx === -1 || !argv[configIdx + 1]) {
    process.stderr.write("usage: daftari-router --config <vaults.yaml>\n");
    return 2;
  }
  process.stderr.write(`daftari-router booted (config: ${argv[configIdx + 1]})\n`);
  return 0;
}
