import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { runWin5LoadTest } from './win5-load-test.mjs';

let server;
let baseUrl;

before(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/v1/win5/failure') {
      response.statusCode = 503;
      response.end('{"code":"UNAVAILABLE"}');
      return;
    }
    response.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('runs bounded concurrent read traffic and reports latency and status totals', async () => {
  const result = await runWin5LoadTest({ baseUrl, productId: 'product', requestCount: 30, concurrency: 6, p95LimitMs: 1000 });
  assert.equal(result.passed, true);
  assert.equal(result.requestCount, 30);
  assert.equal(result.failures, 0);
  assert.equal(result.statuses['200'], 30);
  assert.equal(result.routes.length, 3);
  assert.ok(result.latencyMs.p95 <= 1000);
});

test('fails the threshold when an endpoint returns an error', async () => {
  const result = await runWin5LoadTest({ baseUrl, productId: 'failure', requestCount: 3, concurrency: 1, p95LimitMs: 1000 });
  assert.equal(result.passed, false);
  assert.equal(result.failures, 1);
  assert.equal(result.statuses['503'], 1);
});
