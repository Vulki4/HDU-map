import { ROOM_KK } from './i18n.js';

export const normalize = value => String(value ?? '').toLowerCase().replaceAll('ё', 'е').replaceAll('a', 'а').replaceAll('b', 'б').trim();
export const keyOf = room => `${room.building}:${room.floor}:${room.id}`;

export function buildCatalog(maps) {
  return Object.entries(maps).flatMap(([building, map]) => Object.entries(map.floors).flatMap(([floor, data]) => data.rooms.map(room => ({ ...room, building, floor: +floor }))));
}

// The same index serves both interface languages. Never infer a cabinet number
// from its technical plan ID; leading zeroes and letter suffixes stay intact.
export function searchRooms(query, { catalog = [], building, floor } = {}, routeOnly = false) {
  const q = normalize(query);
  let list = catalog.filter(room => !routeOnly || !room.partial);
  const corpus = q.match(/(?:^|\s)(?:([аб])\s*корпус(?:ы)?|корпус(?:ы)?\s*([аб]))(?=\s|$)/);
  if (corpus) list = list.filter(room => room.building === ((corpus[1] || corpus[2]) === 'а' ? 'five' : 'seven'));
  const basement = /подвал|жертөле/.test(q);
  const floorMatch = q.match(/(\d+)\s*[- ]?(?:этаж|эт\.?|қабат)/);
  if (basement) list = list.filter(room => room.floor === 0);
  if (floorMatch) list = list.filter(room => room.floor === +floorMatch[1]);
  const technical = /план|экспликац|жоспар/.test(q);
  const term = q.replace(corpus?.[0] ?? /$^/, ' ').replace(floorMatch?.[0] ?? /$^/, ' ').replace(/подвал|жертөле/g, ' ').trim();
  const nums = term.match(/\d+/g) || [];
  if (technical) {
    list = list.filter(room => nums.length > 1 ? room.floor === +nums[0] && room.id === +nums[1] : nums.length ? room.id === +nums[0] : false);
  } else if (nums.length >= 3) {
    list = list.filter(room => room.building === (+nums[0] === 1 ? 'seven' : 'five') && room.floor === +nums[1] && (room.id === +nums[2] || normalize(room.number) === normalize(nums[2])));
  } else if (nums.length === 2) {
    list = list.filter(room => room.floor === +nums[0] && (room.id === +nums[1] || normalize(room.number) === normalize(nums[1])));
  } else if (nums.length === 1) {
    const token = (term.match(/\d+[a-zа-яәғқңөұүһі]?/iu) || [])[0];
    list = list.filter(room => (room.number && normalize(room.number).startsWith(normalize(token))) || (!token.startsWith('0') && room.id === +nums[0]));
  } else {
    const tokens = term.split(/[\s,]+/).filter(word => word && !/^(кабинет|каб|аудитория|бөлме)$/.test(word));
    list = list.filter(room => {
      const text = normalize(`${room.label} ${room.labelRu ?? ''} ${room.labelKk ?? ''} ${ROOM_KK[room.label] ?? ''} ${room.type === 'wc' ? 'туалет санузел әжетхана' : ''} ${room.number ?? ''}`);
      return tokens.every(token => text.includes(token));
    });
  }
  const rank = room => (room.number && normalize(room.number) === term ? 100 : 0) + (room.building === building ? 10 : 0) + (room.floor === floor ? 4 : 0);
  return list.sort((a, b) => rank(b) - rank(a) || a.floor - b.floor || a.id - b.id);
}

// Preserve the original schematic graph: room → door → corridor → stairs.
// Cross-building validation belongs to the caller, which has both point objects.
export function findRoute(maps, building, fromF, fromId, toF, toId) {
  fromF = Number(fromF); fromId = Number(fromId); toF = Number(toF); toId = Number(toId);
  const result = { building, fromId, fromFloor: fromF, targetFloor: toF, targetId: toId, segments: {} };
  const fail = errorKey => ({ ...result, ok: false, errorKey });
  if (!maps || !Object.prototype.hasOwnProperty.call(maps, building)) return fail('noRoute');
  const map = maps[building];
  if (![fromF, fromId, toF, toId].every(Number.isInteger)) return fail('chooseBoth');
  const source = map.floors[fromF]?.rooms.find(room => room.id === fromId);
  const destination = map.floors[toF]?.rooms.find(room => room.id === toId);
  if (!source || !destination) return fail('noRoute');
  if (source.partial || destination.partial) return fail('partial');
  if (fromF === toF && fromId === toId) return fail('samePoint');

  const nodes = {}, edges = {}, stairs = {};
  function node(key, floor, point) { nodes[key] = { f: floor, p: point }; edges[key] ??= []; return key; }
  function link(a, b, cost) {
    const p = nodes[a].p, q = nodes[b].p;
    const weight = cost ?? Math.hypot(p[0] - q[0], p[1] - q[1]);
    edges[a].push([b, weight]); edges[b].push([a, weight]);
  }
  for (const [floorKey, data] of Object.entries(map.floors)) {
    const floor = +floorKey, corridor = [];
    if (floor < Math.min(fromF, toF) || floor > Math.max(fromF, toF)) continue;
    for (const room of data.rooms.filter(room => !room.partial)) {
      const base = `${floor}:${room.id}`, point = room.start || [room.cx, room.cy];
      node(base, floor, point);
      let door = room.door || (room.type === 'stair' ? [point[0], data.spineY] : [room.cx, data.spineY]);
      if (room.type === 'stair') door = [point[0], data.spineY];
      if (room.type === 'corridor') door = [room.cx, data.spineY];
      const doorKey = node(`${base}:door`, floor, door); link(base, doorKey);
      const corridorKey = node(`${base}:corr`, floor, [door[0], data.spineY]); link(doorKey, corridorKey);
      corridor.push(corridorKey);
      if (room.type === 'stair') (stairs[floor] ??= []).push({ key: base, x: point[0] });
    }
    corridor.sort((a, b) => nodes[a].p[0] - nodes[b].p[0]);
    for (let i = 1; i < corridor.length; i++) link(corridor[i - 1], corridor[i]);
  }
  const floors = Object.keys(map.floors).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < floors.length; i++) {
    const a = (stairs[floors[i - 1]] || []).sort((a, b) => a.x - b.x);
    const b = (stairs[floors[i]] || []).sort((a, b) => a.x - b.x);
    for (let j = 0; j < Math.min(a.length, b.length); j++) link(a[j].key, b[j].key, 250);
  }
  const start = `${fromF}:${fromId}`, end = `${toF}:${toId}`;
  const distance = { [start]: 0 }, previous = {}, todo = new Set(Object.keys(nodes));
  while (todo.size) {
    const current = [...todo].reduce((a, b) => (distance[a] ?? Infinity) < (distance[b] ?? Infinity) ? a : b);
    if (!Number.isFinite(distance[current])) break;
    todo.delete(current);
    if (current === end) break;
    for (const [next, weight] of edges[current]) {
      if (distance[current] + weight < (distance[next] ?? Infinity)) { distance[next] = distance[current] + weight; previous[next] = current; }
    }
  }
  if (!Number.isFinite(distance[end])) return fail('noRoute');
  const keys = [];
  for (let current = end; current; current = previous[current]) { keys.unshift(current); if (current === start) break; }
  const segments = {};
  for (const key of keys) { const { f, p } = nodes[key]; (segments[f] ??= []).push(p); }
  return { ...result, ok: true, segments, errorKey: null };
}
