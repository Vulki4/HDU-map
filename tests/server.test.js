import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAppServer } from '../server.mjs';

test('Node server serves the app, assets and health without exposing source files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hdu-server-'));
  await mkdir(path.join(root, 'dist/assets'), { recursive: true });
  await writeFile(path.join(root, 'dist/index.html'), '<!doctype html><title>HDU</title>');
  await writeFile(path.join(root, 'dist/assets/app-12345678.js'), 'console.log("HDU");'.repeat(100));
  const server = await createAppServer({ root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await (await fetch(base + '/api/health')).json()).frontend, 'react');
    assert.match(await (await fetch(base + '/?building=five')).text(), /HDU/);
    const asset = await fetch(base + '/assets/app-12345678.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.match(await asset.text(), /console.log/);
    assert.equal((await fetch(base + '/missing.js')).status, 404);
    assert.equal((await fetch(base + '/server.mjs')).status, 404);
    assert.equal((await fetch(base + '/api/unknown')).status, 404);
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/', { method: 'HEAD' })).status, 200);
    const traversalStatus = await new Promise(resolve => http.get(base + '/%2e%2e%5cpackage.json', res => { res.resume(); resolve(res.statusCode); }));
    assert.equal(traversalStatus, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    // The target is a test-created directory under the OS temporary directory.
    assert.ok(root.startsWith(path.join(tmpdir(), 'hdu-server-')));
    await rm(root, { recursive: true, force: true });
  }
});
