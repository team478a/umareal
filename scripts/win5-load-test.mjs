import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeNumber(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function percentile(values, percentage) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentage) - 1)];
}

export async function runWin5LoadTest(options = {}) {
  const baseUrl = String(options.baseUrl ?? process.env.WIN5_LOAD_BASE_URL ?? 'http://127.0.0.1:4000/api/v1').replace(/\/$/, '');
  const productId = options.productId ?? process.env.WIN5_LOAD_PRODUCT_ID;
  const cookie = options.cookie ?? process.env.WIN5_LOAD_COOKIE;
  const requestCount = positiveInteger(options.requestCount ?? process.env.WIN5_LOAD_REQUESTS, 200, 'WIN5_LOAD_REQUESTS');
  const concurrency = Math.min(requestCount, positiveInteger(options.concurrency ?? process.env.WIN5_LOAD_CONCURRENCY, 20, 'WIN5_LOAD_CONCURRENCY'));
  const p95LimitMs = nonNegativeNumber(options.p95LimitMs ?? process.env.WIN5_LOAD_P95_MS, 750, 'WIN5_LOAD_P95_MS');
  const errorRateLimit = nonNegativeNumber(options.errorRateLimit ?? process.env.WIN5_LOAD_ERROR_RATE, 0, 'WIN5_LOAD_ERROR_RATE');
  if (errorRateLimit > 1) throw new Error('WIN5_LOAD_ERROR_RATE must be between 0 and 1');

  const routes = ['/win5', '/win5/performance', ...(productId ? [`/win5/${encodeURIComponent(productId)}`] : [])];
  const durations = [];
  const statuses = new Map();
  const failures = [];
  let cursor = 0;
  const startedAt = performance.now();

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= requestCount) return;
      const route = routes[index % routes.length];
      const requestStartedAt = performance.now();
      try {
        const response = await fetch(`${baseUrl}${route}`, {
          headers: {
            Accept: 'application/json',
            ...(cookie ? { Cookie: cookie } : {})
          },
          signal: AbortSignal.timeout(10_000)
        });
        await response.arrayBuffer();
        durations.push(performance.now() - requestStartedAt);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        if (!response.ok) failures.push({ route, status: response.status });
      } catch (error) {
        durations.push(performance.now() - requestStartedAt);
        failures.push({ route, error: error instanceof Error ? error.name : 'UNKNOWN' });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = performance.now() - startedAt;
  const result = {
    baseUrl,
    routes,
    requestCount,
    concurrency,
    elapsedMs: Math.round(elapsedMs),
    requestsPerSecond: Math.round((requestCount / elapsedMs) * 100_000) / 100,
    latencyMs: {
      p50: Math.round(percentile(durations, 0.5)),
      p95: Math.round(percentile(durations, 0.95)),
      max: Math.round(Math.max(...durations))
    },
    statuses: Object.fromEntries([...statuses.entries()].sort(([left], [right]) => left - right)),
    failures: failures.length,
    errorRate: failures.length / requestCount,
    thresholds: { p95LimitMs, errorRateLimit },
    passed: failures.length / requestCount <= errorRateLimit && percentile(durations, 0.95) <= p95LimitMs
  };
  return result;
}

async function main() {
  const result = await runWin5LoadTest();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`WIN5 load test failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
