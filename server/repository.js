import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MAPS from '../src/data.js';

const SCHEMA_VERSION = '2';
const dataDirectory = fileURLToPath(new URL('../var/', import.meta.url));
const contained = (root, target) => { const relative = path.relative(root, target); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
function canonicalPath(filename) {
  const missing = []; let current = filename;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Database path has no existing parent');
    missing.unshift(path.basename(current)); current = parent;
  }
  return path.join(realpathSync(current), ...missing);
}
function databasePath(filename) {
  if (filename === ':memory:') return filename;
  if (typeof filename !== 'string' || !filename || filename.includes('\0')) throw new TypeError('Database filename must be a local filesystem path');
  const resolved = path.resolve(filename);
  const roots = [dataDirectory, os.tmpdir()].map(root => path.resolve(root));
  const root = roots.find(candidate => contained(candidate, resolved));
  if (!root || !contained(canonicalPath(root), canonicalPath(resolved))) throw new Error('Database path must stay inside the project var directory or the system temporary directory');
  mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

const schema = `
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE buildings (
    id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE CHECK(position >= 0),
    data_json TEXT NOT NULL CHECK(json_valid(data_json))
  ) STRICT;
  CREATE TABLE floors (
    building_id TEXT NOT NULL, floor_number INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    data_json TEXT NOT NULL CHECK(json_valid(data_json)),
    PRIMARY KEY(building_id, floor_number), UNIQUE(building_id, position),
    FOREIGN KEY(building_id) REFERENCES buildings(id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE rooms (
    building_id TEXT NOT NULL, floor_number INTEGER NOT NULL, room_id INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0), number TEXT,
    data_json TEXT NOT NULL CHECK(json_valid(data_json)),
    PRIMARY KEY(building_id, floor_number, room_id), UNIQUE(building_id, floor_number, position),
    FOREIGN KEY(building_id, floor_number) REFERENCES floors(building_id, floor_number) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX rooms_number ON rooms(number);
`;

const adminSchema = `
  CREATE TABLE admin_credentials (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE room_changes (
    id INTEGER PRIMARY KEY,
    building_id TEXT NOT NULL,
    floor_number INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    before_json TEXT NOT NULL CHECK(json_valid(before_json)),
    after_json TEXT NOT NULL CHECK(json_valid(after_json)),
    created_at TEXT NOT NULL,
    FOREIGN KEY(building_id, floor_number, room_id) REFERENCES rooms(building_id, floor_number, room_id)
  ) STRICT;
  CREATE INDEX room_changes_room ON room_changes(building_id, floor_number, room_id, id DESC);
`;

function storageError(code, message) {
  return Object.assign(new Error(message), { code });
}
function requirePoint(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw storageError('VALIDATION_ERROR', 'An existing room must be identified.');
  const { building, floor, id } = value;
  if (typeof building !== 'string' || !building || !Number.isSafeInteger(floor) || floor < 0 || !Number.isSafeInteger(id) || id < 1) throw storageError('VALIDATION_ERROR', 'An existing room must be identified.');
}
function textField(value, { required = false, max }) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}<>]/u.test(value)) throw storageError('VALIDATION_ERROR', 'Room fields must contain plain printable text.');
  const result = value.trim();
  if ([...result].length > max || required && !result) throw storageError('VALIDATION_ERROR', 'Room field length is invalid.');
  return result;
}
const numberKey = value => String(value ?? '').toLowerCase().replaceAll('ё', 'е').replaceAll('a', 'а').replaceAll('b', 'б').trim();
const editableFields = room => ({ number: room.number ?? '', labelRu: room.labelRu ?? room.label, labelKk: room.labelKk ?? '' });

function seedDatabase(db, seed) {
  const revision = createHash('sha256').update(JSON.stringify(seed)).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(schema);
    db.exec(adminSchema);
    const metadata = db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)');
    metadata.run('schema_version', SCHEMA_VERSION);
    metadata.run('dataset_revision', revision);
    metadata.run('seeded_at', new Date().toISOString());
    const buildingInsert = db.prepare('INSERT INTO buildings(id,position,data_json) VALUES(?,?,?)');
    const floorInsert = db.prepare('INSERT INTO floors(building_id,floor_number,position,data_json) VALUES(?,?,?,?)');
    const roomInsert = db.prepare('INSERT INTO rooms(building_id,floor_number,room_id,position,number,data_json) VALUES(?,?,?,?,?,?)');
    Object.entries(seed).forEach(([building, map], buildingIndex) => {
      const { floors, ...buildingData } = map;
      buildingInsert.run(building, buildingIndex, JSON.stringify(buildingData));
      Object.entries(floors).forEach(([floorKey, data], floorIndex) => {
        const floor = Number(floorKey), { rooms, ...floorData } = data;
        if (!Number.isInteger(floor)) throw new TypeError('Floor keys must be integers');
        floorInsert.run(building, floor, floorIndex, JSON.stringify(floorData));
        rooms.forEach((room, roomIndex) => {
          if (!Number.isInteger(room.id)) throw new TypeError('Room IDs must be integers');
          if (room.number !== undefined && typeof room.number !== 'string') throw new TypeError('Cabinet numbers must be strings to preserve leading zeroes and suffixes');
          roomInsert.run(building, floor, room.id, roomIndex, room.number ?? null, JSON.stringify(room));
        });
      });
    });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function createMapRepository({ filename = path.join(dataDirectory, 'hdu-map.sqlite'), seed = MAPS } = {}) {
  const db = new DatabaseSync(databasePath(filename));
  let closed = false;
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    if (tables.length === 0) seedDatabase(db, seed);
    else {
      if (!tables.includes('metadata')) throw new Error('Unsupported map database: schema_version metadata is missing');
      const version = db.prepare('SELECT value FROM metadata WHERE key=?').get('schema_version')?.value;
      if (!['1', SCHEMA_VERSION].includes(version)) throw new Error(`Unsupported map database schema version: ${version ?? 'missing'} (expected ${SCHEMA_VERSION})`);
      if (!['buildings', 'floors', 'rooms'].every(table => tables.includes(table))) throw new Error('Invalid map database: catalog tables are missing');
      const revision = db.prepare('SELECT value FROM metadata WHERE key=?').get('dataset_revision')?.value;
      if (!/^[a-f0-9]{64}$/.test(revision ?? '')) throw new Error('Invalid map database: dataset_revision is missing or invalid');
      if (version === '1') {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(adminSchema);
          db.prepare('UPDATE metadata SET value=? WHERE key=?').run(SCHEMA_VERSION, 'schema_version');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } else if (!['admin_credentials', 'room_changes'].every(table => tables.includes(table))) throw new Error('Invalid map database: administration tables are missing');
    }
    const revision = db.prepare('SELECT value FROM metadata WHERE key=?').get('dataset_revision')?.value;
    if (!/^[a-f0-9]{64}$/.test(revision ?? '')) throw new Error('Invalid map database: dataset_revision is missing or invalid');
    const buildings = db.prepare('SELECT id,data_json FROM buildings ORDER BY position,id');
    const floors = db.prepare('SELECT floor_number,data_json FROM floors WHERE building_id=? ORDER BY position,floor_number');
    const rooms = db.prepare('SELECT number,data_json FROM rooms WHERE building_id=? AND floor_number=? ORDER BY position,room_id');
    const revisionQuery = db.prepare('SELECT value FROM metadata WHERE key=?');
    const roomQuery = db.prepare('SELECT number,data_json FROM rooms WHERE building_id=? AND floor_number=? AND room_id=?');
    const sameFloorNumbers = db.prepare('SELECT room_id,number FROM rooms WHERE building_id=? AND floor_number=? AND room_id<>? AND number IS NOT NULL');
    const update = db.prepare('UPDATE rooms SET number=?,data_json=? WHERE building_id=? AND floor_number=? AND room_id=?');
    const insertChange = db.prepare('INSERT INTO room_changes(building_id,floor_number,room_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)');
    const changeQuery = db.prepare('SELECT id,before_json,after_json,created_at FROM room_changes WHERE building_id=? AND floor_number=? AND room_id=? ORDER BY id DESC LIMIT ?');
    const ensureOpen = () => { if (closed) throw new Error('Map repository is closed'); };
    function getRevision() { ensureOpen(); return revisionQuery.get('dataset_revision').value; }
    function recordRoom(record) {
      const room = JSON.parse(record.data_json);
      if (record.number === null) delete room.number; else room.number = record.number;
      return room;
    }
    function getMaps() {
        ensureOpen();
        const maps = {};
        for (const building of buildings.all()) {
          const map = JSON.parse(building.data_json); map.floors = {};
          for (const floor of floors.all(building.id)) {
            const data = JSON.parse(floor.data_json);
            data.rooms = rooms.all(building.id, floor.floor_number).map(recordRoom);
            map.floors[floor.floor_number] = data;
          }
          Object.defineProperty(maps, building.id, { value: map, enumerable: true, configurable: true, writable: true });
        }
        return maps;
    }
    return {
      getMaps,
      getRevision,
      getAdminCredential() {
        ensureOpen();
        const record = db.prepare('SELECT password_hash FROM admin_credentials WHERE id=1').get();
        return record ? { passwordHash: record.password_hash } : null;
      },
      setAdminCredential(passwordHash) {
        ensureOpen();
        if (typeof passwordHash !== 'string' || !passwordHash || passwordHash.length > 512) throw storageError('VALIDATION_ERROR', 'A password hash is required.');
        const result = db.prepare('INSERT OR IGNORE INTO admin_credentials(id,password_hash,created_at) VALUES(1,?,?)').run(passwordHash, new Date().toISOString());
        return result.changes === 1;
      },
      updateRoom(input) {
        ensureOpen(); requirePoint(input);
        const { building, floor, id, revision: expectedRevision } = input;
        const after = {
          number: textField(input.number, { max: 24 }),
          labelRu: textField(input.labelRu, { required: true, max: 120 }),
          labelKk: textField(input.labelKk, { max: 120 }),
        };
        if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw storageError('VALIDATION_ERROR', 'A current dataset revision is required.');
        db.exec('BEGIN IMMEDIATE');
        try {
          const currentRevision = getRevision();
          if (expectedRevision !== currentRevision) throw storageError('REVISION_CONFLICT', 'The map was changed. Reload it before saving.');
          const record = roomQuery.get(building, floor, id);
          if (!record) throw storageError('NOT_FOUND', 'Room was not found.');
          const room = recordRoom(record), before = editableFields(room);
          if (JSON.stringify(before) === JSON.stringify(after)) {
            db.exec('COMMIT'); return { room: { ...room, building, floor }, revision: currentRevision };
          }
          if (after.number && sameFloorNumbers.all(building, floor, id).some(candidate => numberKey(candidate.number) === numberKey(after.number))) throw storageError('DUPLICATE_NUMBER', 'Another room on this floor already has this cabinet number.');
          const changed = { ...room, label: after.labelRu, labelRu: after.labelRu, labelKk: after.labelKk };
          if (after.number) changed.number = after.number; else delete changed.number;
          update.run(after.number || null, JSON.stringify(changed), building, floor, id);
          const nextRevision = createHash('sha256').update(JSON.stringify(getMaps())).digest('hex');
          db.prepare('UPDATE metadata SET value=? WHERE key=?').run(nextRevision, 'dataset_revision');
          insertChange.run(building, floor, id, JSON.stringify(before), JSON.stringify(after), new Date().toISOString());
          db.exec('COMMIT');
          return { room: { ...changed, building, floor }, revision: nextRevision };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      getRoomHistory(point) {
        ensureOpen(); requirePoint(point);
        const { building, floor, id, limit = 20 } = point;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw storageError('VALIDATION_ERROR', 'History limit is invalid.');
        if (!roomQuery.get(building, floor, id)) throw storageError('NOT_FOUND', 'Room was not found.');
        return changeQuery.all(building, floor, id, limit).map(record => ({ id: record.id, before: JSON.parse(record.before_json), after: JSON.parse(record.after_json), createdAt: record.created_at }));
      },
      close() { if (!closed) { db.close(); closed = true; } }
    };
  } catch (error) { db.close(); throw error; }
}
