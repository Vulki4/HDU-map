import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';

async function start(databasePath = ':memory:') {
  const server = await createAppServer({ databasePath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, async close() { await new Promise(resolve => server.close(resolve)); server.closeAllConnections?.(); } };
}
const getJSON = async (base, pathname) => {
  const response = await fetch(base + pathname);
  assert.equal(response.status, 200, pathname);
  return { response, payload: await response.json() };
};
const forbidden = new Set(['area', 'source', 'sourcePage', 'sourceAsset', 'explanationPage']);
function assertStudentData(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `Internal ${key} must not appear in public API`);
    assertStudentData(nested);
  }
}

test('real Node HTTP bootstrap reads the SQLite catalog and publishes only student data', async () => {
  const server = await start();
  try {
    const { payload: health } = await getJSON(server.base, '/api/health');
    assert.equal(health.ok, true);
    const { response, payload } = await getJSON(server.base, '/api/v1/maps');
    assert.match(payload.revision, /^[a-f0-9]{64}$/);
    const maps = payload.data;
    assert.deepEqual(Object.keys(maps.five.floors).map(Number), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(Object.keys(maps.seven.floors).map(Number), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(Object.values(maps).flatMap(map => Object.values(map.floors).flatMap(floor => floor.rooms)).length, 170);
    assert.equal(maps.five.floors[0].rooms.find(room => room.id === 2).number, '01А');
    assertStudentData(payload);
    const etag = response.headers.get('etag'); assert.ok(etag);
    assert.equal((await fetch(server.base + '/api/v1/maps', { headers: { 'If-None-Match': etag } })).status, 304);
    const head = await fetch(server.base + '/api/v1/maps', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal((await fetch(server.base + '/var/hdu-map.sqlite')).status, 404);
    assert.equal((await fetch(server.base + '/server/repository.js')).status, 404);
  } finally { await server.close(); }
});

test('HTTP search and POST route connect the first floor to 305 while preserving both languages', async () => {
  const server = await start();
  try {
    const { payload: bootstrap } = await getJSON(server.base, '/api/v1/maps');
    const { payload: found } = await getJSON(server.base, '/api/v1/search?' + new URLSearchParams({ q: '305', contextBuilding: 'five', contextFloor: '1' }));
    const destination = found.data.find(room => room.number === '305' && room.building === 'five');
    assert.ok(destination); assert.equal(destination.floor, 3);
    const { payload: kazakh } = await getJSON(server.base, '/api/v1/search?' + new URLSearchParams({ q: 'кітапхана' }));
    const { payload: russian } = await getJSON(server.base, '/api/v1/search?' + new URLSearchParams({ q: 'библиотека' }));
    assert.ok(kazakh.data.length);
    assert.deepEqual(kazakh.data.map(room => `${room.building}:${room.floor}:${room.id}`), russian.data.map(room => `${room.building}:${room.floor}:${room.id}`));
    const { payload: basement } = await getJSON(server.base, '/api/v1/search?' + new URLSearchParams({ q: '06Б', building: 'five', floor: '0', routeOnly: 'true' }));
    assert.ok(basement.data.some(room => room.number === '06Б' && room.floor === 0));
    const start = bootstrap.data.five.floors[1].rooms.find(room => room.type === 'stair' && !room.partial);
    const from = { building: 'five', floor: 1, id: start.id }, to = { building: destination.building, floor: destination.floor, id: destination.id };
    const response = await fetch(server.base + '/api/v1/routes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) });
    assert.equal(response.status, 200);
    const route = await response.json();
    assert.equal(route.data.ok, true); assert.equal(route.revision, bootstrap.revision);
    assert.equal(route.data.fromFloor, 1); assert.equal(route.data.targetFloor, 3);
    assert.ok(route.data.segments['1'].length); assert.ok(route.data.segments['2'].length); assert.ok(route.data.segments['3'].length);
    assert.deepEqual(route.data.segments['1'][0], start.start || [start.cx, start.cy]);
    assertStudentData(route);
    const cross = await fetch(server.base + '/api/v1/routes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: { building: 'seven', floor: 1, id: bootstrap.data.seven.floors[1].rooms[0].id } }) });
    assert.equal(cross.status, 422); assert.equal((await cross.json()).error.code, 'CROSS_BUILDING');
  } finally { await server.close(); }
});

test('HTTP server restart reopens a real SQLite database with the same dataset revision', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdu-http-database-'));
  const filename = path.join(directory, 'catalog.sqlite');
  let server;
  try {
    server = await start(filename);
    const first = (await getJSON(server.base, '/api/v1/maps')).payload;
    await server.close(); server = null;
    assert.equal(fs.readFileSync(filename).subarray(0, 16).toString(), 'SQLite format 3\0');
    server = await start(filename);
    const second = (await getJSON(server.base, '/api/v1/maps')).payload;
    assert.equal(second.revision, first.revision); assert.deepEqual(second.data, first.data);
  } finally {
    if (server) await server.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) { const file = filename + suffix; if (fs.existsSync(file)) fs.unlinkSync(file); }
    fs.rmdirSync(directory);
  }
});
