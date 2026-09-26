import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const requestedScope = process.argv.slice(2);
if (requestedScope.length === 0) {
  console.error('Usage: node scripts/run-required-vitest.mjs <vitest arguments>');
  process.exit(2);
}

const reportPath = join(tmpdir(), `umareal-required-vitest-${randomUUID()}.json`);
const vitestCli = createRequire(import.meta.url).resolve('vitest/vitest.mjs');
const run = spawnSync(
  process.execPath,
  [vitestCli, 'run', ...requestedScope, '--reporter=json', `--outputFile=${reportPath}`],
  { env: process.env, stdio: 'inherit' },
);

if (run.error) {
  console.error(`Unable to start required Vitest scope: ${run.error.message}`);
  process.exit(1);
}

let exitCode = run.status ?? 1;
try {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const total = Number(report.numTotalTests ?? 0);
  const passed = Number(report.numPassedTests ?? 0);
  const failed = Number(report.numFailedTests ?? 0);
  const pending = Number(report.numPendingTests ?? 0);
  const todo = Number(report.numTodoTests ?? 0);
  if (!report.success || total < 1 || failed > 0 || pending > 0 || todo > 0 || passed !== total) {
    console.error(`Required Vitest scope did not fully run: total=${total}, passed=${passed}, failed=${failed}, skipped=${pending}, todo=${todo}`);
    for (const result of report.testResults ?? []) {
      for (const assertion of result.assertionResults ?? []) {
        if (assertion.status !== 'failed') continue;
        console.error(`Failed: ${assertion.fullName ?? assertion.title ?? result.name}`);
        for (const message of assertion.failureMessages ?? []) console.error(message);
      }
    }
    exitCode = 1;
  } else {
    console.info(`Required Vitest scope passed: ${passed} test(s), with no skipped or todo tests.`);
    exitCode = 0;
  }
} catch (error) {
  console.error(`Unable to read required Vitest report: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  rmSync(reportPath, { force: true });
}
process.exit(exitCode);
