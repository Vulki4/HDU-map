const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const { parseHTML } = require('linkedom');
const dist = path.resolve(__dirname, '../dist');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(dist, 'style.css'), 'utf8');
const { document } = parseHTML(html);
const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
assert.equal(ids.length, new Set(ids).size, 'IDs must be unique');
for (const el of document.querySelectorAll('[aria-controls],[aria-describedby],label[for]')) {
  for (const attr of ['aria-controls', 'aria-describedby', 'for']) {
    for (const id of (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) assert.ok(document.getElementById(id), `${attr} target missing: ${id}`);
  }
}
for (const selector of ['#roomCard', '#floors']) assert.ok(!document.querySelector(selector).closest('.canvas'), `${selector} must allow native touch scrolling`);
assert.ok(!document.querySelector('#source'), 'Original plan button must stay removed');
for (const el of document.querySelectorAll('script[src],link[href],img[src]')) {
  const url = el.getAttribute('src') || el.getAttribute('href');
  assert.ok(fs.existsSync(path.join(dist, url.split('?')[0])), `Missing local resource: ${url}`);
}
for (const match of css.matchAll(/url\(['"]?([^'"\)]+)['"]?\)/g)) assert.ok(fs.existsSync(path.join(dist, match[1])), `Missing CSS asset: ${match[1]}`);
for (const file of ['data.js', 'i18n.js', 'app.js']) new vm.Script(fs.readFileSync(path.join(dist, file), 'utf8'), { filename: file });
assert.ok(css.includes("font-family: 'Montserrat'") && !css.includes("font-family: 'Inter'"), 'Montserrat must be the applied family');
assert.ok(html.includes('fonts/Montserrat-Variable.ttf'), 'Montserrat must be preloaded');
assert.ok(fs.readFileSync(path.join(dist, 'assets/fonts/Montserrat-OFL.txt'), 'utf8').includes('SIL OPEN FONT LICENSE'));

// Validate real glyph IDs, including extended Cyrillic, rather than relying on the family name.
const font = fs.readFileSync(path.join(dist, 'assets/fonts/Montserrat-Variable.ttf'));
const u16 = offset => font.readUInt16BE(offset), u32 = offset => font.readUInt32BE(offset);
let cmap;
for (let i = 0; i < u16(4); i++) {
  const entry = 12 + i * 16;
  if (font.toString('ascii', entry, entry + 4) === 'cmap') cmap = u32(entry + 8);
}
assert.notEqual(cmap, undefined, 'Font must contain cmap');
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
for (const ch of uppercase + uppercase.toLowerCase() + '0123456789') assert.ok(covered.has(ch.codePointAt(0)), `Missing Montserrat glyph: ${ch}`);
console.log(JSON.stringify({ status: 'PASS', assets: 'local files and accessibility references', font: 'Montserrat', russianKazakhGlyphs: 'complete' }, null, 2));
