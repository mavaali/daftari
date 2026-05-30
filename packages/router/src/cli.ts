#!/usr/bin/env node
import { main } from "./index.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  },
);
