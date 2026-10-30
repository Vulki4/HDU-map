import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MAPS from '../src/data.js';
import { createMapRepository } from '../server/repository.js';

function temporaryDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hdu-repository-test-'));
  const filename = path.join(directory, 'catalog.sqlite');
  t.after(() => {
    for (const basename of ['catalog.sqlite', 'catalog.sqlite-wal', 'catalog.sqlite-shm', 'catalog.sqlite-journal']) {
      const file = path.join(directory, basename); if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  });
  return filename;
}

test('SQLite repository restores all 170 rooms and 13 floors without changing internal values', () => {
  const repository = createMapRepository({ filename: ':memory:' });
  try {
    const maps = repository.getMaps();
    assert.deepEqual(maps, MAPS);
    assert.equal(Object.values(maps).flatMap(map => Object.values(map.floors)).length, 13);
    assert.equal(Object.values(maps).flatMap(map => Object.values(map.floors).flatMap(floor => floor.rooms)).length, 170);
    assert.equal(repository.getRevision(), createHash('sha256').update(JSON.stringify(MAPS)).digest('hex'));
    maps.five.floors[0].rooms[0].label = 'client mutation';
    assert.deepEqual(repository.getMaps(), MAPS);
  } finally { repository.close(); repository.close(); }
});

test('restart keeps persisted data and initial revision instead of overwriting from seed', t => {
  const filename = temporaryDatabase(t);
  const first = createMapRepository({ filename });
  const revision = first.getRevision(); first.close();
  const editor = new DatabaseSync(filename);
  editor.prepare('UPDATE rooms SET number=? WHERE building_id=? AND floor_number=? AND room_id=?').run('00Б', 'five', 0, 2);
  editor.close();
  const nextSeed = structuredClone(MAPS); nextSeed.five.name = 'A different future seed';
  const second = createMapRepository({ filename, seed: nextSeed });
  try {
    assert.equal(second.getMaps().five.name, MAPS.five.name);
    assert.equal(second.getMaps().five.floors[0].rooms.find(room => room.id === 2).number, '00Б');
    assert.equal(second.getRevision(), revision);
  } finally { second.close(); }
});

test('cabinet numbers retain TEXT storage, leading zeroes and Kazakh/Cyrillic suffixes', t => {
  const filename = temporaryDatabase(t);
  const repository = createMapRepository({ filename }); repository.close();
  const db = new DatabaseSync(filename);
  try {
    const record = db.prepare('SELECT number,typeof(number) AS storage FROM rooms WHERE building_id=? AND floor_number=? AND room_id=?').get('five', 0, 2);
    assert.equal(record.number, '01А'); assert.equal(record.storage, 'text');
    const suffix = db.prepare('SELECT number FROM rooms WHERE building_id=? AND floor_number=? AND room_id=?').get('five', 0, 11);
    assert.equal(suffix.number, '06Б');
    assert.equal(db.prepare('SELECT json_extract(data_json,\'$.rooms\') AS rooms FROM floors LIMIT 1').get().rooms, null);
  } finally { db.close(); }
});

test('foreign keys reject orphan floors and rooms', t => {
  const filename = temporaryDatabase(t);
  const repository = createMapRepository({ filename }); repository.close();
  const db = new DatabaseSync(filename); db.exec('PRAGMA foreign_keys=ON');
  try {
    assert.throws(() => db.prepare('INSERT INTO floors(building_id,floor_number,position,data_json) VALUES(?,?,?,?)').run('missing', 1, 0, '{}'), /FOREIGN KEY/);
    assert.throws(() => db.prepare('INSERT INTO rooms(building_id,floor_number,room_id,position,data_json) VALUES(?,?,?,?,?)').run('five', 999, 1, 0, '{}'), /FOREIGN KEY/);
  } finally { db.close(); }
});

test('parameter binding safely preserves SQL metacharacters in seed names and numbers', () => {
  const seed = { "x'); DROP TABLE rooms; --": { name: "O'Brien — Қазақша", floors: { 0: { spineY: 1, rooms: [{ id: 1, number: "01А'); DELETE FROM buildings; --", label: "'quoted'; --", cx: 1, cy: 2, area: 3 }] } } } };
  const repository = createMapRepository({ filename: ':memory:', seed });
  try { assert.deepEqual(repository.getMaps(), seed); assert.match(repository.getRevision(), /^[a-f0-9]{64}$/); }
  finally { repository.close(); }
});

test('unsupported schemas fail clearly and remain untouched', t => {
  const filename = temporaryDatabase(t), db = new DatabaseSync(filename);
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES('schema_version','99')"); db.close();
  assert.throws(() => createMapRepository({ filename }), /Unsupported map database schema version: 99/);
  const check = new DatabaseSync(filename);
  try { assert.equal(check.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version').value, '99'); assert.equal(check.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='buildings'").get().count, 0); }
  finally { check.close(); }
});

test('failed initial seeding rolls back all schema and data', t => {
  const filename = temporaryDatabase(t);
  const invalid = { bad: { floors: { 1: { rooms: [{ id: 1, number: '01' }, { id: 1, number: '02' }] } } } };
  assert.throws(() => createMapRepository({ filename, seed: invalid }), /UNIQUE/);
  const repository = createMapRepository({ filename });
  try { assert.deepEqual(repository.getMaps(), MAPS); } finally { repository.close(); }
});

test('database files cannot be created outside owned var or temporary directories', () => {
  const unowned = fileURLToPath(new URL('../forbidden-repository.sqlite', import.meta.url));
  assert.throws(() => createMapRepository({ filename: unowned }), /Database path must stay inside/);
  assert.equal(fs.existsSync(unowned), false);
});
