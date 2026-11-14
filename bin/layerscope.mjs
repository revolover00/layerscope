#!/usr/bin/env node
// layerscope — analyze docker-save / OCI image archives. See docs/CLI.md.
import { run } from '../src/cli/main.mjs';

run(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(`layerscope: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 2;
  },
);
