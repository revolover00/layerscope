// CLI orchestration: parse → resolve input (file or spooled stdin) → analyze
// with the unmodified engine → print → apply thresholds → exit code.

import { readFileSync } from 'node:fs';
import { parseArgs, HELP, UsageError } from './args.mjs';
import { openDiskBlob, spoolStdinToTemp } from './file-blob.mjs';
import { buildReport, formatTable, checkThresholds } from './report.mjs';
import { analyzeImage } from '../core/analyze.js';

export function toolVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function run(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`layerscope: ${err.message}`);
      return 2;
    }
    throw err;
  }

  if (parsed.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.command === 'version') {
    console.log(`layerscope ${toolVersion()}`);
    return 0;
  }

  let blob = null;
  let tempCleanup = null;
  try {
    let path = parsed.file;
    if (path === '-') {
      const spooled = await spoolStdinToTemp(process.stdin);
      tempCleanup = spooled.cleanup;
      path = spooled.path;
    }
    blob = await openDiskBlob(path);
    const analysis = await analyzeImage(blob, {
      platform: parsed.platform ?? undefined,
      ...(parsed.maxLayerBytes !== null ? { maxLayerBytes: parsed.maxLayerBytes } : {}),
    });
    const report = buildReport(analysis, { toolVersion: toolVersion() });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      const source = parsed.file === '-' ? 'stdin' : parsed.file;
      process.stdout.write(`${formatTable(report, { source })}\n`);
    }
    const failures = checkThresholds(report, parsed);
    for (const f of failures) console.error(`layerscope: ${f}`);
    return failures.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(`layerscope: ${err && err.message ? err.message : err}`);
    return 2;
  } finally {
    if (blob) await blob.close();
    if (tempCleanup) await tempCleanup();
  }
}
