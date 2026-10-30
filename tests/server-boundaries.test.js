import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createAppServer } from '../server.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hdu-boundary-'));
  await mkdir(path.join(root, 'dist/assets'), { recursive: true });
  await mkdir(path.join(root, 'var'), { recursive: true });
  await writeFile(path.join(root, 'dist/index.html'), '<!doctype html><title>HDU public app</title>');
  await writeFile(path.join(root, 'server.mjs'), 'PRIVATE SERVER SOURCE');
  await writeFile(path.join(root, 'var/hdu-map.sqlite'), 'PRIVATE DATABASE');
  const server = await createAppServer({ root, databasePath: ':memory:', logger: { error() {} }, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeIdleConnections(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^hdu-boundary-/);
    await rm(root, { recursive: true, force: true });
  });
  return { root, server, base: `http://127.0.0.1:${server.address().port}` };
}
function rawRequest(base, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(base, { path: pathname, ...options }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject); request.end();
  });
}

test('API rate limit returns a safe 429, counts by peer, and resets its window', async t => {
  const { base } = await fixture(t, { rateLimit: { windowMs: 100, max: 2 } });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(base + '/api/v1/search?q=211');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('ratelimit-remaining'), String(1 - i));
    await response.arrayBuffer();
  }
  const rejected = await fetch(base + '/api/v1/maps', { headers: { 'X-Forwarded-For': '10.0.0.99' } });
  assert.equal(rejected.status, 429, 'an untrusted forwarding header must not bypass a peer limit');
  assert.equal(rejected.headers.get('ratelimit-remaining'), '0');
  assert.ok(Number(rejected.headers.get('retry-after')) >= 1);
  assert.equal(rejected.headers.get('cache-control'), 'no-store');
  assert.equal((await rejected.json()).error.code, 'RATE_LIMITED');
  assert.equal((await fetch(base + '/api/health')).status, 200, 'health stays independent of API throttling');
  await delay(110);
  const retried = await fetch(base + '/api/v1/search?q=211');
  assert.equal(retried.status, 200); await retried.arrayBuffer();
});

test('every request gets a new server-generated request id including errors', async t => {
  const { base } = await fixture(t);
  const ids = new Set();
  for (const pathname of ['/', '/api/health', '/api/v1/maps', '/api/no-such-route', '/missing.js']) {
    const response = await fetch(base + pathname, { headers: { 'X-Request-Id': 'caller-forged-id' } });
    const id = response.headers.get('x-request-id');
    assert.match(id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.notEqual(id, 'caller-forged-id'); assert.ok(!ids.has(id)); ids.add(id);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    await response.arrayBuffer();
  }
});

test('production never serves SQLite, source files or traversal outside dist', async t => {
  const { base } = await fixture(t);
  for (const pathname of ['/server.mjs', '/server/repository.js', '/src/data.js', '/var/hdu-map.sqlite', '/var/hdu-map.sqlite-wal', '/var/hdu-map.sqlite-shm', '/package.json', '/.git/config.json']) {
    const response = await fetch(base + pathname);
    assert.equal(response.status, 404, pathname);
    assert.doesNotMatch(await response.text(), /PRIVATE SERVER SOURCE|PRIVATE DATABASE/);
  }
  for (const pathname of ['/%2e%2e%5cserver.mjs', '/assets/..%5c..%5cvar/hdu-map.sqlite', '/%00.sqlite']) {
    const response = await rawRequest(base, pathname);
    assert.equal(response.status, 400, pathname);
    assert.doesNotMatch(response.body, /PRIVATE DATABASE|PRIVATE SERVER SOURCE/);
  }
});

test('cross-origin requests get no permissive CORS headers and static HTML has a restrictive CSP', async t => {
  const { base } = await fixture(t);
  for (const pathname of ['/', '/api/v1/maps']) {
    const response = await fetch(base + pathname, { headers: { Origin: 'https://foreign.example' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    if (pathname === '/') {
      const csp = response.headers.get('content-security-policy');
      assert.match(csp, /default-src 'self'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors 'self'/);
    }
    await response.arrayBuffer();
  }
  const preflight = await fetch(base + '/api/v1/routes', { method: 'OPTIONS', headers: { Origin: 'https://foreign.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  await preflight.arrayBuffer();
});

test('a disconnected static client releases its file stream instead of leaving a paused descriptor', async t => {
  const { base, root } = await fixture(t);
  const filename = path.join(root, 'dist/assets/large.bin');
  await writeFile(filename, randomBytes(8 * 1024 * 1024));
  const streams = [], original = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...args) => {
    const stream = original(...args);
    if (args[0] === filename) streams.push(stream);
    return stream;
  });
  syncBuiltinESMExports();
  try {
    await new Promise((resolve, reject) => {
      const request = http.get(base + '/assets/large.bin', response => {
        response.once('data', () => { response.destroy(); resolve(); });
        response.on('error', () => {});
      });
      request.on('error', reject);
    });
    await delay(60);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].destroyed, true, 'File stream must close after response disconnect, including while backpressured');
  } finally {
    for (const stream of streams) {
      if (!stream.closed) await new Promise(resolve => { stream.once('close', resolve); stream.destroy(); });
    }
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
