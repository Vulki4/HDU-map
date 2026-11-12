import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MAPS from '../src/data.js';

const SCHEMA_VERSION = '2';
const UDN2_MERGE_REVISION = 'udn2_merged_room_revision';
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

function insertBuilding(db, building, position, { floors, ...buildingData }) {
  db.prepare('INSERT INTO buildings(id,position,data_json) VALUES(?,?,?)').run(building, position, JSON.stringify(buildingData));
  const floorInsert = db.prepare('INSERT INTO floors(building_id,floor_number,position,data_json) VALUES(?,?,?,?)');
  const roomInsert = db.prepare('INSERT INTO rooms(building_id,floor_number,room_id,position,number,data_json) VALUES(?,?,?,?,?,?)');
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
}

function seedDatabase(db, seed, udn2MergeRevision) {
  const revision = createHash('sha256').update(JSON.stringify(seed)).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(schema);
    db.exec(adminSchema);
    const metadata = db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)');
    metadata.run('schema_version', SCHEMA_VERSION);
    metadata.run('dataset_revision', revision);
    metadata.run('seeded_at', new Date().toISOString());
    if (udn2MergeRevision) metadata.run(UDN2_MERGE_REVISION, udn2MergeRevision);
    Object.entries(seed).forEach(([building, map], position) => insertBuilding(db, building, position, map));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function createMapRepository({ filename = path.join(dataDirectory, 'hdu-map.sqlite'), seed = MAPS } = {}) {
  const udn2RoomMerges = Object.entries(seed.udn2?.floors ?? {}).flatMap(([floor, data]) =>
    data.rooms.filter(room => ['corridor', 'wc'].includes(room.type) && room.mergedRoomIds?.length)
      .map(room => ({ floor: Number(floor), room })),
  );
  const udn2MergeRevision = udn2RoomMerges.length
    ? createHash('sha256').update(JSON.stringify(udn2RoomMerges)).digest('hex')
    : null;
  const db = new DatabaseSync(databasePath(filename));
  let closed = false;
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    if (tables.length === 0) seedDatabase(db, seed, udn2MergeRevision);
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
    function refreshRevision() {
      const nextRevision = createHash('sha256').update(JSON.stringify(getMaps())).digest('hex');
      db.prepare('UPDATE metadata SET value=? WHERE key=?').run(nextRevision, 'dataset_revision');
      return nextRevision;
    }
    if (seed.udn2 && tables.length > 0) {
      const hasUdn2 = db.prepare('SELECT id FROM buildings WHERE id=?');
      const needsRoomSync = () => udn2MergeRevision && revisionQuery.get(UDN2_MERGE_REVISION)?.value !== udn2MergeRevision;
      if (!hasUdn2.get('udn2') || needsRoomSync()) {
        db.exec('BEGIN IMMEDIATE');
        try {
          let changed = false;
          if (!hasUdn2.get('udn2')) {
            const { position } = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS position FROM buildings').get();
            insertBuilding(db, 'udn2', position, seed.udn2);
            changed = true;
          } else if (needsRoomSync()) {
            const moveHistory = db.prepare('UPDATE room_changes SET room_id=? WHERE building_id=? AND floor_number=? AND room_id=?');
            const deleteRoom = db.prepare('DELETE FROM rooms WHERE building_id=? AND floor_number=? AND room_id=?');
            // Match edits to the current label because the history can include retired rooms.
            const labelEdits = db.prepare(`
              SELECT
                MAX(json_extract(before_json, '$.labelRu') IS NOT json_extract(after_json, '$.labelRu')
                  AND json_extract(after_json, '$.labelRu') IS ?) AS ru,
                MAX(json_extract(before_json, '$.labelKk') IS NOT json_extract(after_json, '$.labelKk')
                  AND json_extract(after_json, '$.labelKk') IS ?) AS kk
              FROM room_changes WHERE building_id=? AND floor_number=? AND room_id=?
            `);
            for (const { floor, room } of udn2RoomMerges) {
              const retired = room.mergedRoomIds.flatMap(id => {
                const record = roomQuery.get('udn2', floor, id);
                return record ? [{ id, type: JSON.parse(record.data_json).type }] : [];
              });
              const main = roomQuery.get('udn2', floor, room.id);
              const previous = main && recordRoom(main);
              const edits = () => labelEdits.get(previous.labelRu ?? previous.label, previous.labelKk ?? '', 'udn2', floor, room.id);
              if (!retired.length) {
                if (previous?.type !== room.type || !Array.isArray(previous.polygons)) continue;
                if (room.type === 'corridor' && Array.isArray(room.polygons) && JSON.stringify(previous.polygons) !== JSON.stringify(room.polygons)) {
                  update.run(main.number, JSON.stringify({ ...previous, polygons: room.polygons }), 'udn2', floor, room.id);
                  changed = true;
                } else if (room.type === 'wc' && room.label === 'Туалет' && (previous.labelRu ?? previous.label) === 'Санузел') {
                  const { ru, kk } = edits();
                  const renamed = { ...previous };
                  if (!ru) {
                    renamed.label = room.label;
                    if (previous.labelRu !== undefined || room.labelRu !== undefined) renamed.labelRu = room.labelRu ?? room.label;
                  }
                  if (!kk) renamed.labelKk = room.labelKk;
                  if (JSON.stringify(previous) !== JSON.stringify(renamed)) {
                    update.run(main.number, JSON.stringify(renamed), 'udn2', floor, room.id);
                    changed = true;
                  }
                }
                continue;
              }
              if (previous?.type !== room.type || retired.some(source => !Number.isSafeInteger(source.id) || source.id === room.id || source.type !== previous.type)) {
                throw new Error('UDN 2 room merge did not match the stored plan');
              }
              const merged = { ...room, number: previous.number };
              const { ru, kk } = room.type === 'wc' ? edits() : { ru: true, kk: true };
              if (ru) {
                merged.label = previous.label;
                merged.labelRu = previous.labelRu;
              }
              if (kk) merged.labelKk = previous.labelKk;
              update.run(main.number, JSON.stringify(merged), 'udn2', floor, room.id);
              for (const { id } of retired) {
                moveHistory.run(room.id, 'udn2', floor, id);
                deleteRoom.run('udn2', floor, id);
              }
              changed = true;
            }
          }
          if (udn2MergeRevision) {
            db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
              .run(UDN2_MERGE_REVISION, udn2MergeRevision);
          }
          if (changed) refreshRevision();
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
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
          const nextRevision = refreshRevision();
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
