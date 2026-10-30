import test from 'node:test';
import assert from 'node:assert/strict';
import maps from '../src/data.js';
import { buildCatalog, normalize, keyOf, searchRooms, findRoute } from '../src/map-core.js';

const catalog = buildCatalog(maps);
const search = (query, routeOnly = false, building = 'five', floor = 0) => searchRooms(query, { catalog, building, floor }, routeOnly);

test('13 floors and all 170 unchanged rooms are catalogued with stable keys', () => {
  assert.equal(catalog.length, 170);
  assert.equal(new Set(catalog.map(keyOf)).size, 170);
  assert.equal(Object.values(maps).flatMap(map => Object.keys(map.floors)).length, 13);
  assert.deepEqual(Object.keys(maps.five.floors).map(Number), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(maps.seven.floors).map(Number), [1, 2, 3, 4, 5, 6, 7]);
  for (const room of catalog) assert.equal(room.number, maps[room.building].floors[room.floor].rooms.find(original => original.id === room.id).number);
});

test('Russian and Kazakh searches work independently of the interface locale', () => {
  assert.deepEqual(search('библиотека').map(keyOf), search('кітапхана').map(keyOf));
  assert.ok(search('кітапхана').some(room => room.label === 'Библиотека'));
  assert.deepEqual(search('лестница').map(keyOf), search('баспалдақ').map(keyOf));
  assert.ok(search('Әжетхана').length);
  assert.equal(normalize('  06B Ё  '), '06б е');
});

test('corpus prefixes, basement, floors, leading zeroes and suffixes stay distinguishable', () => {
  for (const query of ['А корпус 01А', 'корпус А 01A', 'А корпусы 01А']) {
    const matches = search(query);
    assert.ok(matches.length, query);
    assert.ok(matches.every(room => room.building === 'five' && room.number === '01А'), query);
  }
  assert.ok(search('жертөле 06Б').some(room => room.floor === 0 && room.number === '06Б'));
  assert.ok(search('подвал 06А').some(room => room.floor === 0 && room.number === '06А'));
  assert.ok(search('01').every(room => room.number?.startsWith('01')));
  for (const query of ['2 этаж', '2-қабат']) {
    const matches = search(query); assert.ok(matches.length); assert.ok(matches.every(room => room.floor === 2));
  }
  assert.ok(search('корпусы Б баспалдақ').every(room => room.building === 'seven' && room.type === 'stair'));
});

test('technical search remains explicit, route points exclude partial plans, and search is pure', () => {
  const before = JSON.stringify(catalog);
  assert.ok(search('по плану 12').length);
  assert.ok(search('жоспар 12').every(room => room.id === 12));
  assert.ok(search('', true).every(room => !room.partial));
  assert.ok(search('').some(room => room.partial));
  search('305'); assert.equal(JSON.stringify(catalog), before);
});

test('local context keeps the original search ranking', () => {
  const matches = search('', false, 'seven', 3);
  assert.ok(matches.length);
  assert.ok(matches.slice(0, maps.seven.floors[3].rooms.length).every(room => room.building === 'seven' && room.floor === 3));
  assert.equal(search('211', false, 'five', 0)[0].number, '211');
});

test('121 existing staircase-to-room route connections retain their geometry', () => {
  const before = JSON.stringify(maps); let checks = 0;
  for (const [building, map] of Object.entries(maps)) {
    for (const [floor, data] of Object.entries(map.floors)) {
      const target = data.rooms.find(room => room.type !== 'stair' && !room.partial);
      for (const [startFloor, startData] of Object.entries(map.floors)) {
        for (const start of startData.rooms.filter(room => room.type === 'stair')) {
          const route = findRoute(maps, building, +startFloor, start.id, +floor, target.id);
          assert.equal(route.ok, true, `${building}:${startFloor} → ${floor}`);
          assert.ok(route.segments[floor]); assert.equal(route.errorKey, null);
          assert.deepEqual(route.segments[startFloor][0], start.start || [start.cx, start.cy]);
          assert.deepEqual(route.segments[floor].at(-1), target.start || [target.cx, target.cy]);
          assert.equal('fromLabel' in route, false); checks++;
        }
      }
    }
  }
  assert.equal(checks, 121); assert.equal(JSON.stringify(maps), before);
});

test('invalid, partial and identical points return language-neutral errors', () => {
  const source = catalog.find(room => room.building === 'five' && !room.partial);
  const partial = catalog.find(room => room.building === 'five' && room.partial);
  assert.equal(findRoute(maps, 'constructor', 1, 1, 2, 2).errorKey, 'noRoute');
  assert.equal(findRoute(maps, 'five', 99, 1, source.floor, source.id).errorKey, 'noRoute');
  assert.equal(findRoute(maps, 'five', NaN, 1, source.floor, source.id).errorKey, 'chooseBoth');
  assert.equal(findRoute(maps, 'five', source.floor, source.id, source.floor, source.id).errorKey, 'samePoint');
  assert.equal(findRoute(maps, 'five', partial.floor, partial.id, source.floor, source.id).errorKey, 'partial');
});
