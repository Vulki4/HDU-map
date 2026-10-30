import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import maps from '../src/data.js';
import { I18N, ROOM_KK, makeTranslator } from '../src/i18n.js';
import { buildCatalog, keyOf, searchRooms } from '../src/map-core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
const catalog = buildCatalog(maps);

test('Russian and Kazakh dictionaries have complete matching keys and placeholders', () => {
  const keys = Object.keys(I18N.ru).sort();
  assert.ok(keys.length >= 75);
  assert.deepEqual(Object.keys(I18N.kk).sort(), keys);
  for (const key of keys) {
    for (const language of ['ru', 'kk']) {
      assert.equal(typeof I18N[language][key], 'string', `${language}/${key}`);
      assert.ok(I18N[language][key].trim(), `${language}/${key} is blank`);
      assert.ok(!I18N[language][key].includes('\uFFFD'), `${language}/${key} has broken encoding`);
    }
    assert.deepEqual(placeholders(I18N.ru[key]), placeholders(I18N.kk[key]), key);
  }
});

test('translator preserves leading zeroes, suffixes and numeric zero without mutating locale data', () => {
  const snapshot = JSON.stringify(I18N);
  for (const number of ['01А', '06Б', '117А', '211', '01A']) {
    assert.equal(makeTranslator('ru')('room', { n: number }), `Кабинет ${number}`);
    assert.equal(makeTranslator('kk')('room', { n: number }), `${number}-кабинет`);
  }
  assert.equal(makeTranslator('kk')('floor', { n: 0 }), '0-қабат');
  assert.equal(makeTranslator('bad')('from'), I18N.ru.from);
  assert.equal(makeTranslator('__proto__')('constructor'), 'constructor');
  assert.equal(makeTranslator('kk')('unknown-key'), 'unknown-key');
  assert.equal(makeTranslator('ru')('room', null), 'Кабинет ');
  assert.equal(JSON.stringify(I18N), snapshot);
});

test('all actual room types have Kazakh labels and search accepts either language', () => {
  const labels = new Set(catalog.map(room => room.label));
  for (const label of labels) assert.ok(ROOM_KK[label]?.trim(), label);
  const search = query => searchRooms(query, { catalog, building: 'five', floor: 0 }).map(keyOf);
  for (const [russian, kazakh] of [['библиотека', 'кітапхана'], ['лестница', 'баспалдақ'], ['столовая', 'асхана']]) {
    assert.deepEqual(search(russian), search(kazakh), `${russian}/${kazakh}`);
    assert.ok(search(kazakh).length);
  }
  assert.equal(I18N.ru.five, 'А корпус'); assert.equal(I18N.kk.five, 'А корпусы');
  assert.equal(I18N.ru.seven, 'Б корпус'); assert.equal(I18N.kk.seven, 'Б корпусы');
  assert.equal(I18N.ru.basement, 'Подвал'); assert.equal(I18N.kk.basement, 'Жертөле');
});

test('every literal React UI translation reference resolves in both languages', () => {
  function filesIn(folder) {
    return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? filesIn(path.join(folder, entry.name)) : /\.[jt]sx?$/.test(entry.name) ? [path.join(folder, entry.name)] : []);
  }
  const keys = new Set();
  for (const file of filesIn(path.join(root, 'src'))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) keys.add(match[1]);
  }
  assert.ok(keys.size > 0);
  for (const key of keys) for (const language of ['ru', 'kk']) assert.ok(Object.hasOwn(I18N[language], key), `${language}/${key}`);
  for (const language of ['ru', 'kk']) {
    assert.ok(!Object.hasOwn(I18N[language], 'source'));
    assert.ok(!Object.hasOwn(I18N[language], 'originalText'));
  }
});

test('bundled Montserrat contains real glyphs for every Russian and Kazakh letter', () => {
  const font = fs.readFileSync(path.join(root, 'public/assets/fonts/Montserrat-Variable.ttf'));
  const u16 = offset => font.readUInt16BE(offset), u32 = offset => font.readUInt32BE(offset);
  let cmap;
  for (let i = 0; i < u16(4); i++) {
    const entry = 12 + i * 16;
    if (font.toString('ascii', entry, entry + 4) === 'cmap') cmap = u32(entry + 8);
  }
  assert.notEqual(cmap, undefined);
  const covered = new Set();
  for (let i = 0; i < u16(cmap + 2); i++) {
    const off = cmap + u32(cmap + 8 + i * 8), format = u16(off);
    if (format === 12) {
      for (let j = 0; j < u32(off + 12); j++) {
        const group = off + 16 + j * 12, start = u32(group), end = u32(group + 4), first = u32(group + 8);
        for (let cp = start; cp <= end; cp++) if (first + cp - start) covered.add(cp);
      }
    } else if (format === 4) {
      const count = u16(off + 6) / 2, ends = off + 14, starts = ends + count * 2 + 2, deltas = starts + count * 2, offsets = deltas + count * 2;
      for (let j = 0; j < count; j++) {
        const start = u16(starts + j * 2), end = u16(ends + j * 2), delta = u16(deltas + j * 2), range = u16(offsets + j * 2);
        for (let cp = start; cp <= end; cp++) {
          const glyph = range ? u16(offsets + j * 2 + range + (cp - start) * 2) : cp;
          if (glyph && (glyph + delta) % 65536) covered.add(cp);
        }
      }
    }
  }
  const uppercase = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯӘҒҚҢӨҰҮҺІ';
  for (const ch of uppercase + uppercase.toLowerCase() + '0123456789') assert.ok(covered.has(ch.codePointAt(0)), `Missing glyph: ${ch}`);
  assert.match(fs.readFileSync(path.join(root, 'public/assets/fonts/Montserrat-OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE/);
});
