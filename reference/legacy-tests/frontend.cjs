const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { parseHTML } = require('linkedom');
const dist = path.resolve(__dirname, '../dist');
const source = file => fs.readFileSync(path.join(dist, file), 'utf8');
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function boot(locale) {
  const { document } = parseHTML(source('index.html'));
  let focused = null;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  document.querySelectorAll('input,button,a').forEach(el => el.focus = () => { focused = el; el.onfocus?.(); });
  const modal = document.querySelector('#modal');
  modal.showModal = () => { modal.open = true; };
  modal.close = () => { modal.open = false; };
  const location = { search: `?building=five&floor=0&lang=${locale}` };
  const windowEvents = {};
  const context = {
    document, URLSearchParams, location, console, setTimeout, clearTimeout,
    history: { replaceState(a,b,url) { location.search = url; }, pushState(a,b,url) { location.search = url; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    window: { addEventListener(type, fn) { (windowEvents[type] ??= []).push(fn); } }
  };
  vm.createContext(context);
  for (const file of ['data.js','i18n.js','app.js']) vm.runInContext(source(file), context, { filename: file });
  return { document, run: code => vm.runInContext(code, context) };
}
function accessibleName(el, document) {
  const direct = el.getAttribute('aria-label');
  if (direct) return direct.trim();
  const references = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  if (references.length) return references.map(id=>document.getElementById(id)?.textContent || '').join(' ').trim();
  if (el.id) {
    const label = [...document.querySelectorAll('label[for]')].find(label=>label.htmlFor===el.id || label.getAttribute('for')===el.id);
    if (label) return label.textContent.trim();
  }
  return /^(BUTTON|A)$/.test(el.tagName) || el.getAttribute('role')==='button' ? el.textContent.trim() : '';
}
function auditDOM(document, label) {
  const ids = [...document.querySelectorAll('[id]')].map(el=>el.id);
  check(ids.length === new Set(ids).size, `${label}: duplicate IDs`);
  for (const el of document.querySelectorAll('[aria-controls],[aria-describedby],[aria-labelledby],label[for]')) {
    for (const attr of ['aria-controls','aria-describedby','aria-labelledby','for']) {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) check(document.getElementById(id), `${label}: ${attr} target ${id} missing`);
    }
  }
  for (const el of document.querySelectorAll('button,[role="button"],a,input,select,textarea')) check(accessibleName(el, document), `${label}: unnamed control ${el.id || el.tagName}`);
  for (const input of document.querySelectorAll('[role="combobox"]')) {
    check(input.getAttribute('aria-expanded')==='true' || input.getAttribute('aria-expanded')==='false', `${label}: combobox expansion state`);
    const list = document.getElementById(input.getAttribute('aria-controls'));
    check(list?.getAttribute('role')==='listbox', `${label}: combobox controls a listbox`);
  }
  check(!document.querySelector('#source'), `${label}: source plan control returned`);
  check(!document.querySelector('img[src$=".webp"]'), `${label}: original scan shown`);
  check(!/м²|м\^2|кв\.\s*м/.test(document.body.textContent), `${label}: floor area shown`);
  check(!/\{(?:n|floor|number)\}/.test(document.body.textContent), `${label}: unresolved template token`);
}
let renderedFloors = 0, renderedRooms = 0;
for (const locale of ['ru','kk']) {
  const { document, run } = boot(locale);
  check(document.documentElement.lang === locale, 'Document language reflects interface');
  check(document.querySelector('meta[name="viewport"]'), 'Viewport metadata present');
  check(document.querySelectorAll('[data-building]').length === 2, 'Exactly two corpus controls');
  check(run("Object.keys(MAPS).length===2 && Object.keys(MAPS.five.floors).join(',')==='0,1,2,3,4,5' && Object.keys(MAPS.seven.floors).join(',')==='1,2,3,4,5,6,7'"), 'Two corpora and correct 13 floors');
  auditDOM(document, `${locale}/initial`);
  for (const building of ['five','seven']) {
    const floors = JSON.parse(run(`JSON.stringify(Object.keys(MAPS.${building}.floors))`));
    for (const floor of floors) {
      run(`building=${JSON.stringify(building)};floor=${Number(floor)};selected=null;render();`);
      check(document.querySelector('#drawing svg'), `${locale}/${building}/${floor}: SVG map exists`);
      const roomIds = JSON.parse(run('JSON.stringify(data().rooms.map(room=>room.id))'));
      check(document.querySelectorAll('#drawing [data-room]').length === roomIds.length, `${locale}/${building}/${floor}: every room rendered`);
      auditDOM(document, `${locale}/${building}/${floor}`);
      for (const id of roomIds) {
        run(`selected=${id};detail();`);
        check(!document.querySelector('#roomCard').hidden, `${locale}/${building}/${floor}/${id}: room card appears`);
        check(accessibleName(document.querySelector('#closeDetail'), document), 'Close room card has accessible name');
        check(document.querySelector('#detail h3')?.textContent.trim(), 'Room card has a room name');
        renderedRooms++;
      }
      // Sentinel area must never become student-visible, even in a selected room card.
      check(run(`(()=>{const item=data().rooms[0],area=item.area;item.area=987654.321;selected=item.id;const svgText=svg(data());detail();item.area=area;return !svgText.includes('987654.321')&&!$('#detail').textContent.includes('987654.321');})()`), 'Area data remains hidden');
      renderedFloors++;
    }
  }
  run("selected=null;detail();setPlanner(true)");
  document.querySelector('#routeFrom').value = locale==='kk' ? 'баспалдақ' : 'лестница';
  document.querySelector('#routeFrom').oninput();
  check(document.querySelectorAll('#fromResults [role="option"]').length>0, 'Route suggestions available in both languages');
  auditDOM(document, `${locale}/suggestions`);
  run('pickers.forEach(picker=>picker.hide());showModal()');
  check(document.querySelector('#modal').open, 'About dialog can open');
  auditDOM(document, `${locale}/about`);
}
console.log(JSON.stringify({status:'PASS',checks,renderedFloors,renderedRooms,locales:2,coverage:'DOM accessibility, labels, IDs, ARIA references, student-view constraints',limits:'No browser layout or real-device verification'},null,2));
