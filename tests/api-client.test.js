import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, loadMaps, searchRoomsRemote, createRoute } from '../src/api-client.js';

const room = { id: 1, number: '01А', label: 'Кабинет', x: 0, y: 0, w: 30, h: 20, cx: 15, cy: 10, type: 'room' };
const point = { ...room, building: 'five', floor: 0 };
const floor = { view: [0, 0, 100, 100], rooms: [room] };
const maps = { five: { floors: { 0: floor } }, seven: { floors: { 1: floor } } };
const route = { ok: true, building: 'five', fromId: 1, fromFloor: 0, targetId: 2, targetFloor: 1, segments: { 0: [[1, 2], [2, 3]], 1: [[3, 4], [4, 5]] } };
const envelope = data => ({ data, revision: 'seed-revision' });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function intercept(t, handler) { return t.mock.method(globalThis, 'fetch', handler); }

test('loads and validates maps from the backend envelope', async t => {
  const fetch = intercept(t, async (url, options) => {
    assert.equal(url, '/api/v1/maps');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Accept, 'application/json');
    return json(envelope(maps));
  });
  const result = await loadMaps();
  assert.deepEqual(result, envelope(maps));
  assert.equal(fetch.mock.callCount(), 1);
});

test('search preserves leading zeros and Unicode while sending ranking context, not filters', async t => {
  intercept(t, async url => {
    const query = new URL(url, 'http://test').searchParams;
    assert.equal(query.get('q'), 'жертөле 01А');
    assert.equal(query.get('contextBuilding'), 'five');
    assert.equal(query.get('contextFloor'), '0');
    assert.equal(query.has('building'), false);
    assert.equal(query.has('floor'), false);
    assert.equal(query.get('routeOnly'), 'true');
    assert.equal(query.get('limit'), '60');
    return json(envelope([point]));
  });
  const result = await searchRoomsRemote('жертөле 01А', { building: 'five', floor: 0, routeOnly: true });
  assert.equal(result.data[0].number, '01А');
  assert.equal(result.data[0].floor, 0);
});

test('ranking context does not reject a cabinet on another floor', async t => {
  const otherFloor = { ...point, id: 5, number: '305', floor: 3 };
  intercept(t, async () => json(envelope([otherFloor])));
  const result = await searchRoomsRemote('305', { building: 'five', floor: 1 });
  assert.equal(result.data[0].floor, 3);
});

test('empty search response is valid and does not use a local fallback', async t => {
  intercept(t, async () => json(envelope([])));
  assert.deepEqual((await searchRoomsRemote('несуществующий')).data, []);
});

test('an explicitly unknown cabinet number stays null rather than becoming a technical id', async t => {
  intercept(t, async () => json(envelope([{ ...point, number: null }])));
  const result = await searchRoomsRemote('Кабинет');
  assert.equal(result.data[0].number, null);
  assert.equal(result.data[0].id, 1);
});

test('route POST sends only canonical keys and never converts cabinet numbers into ids', async t => {
  const from = { ...point, number: '01А', area: 99, label: 'Кабинет' };
  const to = { ...point, id: 2, floor: 1, number: '06Б' };
  const before = structuredClone({ from, to });
  intercept(t, async (url, options) => {
    assert.equal(url, '/api/v1/routes');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { from: { building: 'five', floor: 0, id: 1 }, to: { building: 'five', floor: 1, id: 2 } });
    return json(envelope(route));
  });
  assert.deepEqual((await createRoute(from, to)).data, route);
  assert.deepEqual({ from, to }, before);
});

test('invalid endpoint and invalid search options fail without a request', async t => {
  const fetch = intercept(t, async () => { throw Error('must not fetch'); });
  await assert.rejects(createRoute({ ...point, id: '01А' }, point), error => error instanceof ApiError && error.errorKey === 'routeError');
  await assert.rejects(searchRoomsRemote('01А', { floor: '0' }), error => error instanceof ApiError && error.errorKey === 'searchError');
  await assert.rejects(searchRoomsRemote('x'.repeat(121)), error => error.code === 'INVALID_QUERY');
  assert.equal(fetch.mock.callCount(), 0);
});

test('backend route errors map to localized keys without exposing diagnostics', async t => {
  let current;
  intercept(t, async () => json({ error: { code: current, message: 'PRIVATE STACK /srv/db.js:27' } }, 422));
  for (const [code, key] of [['CROSS_BUILDING', 'crossBuilding'], ['PARTIAL_PLAN', 'partial'], ['SAME_POINT', 'samePoint'], ['NO_ROUTE', 'noRoute']]) {
    current = code;
    await assert.rejects(createRoute(point, { ...point, id: 2 }), error => error instanceof ApiError && error.status === 422 && error.code === code && error.errorKey === key && !error.message.includes('PRIVATE'));
  }
});

test('unexpected server errors use serverError and preserve status', async t => {
  intercept(t, async () => json({ error: { code: 'INTERNAL_ERROR', message: 'SQL error' } }, 500));
  await assert.rejects(loadMaps(), error => error instanceof ApiError && error.status === 500 && error.errorKey === 'serverError' && !error.message.includes('SQL'));
});

test('non-JSON HTTP errors remain ApiError with HTTP status', async t => {
  intercept(t, async () => new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(loadMaps(), error => error instanceof ApiError && error.status === 502 && error.errorKey === 'serverError');
});

test('invalid JSON and malformed successful envelopes are rejected', async t => {
  let response;
  intercept(t, async () => response);
  const malformed = [
    new Response('not JSON', { status: 200 }),
    json({ data: maps }),
    json({ data: maps, revision: null }),
    json(envelope({ five: { floors: {} } })),
    json(envelope({ ...maps, seven: { floors: { 1: { ...floor, view: [0, 0, -10, 20] } } } }))
  ];
  for (response of malformed) await assert.rejects(loadMaps(), error => error instanceof ApiError && error.code === 'INVALID_RESPONSE');
});

test('malformed search and route payloads cannot reach the map UI', async t => {
  let response = json(envelope([{ ...point, number: 1 }]));
  intercept(t, async () => response);
  await assert.rejects(searchRoomsRemote('01А'), error => error.code === 'INVALID_RESPONSE');
  response = json(envelope({ ...route, segments: { 0: [[null, 2]] } }));
  await assert.rejects(createRoute(point, { ...point, id: 2 }), error => error.code === 'INVALID_RESPONSE');
});

test('network failures become a localized ApiError instead of raw fetch errors', async t => {
  intercept(t, async () => { throw new TypeError('fetch failed internal stack'); });
  await assert.rejects(loadMaps(), error => error instanceof ApiError && error.code === 'NETWORK_ERROR' && error.errorKey === 'networkError' && !error.message.includes('internal'));
});

test('already-aborted external signal does not start a fetch', async t => {
  const fetch = intercept(t, async () => { throw Error('must not fetch'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadMaps({ signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(fetch.mock.callCount(), 0);
});

test('external cancellation aborts fetch and cleans the signal listener even if fetch ignores abort', async t => {
  let combined;
  intercept(t, (url, options) => { combined = options.signal; return new Promise(() => {}); });
  const external = new AbortController();
  const removed = t.mock.method(external.signal, 'removeEventListener');
  const request = loadMaps({ signal: external.signal });
  external.abort('caller cancelled');
  await assert.rejects(request, error => error.name === 'AbortError');
  assert.equal(combined.aborted, true);
  assert.equal(removed.mock.callCount(), 1);
});

test('8000ms timeout aborts and rejects even if fetch ignores the signal', async t => {
  let runTimeout, combined, cleared = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, duration) => { assert.equal(duration, 8000); runTimeout = callback; return 123; });
  t.mock.method(globalThis, 'clearTimeout', timer => { assert.equal(timer, 123); cleared++; });
  intercept(t, (url, options) => { combined = options.signal; return new Promise(() => {}); });
  const request = loadMaps();
  runTimeout();
  await assert.rejects(request, error => error instanceof ApiError && error.code === 'TIMEOUT' && error.errorKey === 'networkError');
  assert.equal(combined.aborted, true);
  assert.equal(cleared, 1);
});

test('success cleans timeout and external signal listener', async t => {
  const external = new AbortController();
  const removed = t.mock.method(external.signal, 'removeEventListener');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  intercept(t, async () => json(envelope(maps)));
  await loadMaps({ signal: external.signal });
  assert.equal(removed.mock.callCount(), 1);
  assert.equal(cleared.mock.callCount(), 1);
});
