#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReport, report } from './lib/ac-report.mjs';

// `npm run ac:report` (AC-BUD-05, AC-UI-03, AC-OPS-07): every AC covered or manual;
// exits nonzero when one is MISSING.

const root = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  process.exitCode = report(collectReport(root));
} catch (error) {
  console.error(`ac:report: ${error instanceof Error ? error.message : 'failed'}`);
  process.exitCode = 1;
}
