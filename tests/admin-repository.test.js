import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MAPS from '../src/data.js';
import { createMapRepository } from '../server/repository.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdu-admin-repository-'));
  const filename = path.join(directory, 'catalog.sqlite');
  t.after(() => {
    for (const basename of ['catalog.sqlite', 'catalog.sqlite-wal', 'catalog.sqlite-shm', 'catalog.sqlite-journal']) {
      const file = path.join(directory, basename); if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  });
  return filename;
}
const point = { building: 'five', floor: 0, id: 2 };
function currentRoom(repository, selected = point) { return repository.getMaps()[selected.building].floors[selected.floor].rooms.find(room => room.id === selected.id); }
function editable(repository, overrides = {}, selected = point) {
  const room = currentRoom(repository, selected);
  return { ...selected, number: room.number ?? '', labelRu: room.labelRu ?? room.label, labelKk: room.labelKk ?? '', revision: repository.getRevision(), ...overrides };
}
const code = expected => error => error.code === expected;

test('schema 1 migrates atomically to schema 2 without changing rooms, revision or existing metadata', t => {
  const filename = temporaryDatabase(t);
  let repository = createMapRepository({ filename });
  const maps = repository.getMaps(), revision = repository.getRevision(); repository.close();
  const legacy = new DatabaseSync(filename);
  legacy.exec("DROP TABLE room_changes; DROP TABLE admin_credentials; UPDATE metadata SET value='1' WHERE key='schema_version'");
  const seededAt = legacy.prepare("SELECT value FROM metadata WHERE key='seeded_at'").get().value; legacy.close();
  const differentSeed = structuredClone(MAPS); differentSeed.five.name = 'Must not replace saved data';
  repository = createMapRepository({ filename, seed: differentSeed });
  try {
    assert.deepEqual(repository.getMaps(), maps);
    assert.equal(repository.getRevision(), revision);
    assert.equal(repository.getAdminCredential(), null);
    assert.deepEqual(repository.getRoomHistory(point), []);
  } finally { repository.close(); }
  const check = new DatabaseSync(filename);
  try {
    assert.equal(check.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, '2');
    assert.equal(check.prepare("SELECT value FROM metadata WHERE key='seeded_at'").get().value, seededAt);
    assert.equal(check.prepare("SELECT count(*) AS total FROM rooms WHERE building_id IN ('five','seven')").get().total, 170);
    assert.equal(check.prepare("SELECT count(*) AS total FROM floors WHERE building_id IN ('five','seven')").get().total, 13);
  } finally { check.close(); }
});

test('a failed migration leaves version 1 and its existing catalog untouched', t => {
  const filename = temporaryDatabase(t);
  const repository = createMapRepository({ filename }); const revision = repository.getRevision(); repository.close();
  const old = new DatabaseSync(filename);
  old.exec("DROP TABLE room_changes; DROP TABLE admin_credentials; UPDATE metadata SET value='1' WHERE key='schema_version'; CREATE TABLE room_changes(custom TEXT)"); old.close();
  assert.throws(() => createMapRepository({ filename }), /already exists/);
  const check = new DatabaseSync(filename);
  try {
    assert.equal(check.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value, '1');
    assert.equal(check.prepare("SELECT value FROM metadata WHERE key='dataset_revision'").get().value, revision);
    assert.equal(check.prepare("SELECT count(*) AS total FROM sqlite_master WHERE name='admin_credentials'").get().total, 0);
    assert.equal(check.prepare("SELECT count(*) AS total FROM rooms WHERE building_id IN ('five','seven')").get().total, 170);
  } finally { check.close(); }
});

test('admin setup stores a hash exactly once and keeps it out of maps and revisions', t => {
  const filename = temporaryDatabase(t);
  const first = createMapRepository({ filename });
  const original = first.getMaps(), revision = first.getRevision();
  assert.equal(first.getAdminCredential(), null);
  assert.equal(first.setAdminCredential('scrypt$first-salted-hash'), true);
  assert.equal(first.setAdminCredential('scrypt$must-not-replace'), false);
  assert.deepEqual(first.getAdminCredential(), { passwordHash: 'scrypt$first-salted-hash' });
  assert.deepEqual(first.getMaps(), original);
  assert.equal(first.getRevision(), revision); first.close();
  const second = createMapRepository({ filename });
  try {
    assert.deepEqual(second.getAdminCredential(), { passwordHash: 'scrypt$first-salted-hash' });
    assert.equal(second.setAdminCredential('another-hash'), false);
    assert.doesNotMatch(JSON.stringify(second.getMaps()), /scrypt|password_hash|first-salted-hash/);
    for (const invalid of [null, 123, '', 'a'.repeat(513)]) assert.throws(() => second.setAdminCredential(invalid), code('VALIDATION_ERROR'));
  } finally { second.close(); }
});

test('adding UDN 2 to an existing database preserves edits, history and administrator credentials', t => {
  const filename = temporaryDatabase(t);
  const seed = { seven: MAPS.seven, five: MAPS.five };
  let repository = createMapRepository({ filename, seed });
  let before, history, oldRevision;
  try {
    repository.setAdminCredential('existing-administrator-hash');
    repository.updateRoom(editable(repository, { labelRu: 'Обновлённое название' }));
    before = repository.getMaps();
    history = repository.getRoomHistory(point);
    oldRevision = repository.getRevision();
  } finally { repository.close(); }

  const udn2 = { name: 'УДН 2', floors: { 1: { view: [0, 0, 300, 300], rooms: [{ id: 1, number: '101', label: 'Комната' }] } } };
  const invalid = structuredClone(udn2);
  invalid.floors[1].rooms.push({ ...invalid.floors[1].rooms[0] });
  assert.throws(() => createMapRepository({ filename, seed: { ...seed, udn2: invalid } }), /UNIQUE/);
  repository = createMapRepository({ filename, seed });
  try {
    assert.deepEqual(repository.getMaps(), before);
    assert.equal(repository.getRevision(), oldRevision);
  } finally { repository.close(); }

  const newSeed = { ...seed, five: { ...seed.five, name: 'Changed seed' }, udn2 };
  repository = createMapRepository({ filename, seed: newSeed });
  let newRevision;
  try {
    const catalog = repository.getMaps();
    assert.deepEqual(catalog, { ...before, udn2 });
    assert.deepEqual(repository.getRoomHistory(point), history);
    assert.deepEqual(repository.getAdminCredential(), { passwordHash: 'existing-administrator-hash' });
    newRevision = repository.getRevision();
    assert.notEqual(newRevision, oldRevision);
    assert.equal(newRevision, createHash('sha256').update(JSON.stringify(catalog)).digest('hex'));
  } finally { repository.close(); }

  repository = createMapRepository({ filename, seed: newSeed });
  try {
    assert.deepEqual(repository.getMaps(), { ...before, udn2 });
    assert.equal(repository.getRevision(), newRevision);
  } finally { repository.close(); }
});

test('merging UDN 2 corridor sections preserves the primary edit and all history', t => {
  const filename = temporaryDatabase(t);
  const primary = { id: 1, type: 'corridor', label: 'Коридор', points: '0,0 5,0 5,5 0,5' };
  const section = { id: 2, type: 'corridor', label: 'Коридор', points: '5,0 10,0 10,5 5,5' };
  const ordinary = { id: 2, type: 'room', label: 'Комната' };
  const oldSeed = { udn2: { floors: { 1: { rooms: [primary, section] }, 2: { rooms: [primary, ordinary] } } } };
  const merged = { id: 1, type: 'corridor', label: 'Коридор', polygons: [primary.points, section.points], mergedRoomIds: [2] };
  const seed = { udn2: { floors: { 1: { rooms: [merged] }, 2: oldSeed.udn2.floors[2] } } };
  const mainPoint = { building: 'udn2', floor: 1, id: primary.id };
  const sectionPoint = { ...mainPoint, id: section.id };
  let repository = createMapRepository({ filename, seed: oldSeed });
  let revision, previousMaps, history;
  try {
    repository.updateRoom(editable(repository, { labelRu: 'Главный коридор', labelKk: 'Бас дәліз', number: '09А' }, mainPoint));
    repository.updateRoom(editable(repository, { labelRu: 'Западный коридор', number: '09Б' }, sectionPoint));
    revision = repository.getRevision();
    previousMaps = repository.getMaps();
    history = [...repository.getRoomHistory(sectionPoint), ...repository.getRoomHistory(mainPoint)];
  } finally { repository.close(); }

  const invalidSeed = { udn2: { floors: { 1: seed.udn2.floors[1], 2: { rooms: [merged] } } } };
  assert.throws(() => createMapRepository({ filename, seed: invalidSeed }), /did not match the stored plan/);
  repository = createMapRepository({ filename, seed: oldSeed });
  try {
    assert.deepEqual(repository.getMaps(), previousMaps);
    assert.equal(repository.getRevision(), revision);
    assert.deepEqual(repository.getRoomHistory(mainPoint), [history[1]]);
    assert.deepEqual(repository.getRoomHistory(sectionPoint), [history[0]]);
  } finally { repository.close(); }

  repository = createMapRepository({ filename, seed });
  let mergedRevision;
  try {
    const maps = repository.getMaps();
    assert.deepEqual(maps.udn2.floors[1].rooms, [
      { ...merged, label: 'Главный коридор', labelRu: 'Главный коридор', labelKk: 'Бас дәліз', number: '09А' },
    ]);
    assert.deepEqual(maps.udn2.floors[2], previousMaps.udn2.floors[2]);
    assert.deepEqual(repository.getRoomHistory(mainPoint), history);
    assert.throws(() => repository.getRoomHistory(sectionPoint), code('NOT_FOUND'));
    mergedRevision = repository.getRevision();
    assert.notEqual(mergedRevision, revision);
    assert.equal(mergedRevision, createHash('sha256').update(JSON.stringify(maps)).digest('hex'));
  } finally { repository.close(); }

  repository = createMapRepository({ filename, seed });
  try {
    assert.equal(repository.getRevision(), mergedRevision);
    assert.deepEqual(repository.getRoomHistory(mainPoint), history);
  } finally { repository.close(); }

  const outlined = { ...merged, polygons: ['0,0 10,0 10,5 0,5'] };
  const outlinedSeed = { udn2: { floors: { ...seed.udn2.floors, 1: { rooms: [outlined] } } } };
  repository = createMapRepository({ filename, seed: outlinedSeed });
  let outlineRevision;
  try {
    assert.deepEqual(currentRoom(repository, mainPoint), { ...outlined, label: 'Главный коридор', labelRu: 'Главный коридор', labelKk: 'Бас дәліз', number: '09А' });
    assert.deepEqual(repository.getRoomHistory(mainPoint), history);
    outlineRevision = repository.getRevision();
    assert.notEqual(outlineRevision, mergedRevision);
  } finally { repository.close(); }

  repository = createMapRepository({ filename, seed: outlinedSeed });
  try { assert.equal(repository.getRevision(), outlineRevision); } finally { repository.close(); }

  const fresh = createMapRepository({ filename: ':memory:', seed: outlinedSeed });
  try { assert.deepEqual(fresh.getMaps(), outlinedSeed); } finally { fresh.close(); }
});

test('sanitary merges apply new defaults while preserving explicit administrator edits', t => {
  const filename = temporaryDatabase(t);
  const washroom = { id: 1, type: 'wc', label: 'Умывальная', labelKk: 'Жуынатын бөлме' };
  const toilet = { id: 2, type: 'wc', label: 'Туалет', labelKk: 'Әжетхана' };
  const sanitary = { id: 1, type: 'wc', label: 'Санузел', labelKk: 'Әжетхана', polygons: ['0,0 5,0 5,5', '5,0 10,0 10,5'], mergedRoomIds: [2] };
  const seedWith = rooms => ({ udn2: { floors: { 1: { rooms }, 2: { rooms }, 3: { rooms } } } });
  const at = (floor, id = 1) => ({ building: 'udn2', floor, id });
  const old = createMapRepository({ filename, seed: seedWith([washroom, toilet]) });
  let retiredHistory;
  try {
    old.updateRoom(editable(old, { labelRu: 'Старое название', labelKk: 'Ескі атау' }, at(1, 2)));
    retiredHistory = old.getRoomHistory(at(1, 2));
    old.updateRoom(editable(old, { number: '07' }, at(2)));
    old.updateRoom(editable(old, { labelRu: 'Санузел А', labelKk: 'Әжетхана А', number: '09А' }, at(3)));
  } finally { old.close(); }

  const seed = seedWith([sanitary]);
  const migrated = createMapRepository({ filename, seed });
  let revision;
  try {
    assert.deepEqual(currentRoom(migrated, at(1)), sanitary);
    assert.deepEqual(migrated.getRoomHistory(at(1)), retiredHistory);
    assert.deepEqual(currentRoom(migrated, at(2)), { ...sanitary, number: '07' });
    assert.deepEqual(currentRoom(migrated, at(3)), { ...sanitary, label: 'Санузел А', labelRu: 'Санузел А', labelKk: 'Әжетхана А', number: '09А' });
    for (const floor of [1, 2, 3]) assert.equal(migrated.getMaps().udn2.floors[floor].rooms.length, 1);
    revision = migrated.getRevision();
  } finally { migrated.close(); }

  const reopened = createMapRepository({ filename, seed });
  try {
    assert.equal(reopened.getRevision(), revision);
    assert.deepEqual(reopened.getRoomHistory(at(1)), retiredHistory);
    reopened.updateRoom(editable(reopened, { number: '08' }, at(2)));
    reopened.updateRoom(editable(reopened, { labelRu: 'Санузел' }, at(3)));
  } finally { reopened.close(); }

  const renamed = { ...sanitary, label: 'Туалет' };
  const renamedSeed = seedWith([renamed]);
  const updated = createMapRepository({ filename, seed: renamedSeed });
  try {
    assert.deepEqual(currentRoom(updated, at(1)), renamed);
    assert.deepEqual(currentRoom(updated, at(2)), { ...renamed, labelRu: 'Туалет', number: '08' });
    assert.deepEqual(currentRoom(updated, at(3)), { ...sanitary, labelRu: 'Санузел', labelKk: 'Әжетхана А', number: '09А' });
    assert.deepEqual(updated.getRoomHistory(at(1)), retiredHistory);
    assert.equal(updated.getRoomHistory(at(2)).length, 2);
    assert.equal(updated.getRoomHistory(at(3)).length, 2);
    revision = updated.getRevision();
  } finally { updated.close(); }

  const unchanged = createMapRepository({ filename, seed: renamedSeed });
  try { assert.equal(unchanged.getRevision(), revision); } finally { unchanged.close(); }
});

test('editing stores bilingual names and text cabinet numbers, preserves geometry, and persists across restart', t => {
  const filename = temporaryDatabase(t);
  const repository = createMapRepository({ filename });
  const before = currentRoom(repository), oldRevision = repository.getRevision();
  const result = repository.updateRoom(editable(repository, { number: '  01Ә  ', labelRu: '  Центр исследований  ', labelKk: '  Зерттеу орталығы  ' }));
  assert.equal(result.room.number, '01Ә');
  assert.equal(result.room.label, 'Центр исследований');
  assert.equal(result.room.labelRu, 'Центр исследований');
  assert.equal(result.room.labelKk, 'Зерттеу орталығы');
  assert.equal(result.room.building, 'five'); assert.equal(result.room.floor, 0);
  const after = currentRoom(repository);
  const untouched = room => Object.fromEntries(Object.entries(room).filter(([key]) => !['number', 'label', 'labelRu', 'labelKk'].includes(key)));
  assert.deepEqual(untouched(after), untouched(before));
  assert.notEqual(result.revision, oldRevision);
  assert.equal(result.revision, createHash('sha256').update(JSON.stringify(repository.getMaps())).digest('hex'));
  assert.equal(repository.getRevision(), result.revision); repository.close();
  const reopened = createMapRepository({ filename });
  try {
    assert.deepEqual(currentRoom(reopened), after);
    assert.equal(reopened.getRevision(), result.revision);
    assert.equal(reopened.getRoomHistory(point).length, 1);
  } finally { reopened.close(); }
  const check = new DatabaseSync(filename);
  try { assert.deepEqual({ ...check.prepare('SELECT number,typeof(number) AS storage FROM rooms WHERE building_id=? AND floor_number=? AND room_id=?').get('five', 0, 2) }, { number: '01Ә', storage: 'text' }); }
  finally { check.close(); }
});

test('no-op saves retain the original seed shape and create no revision or history change', () => {
  const repository = createMapRepository({ filename: ':memory:' });
  try {
    const revision = repository.getRevision(), input = editable(repository);
    const result = repository.updateRoom({ ...input, number: ` ${input.number} `, labelRu: ` ${input.labelRu} ` });
    assert.equal(result.revision, revision);
    assert.deepEqual(repository.getMaps(), MAPS);
    assert.deepEqual(repository.getRoomHistory(point), []);
    repository.updateRoom(editable(repository, { labelRu: 'Новое название' }));
    const changedRevision = repository.getRevision();
    repository.updateRoom(editable(repository));
    assert.equal(repository.getRevision(), changedRevision);
    assert.equal(repository.getRoomHistory(point).length, 1);
  } finally { repository.close(); }
});

test('history contains only before/after text fields and returns newest edits first', () => {
  const repository = createMapRepository({ filename: ':memory:' });
  try {
    repository.updateRoom(editable(repository, { labelRu: "Лаборатория O'Brien", labelKk: 'Зертхана', number: ' 01А ' }));
    repository.updateRoom(editable(repository, { number: '', labelKk: '' }));
    const history = repository.getRoomHistory(point);
    assert.equal(history.length, 2);
    assert.ok(history[0].id > history[1].id);
    assert.deepEqual(history[0].after, { number: '', labelRu: "Лаборатория O'Brien", labelKk: '' });
    assert.deepEqual(history[0].before, history[1].after);
    assert.deepEqual(history[1].before, { number: '01А', labelRu: 'Лаборатория', labelKk: '' });
    assert.equal(Object.hasOwn(currentRoom(repository), 'number'), false);
    assert.doesNotMatch(JSON.stringify(history), /"(?:area|source|cx|cy|door|points|passwordHash)"/);
    assert.equal(new Date(history[0].createdAt).toISOString(), history[0].createdAt);
    assert.equal(repository.getRoomHistory({ ...point, limit: 1 }).length, 1);
    for (const limit of [0, 101, 1.1, '20']) assert.throws(() => repository.getRoomHistory({ ...point, limit }), code('VALIDATION_ERROR'));
  } finally { repository.close(); }
});

test('optimistic revisions prevent lost updates across simultaneous repository connections', t => {
  const filename = temporaryDatabase(t);
  const first = createMapRepository({ filename }), second = createMapRepository({ filename });
  try {
    const stale = editable(second, { labelRu: 'A stale edit must not win' });
    const fresh = first.updateRoom(editable(first, { labelRu: 'Accepted edit' }));
    assert.equal(second.getRevision(), fresh.revision);
    assert.throws(() => second.updateRoom(stale), code('REVISION_CONFLICT'));
    assert.equal(currentRoom(second).label, 'Accepted edit');
    assert.equal(second.getRoomHistory(point).length, 1);
    assert.equal(second.updateRoom(editable(second, { labelRu: 'Next accepted edit' })).room.label, 'Next accepted edit');
  } finally { first.close(); second.close(); }
});

test('duplicate numbers are rejected only within the same corpus floor and normalize case and Latin A/B', () => {
  const repository = createMapRepository({ filename: ':memory:' });
  try {
    const other = { building: 'five', floor: 0, id: 3 };
    const original = repository.getMaps(), revision = repository.getRevision();
    for (const number of ['01А', '01а', '01A', ' 01a ']) assert.throws(() => repository.updateRoom(editable(repository, { number }, other)), code('DUPLICATE_NUMBER'));
    assert.equal(repository.getRevision(), revision); assert.deepEqual(repository.getMaps(), original);
    assert.deepEqual(repository.getRoomHistory(other), []);
    const nextFloor = { building: 'five', floor: 1, id: 2 };
    assert.equal(repository.updateRoom(editable(repository, { number: '01А' }, nextFloor)).room.number, '01А');
    const nextCorpus = { building: 'seven', floor: 1, id: 2 };
    assert.equal(repository.updateRoom(editable(repository, { number: '01А' }, nextCorpus)).room.number, '01А');
  } finally { repository.close(); }
});

test('invalid fields and missing rooms roll back without altering revisions or history', () => {
  const repository = createMapRepository({ filename: ':memory:' });
  try {
    const before = repository.getMaps(), revision = repository.getRevision();
    for (const invalid of [
      { number: 1 }, { number: 'a'.repeat(25) }, { labelRu: '' }, { labelRu: ' '.repeat(5) },
      { labelRu: 'x'.repeat(121) }, { labelKk: 'x'.repeat(121) }, { labelKk: null },
      { labelRu: '<img onerror=alert(1)>' }, { number: '01\nA' }, { labelKk: 'Zero\u200bWidth' },
      { number: '<02>' }, { revision: 'not-a-revision' }, { floor: '0' }, { id: 1.5 },
    ]) assert.throws(() => repository.updateRoom(editable(repository, invalid)), code('VALIDATION_ERROR'));
    for (const invalid of [null, undefined, [], true]) assert.throws(() => repository.updateRoom(invalid), code('VALIDATION_ERROR'));
    assert.throws(() => repository.updateRoom({ ...editable(repository), id: 99999 }), code('NOT_FOUND'));
    assert.throws(() => repository.getRoomHistory({ ...point, building: 'missing' }), code('NOT_FOUND'));
    assert.equal(repository.getRevision(), revision); assert.deepEqual(repository.getMaps(), before);
    assert.deepEqual(repository.getRoomHistory(point), []);
  } finally { repository.close(); }
});
