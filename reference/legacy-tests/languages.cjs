const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert/strict');
const dist = path.resolve(__dirname, '../dist');
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(dist, 'i18n.js'), 'utf8') + '\n' + fs.readFileSync(path.join(dist, 'data.js'), 'utf8') + '\nthis.audit={ I18N, ROOM_KK, MAPS };', context);
const { I18N, ROOM_KK, MAPS } = context.audit;
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
const keys = Object.keys(I18N.ru).sort();
assert.deepEqual(keys, Object.keys(I18N.kk).sort(), 'Both locales must have exactly the same keys');
for (const key of keys) {
  assert.ok(I18N.ru[key].trim() && I18N.kk[key].trim(), `Empty translation: ${key}`);
  assert.deepEqual(placeholders(I18N.ru[key]), placeholders(I18N.kk[key]), `Mismatched placeholders: ${key}`);
  for (const locale of ['ru', 'kk']) assert.ok(!I18N[locale][key].includes('\uFFFD'), `Broken encoding: ${locale}/${key}`);
}
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(dist, 'app.js'), 'utf8');
const used = new Set([
  ...[...html.matchAll(/\bdata-i18n(?:-(?:aria|title|placeholder|alt))?="([^"]+)"/g)].map(match=>match[1]),
  ...[...app.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)].map(match=>match[1])
]);
for (const key of used) assert.ok(keys.includes(key), `Referenced translation missing: ${key}`);
const labels = new Set(Object.values(MAPS).flatMap(map=>Object.values(map.floors).flatMap(floor=>floor.rooms.map(room=>room.label))));
for (const label of labels) assert.ok(ROOM_KK[label]?.trim(), `Room translation missing: ${label}`);
// The number placeholder must preserve leading zeros and Cyrillic suffixes in both locales.
for (const number of ['01А','06Б','211','117А']) {
  for (const locale of ['ru','kk']) {
    const rendered = I18N[locale].room.replace('{n}', number);
    assert.ok(rendered.includes(number), `Room number altered: ${locale}/${number}`);
  }
}
for (const locale of ['ru','kk']) {
  assert.ok(!('source' in I18N[locale]) && !('originalText' in I18N[locale]), 'Original plan controls must stay removed');
}
console.log(JSON.stringify({status:'PASS',locales:2,translationKeys:keys.length,referencedKeys:used.size,roomLabels:labels.size,placeholderParity:true,roomNumberIntegrity:true},null,2));
