import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';

const PASSWORD = 'Only-for-automated-tests-ӘҒҚ-2026';
const POINT = { building: 'five', floor: 0, id: 2 };
const endpoint = '/api/v1/admin/rooms/five/0/2';
const historyEndpoint = '/api/v1/admin/history/five/0/2';
const edited = { number: '01Ғ', labelRu: 'Лаборатория робототехники', labelKk: 'Робототехника зертханасы' };
const roomAt = maps => maps.five.floors[0].rooms.find(room => room.id === 2);
const geometry = room => Object.fromEntries(Object.entries(room).filter(([key]) => !['number', 'label', 'labelRu', 'labelKk'].includes(key)));
const key = room => `${room.building}:${room.floor}:${room.id}`;

async function start(databasePath) {
  const server = await createAppServer({ databasePath, rateLimit: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() { await new Promise(resolve => server.close(resolve)); server.closeAllConnections?.(); },
    async request(pathname, { method = 'GET', body, cookie, csrf, expected = 200, headers = {} } = {}) {
      const response = await fetch(base + pathname, {
        method,
        headers: {
          ...(!['GET','HEAD'].includes(method) ? { Origin: base } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, expected, `${method} ${pathname}`);
      return { response, payload: [204,304].includes(response.status) || method === 'HEAD' ? null : await response.json() };
    },
  };
}

test('admin setup, room editing, public refresh and restart use one real HTTP/SQLite data path', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdu-admin-http-integration-'));
  const filename = path.join(directory, 'catalog.sqlite');
  let server;
  try {
    server = await start(filename);
    const initial = await server.request('/api/v1/maps');
    const original = roomAt(initial.payload.data), originalRevision = initial.payload.revision;
    assert.equal(original.number, '01А');
    const initialEtag = initial.response.headers.get('etag'); assert.ok(initialEtag);
    assert.equal((await server.request('/api/v1/maps', { headers: { 'If-None-Match': initialEtag }, expected: 304 })).payload, null);
    const session = await server.request('/api/v1/admin/session');
    assert.deepEqual(session.payload.data, { configured: false, authenticated: false, canSetup: true });
    const setup = await server.request('/api/v1/admin/setup', { method: 'POST', body: { password: PASSWORD } });
    const cookie = setup.response.headers.get('set-cookie').split(';')[0], csrf = setup.payload.data.csrfToken;
    assert.equal(setup.payload.data.authenticated, true); assert.ok(csrf);
    const auth = { cookie, csrf };
    const inventory = await server.request('/api/v1/admin/rooms?building=five&floor=0', { cookie });
    assert.ok(inventory.payload.data.some(room => key(room) === key(POINT)));

    const saved = await server.request(endpoint, { method: 'PATCH', ...auth, body: { ...edited, revision: originalRevision } });
    assert.equal(saved.payload.data.number, edited.number);
    assert.equal(saved.payload.data.labelRu, edited.labelRu); assert.equal(saved.payload.data.labelKk, edited.labelKk);
    assert.notEqual(saved.payload.revision, originalRevision);
    const savedRevision = saved.payload.revision;
    const refreshed = await server.request('/api/v1/maps', { headers: { 'If-None-Match': initialEtag } });
    assert.notEqual(refreshed.response.headers.get('etag'), initialEtag);
    assert.equal(refreshed.payload.revision, savedRevision);
    const publicRoom = roomAt(refreshed.payload.data);
    assert.equal(publicRoom.number, edited.number); assert.equal(publicRoom.label, edited.labelRu);
    assert.equal(publicRoom.labelRu, edited.labelRu); assert.equal(publicRoom.labelKk, edited.labelKk);
    assert.deepEqual(geometry(publicRoom), geometry(original));
    assert.doesNotMatch(JSON.stringify(refreshed.payload), /"(?:area|source|sourcePage|sourceAsset|explanationPage|passwordHash|password_hash|csrfToken)"/);
    for (const q of [edited.number, edited.labelRu, edited.labelKk]) {
      const search = await server.request('/api/v1/search?' + new URLSearchParams({ q }));
      assert.equal(search.payload.revision, savedRevision);
      assert.ok(search.payload.data.some(room => key(room) === key(POINT)), `Public search must find saved ${q}`);
    }
    const previousNumber = await server.request('/api/v1/search?' + new URLSearchParams({ q: original.number }));
    assert.equal(previousNumber.payload.data.some(room => key(room) === key(POINT)), false);
    const unchanged = await server.request('/api/v1/search?q=305');
    assert.ok(unchanged.payload.data.some(room => room.building === 'five' && room.floor === 3 && room.number === '305'));

    const history = await server.request(historyEndpoint, { cookie });
    assert.equal(history.payload.data.length, 1);
    assert.deepEqual(history.payload.data[0].before, { number: '01А', labelRu: 'Лаборатория', labelKk: '' });
    assert.deepEqual(history.payload.data[0].after, edited);
    assert.doesNotMatch(JSON.stringify(history.payload), /"(?:area|cx|cy|door|points|password_hash)"/);
    const stale = await server.request(endpoint, { method: 'PATCH', ...auth, body: { ...edited, labelRu: 'Stale value must not win', revision: originalRevision }, expected: 409 });
    assert.equal(stale.payload.error.code, 'REVISION_CONFLICT');
    const duplicate = await server.request('/api/v1/admin/rooms/five/0/3', { method: 'PATCH', ...auth, body: { ...edited, revision: savedRevision }, expected: 409 });
    assert.equal(duplicate.payload.error.code, 'DUPLICATE_NUMBER');
    const noOp = await server.request(endpoint, { method: 'PATCH', ...auth, body: { ...edited, revision: savedRevision } });
    assert.equal(noOp.payload.revision, savedRevision);
    assert.equal((await server.request(historyEndpoint, { cookie })).payload.data.length, 1);
    assert.deepEqual((await server.request('/api/v1/maps')).payload, refreshed.payload);

    await server.close(); server = null;
    assert.equal(fs.readFileSync(filename).subarray(0,16).toString(), 'SQLite format 3\0');
    server = await start(filename);
    const afterRestart = await server.request('/api/v1/admin/session', { cookie });
    assert.deepEqual(afterRestart.payload.data, { configured: true, authenticated: false, canSetup: false });
    await server.request('/api/v1/admin/rooms', { cookie, expected: 401 });
    const login = await server.request('/api/v1/admin/login', { method: 'POST', body: { password: PASSWORD } });
    const nextCookie = login.response.headers.get('set-cookie').split(';')[0];
    assert.notEqual(nextCookie, cookie); assert.notEqual(login.payload.data.csrfToken, csrf);
    assert.equal(login.payload.data.authenticated, true);
    assert.equal(login.payload.revision, savedRevision);
    assert.deepEqual((await server.request('/api/v1/maps')).payload, refreshed.payload);
    const persisted = await server.request(historyEndpoint, { cookie: nextCookie });
    assert.deepEqual(persisted.payload.data, history.payload.data);
    assert.equal(persisted.payload.revision, savedRevision);
  } finally {
    if (server) await server.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) { const file = filename + suffix; if (fs.existsSync(file)) fs.unlinkSync(file); }
    fs.rmdirSync(directory);
  }
});
