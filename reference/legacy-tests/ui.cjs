const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const { parseHTML } = require('linkedom');
const path = require('path');
const dist = path.resolve(__dirname, '../dist');
const stored = new Map();
function boot(query = '?building=five&floor=0', storage = stored) {
  const { document } = parseHTML(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'));
  let active = null;
  Object.defineProperty(document, 'activeElement', { get: () => active });
  document.querySelectorAll('input,button,a').forEach(el => el.focus = () => { active = el; if (el.onfocus) el.onfocus(); });
  const modal = document.querySelector('#modal');
  modal.showModal = () => modal.open = true;
  modal.close = () => modal.open = false;
  const context = {
    document, window: { addEventListener() {} }, URLSearchParams, console, setTimeout,
    location: { search: query }, history: { replaceState(a,b,url) { this.url = url; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key,value) => storage.set(key,value) }
  };
  vm.createContext(context);
  for (const file of ['data.js', 'i18n.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(dist,file),'utf8'), context, { filename: file });
  const run = code => vm.runInContext(code, context);
  return { document, run, context };
}
const { document: doc, run, context } = boot();
const $ = s => doc.querySelector(s);
let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions++; }
check($('#mapFloor').textContent === 'Подвал', 'Basement initial floor');
check($('#planner').hidden, 'Planner initially collapsed');
$('#togglePlanner').click();
check(!$('#planner').hidden, 'Planner opens');
check(run('Object.keys(I18N.ru).every(k => typeof I18N.kk[k] === "string")'), 'All translations exist');
check(run('catalog.every(r => ROOM_KK[r.label])'), 'Every room label translated');
check(run("searchRooms('кітапхана').some(r=>r.label==='Библиотека')"), 'Kazakh search in Russian UI');
check(run("searchRooms('библиотека').some(r=>r.label==='Библиотека')"), 'Russian search');
check(run("searchRooms('А корпус 01А').every(r=>r.building==='five'&&r.number==='01А')"), 'Corpus and leading-zero suffix');
check(run("searchRooms('жертөле 06Б').some(r=>r.floor===0&&r.number==='06Б')"), 'Kazakh basement and suffix');
check(run("searchRooms('2-қабат').every(r=>r.floor===2)"), 'Kazakh floor filter');
check(run("searchRooms('лестница',true).every(r=>r.type==='stair'&&!r.partial)"), 'Route points filter');
// Enter and arrow-key selection on actual generated list items.
$('#routeFrom').value = '01А'; $('#routeFrom').oninput();
check(!$('#fromResults').hidden && $('#fromResults').querySelectorAll('[data-result]').length, 'Start suggestions');
$('#routeFrom').onkeydown({ key: 'ArrowDown', preventDefault() {} });
check($('#routeFrom').hasAttribute('aria-activedescendant'), 'Keyboard highlight');
$('#routeFrom').onkeydown({ key: 'Enter', preventDefault() {} });
check(run("endpoints.from.number==='01А'"), 'Keyboard selects actual start');
$('#routeTo').value = 'А корпус библиотека'; $('#routeTo').oninput();
$('#toResults [data-result]').click();
check(run("endpoints.to.label==='Библиотека' && endpoints.to.building==='five'"), 'Destination selected');
$('#routeForm').onsubmit({ preventDefault() {} });
check(run('routeData.ok && routeData.fromFloor===0 && routeData.targetFloor===endpoints.to.floor'), 'Route built from chosen points');
check($('#drawing').innerHTML.includes('<polyline'), 'Route visible on starting floor');
check($('#routeSummary').textContent.includes('Маршрут построен'), 'Russian route summary');
const routeBefore = run('JSON.stringify(routeData.segments)');
const numbersBefore = run('JSON.stringify(catalog.map(r=>r.number))');
// Language updates all persistent UI without resetting map or route.
$('[data-lang="kk"]').click();
check(doc.documentElement.lang === 'kk', 'Document language');
check($('#routeSummary').textContent.includes('Бағыт құрылды'), 'Kazakh instructions');
check($('#mapFloor').textContent === 'Жертөле', 'Basement translated');
check($('#routeFrom').value.includes('01А') && $('#fromMeta').textContent.includes('А корпусы'), 'Chosen endpoint translated');
check(run('JSON.stringify(routeData.segments)') === routeBefore, 'Language keeps route geometry');
check(run('JSON.stringify(catalog.map(r=>r.number))') === numbersBefore, 'Room numbers unchanged');
check(stored.get('hdu-language') === 'kk', 'Language persisted');
check(boot().document.documentElement.lang === 'kk', 'Stored language restored');
check(boot('?building=seven&floor=7&lang=ru').document.documentElement.lang === 'ru', 'URL language override');
// Route floor navigation and reversed route order.
const floorButton = $('#routeSummary [data-route-floor]');
floorButton.click();
check(run('routeData.ok'), 'Floor navigation keeps route');
const oldTo = run('keyOf(endpoints.to)');
$('#swapRoute').click();
check(run('keyOf(endpoints.from)') === oldTo && run('routeData.ok'), 'Swap recalculates route');
const floorKeys = [...doc.querySelectorAll('[data-route-floor]')].map(el=>+el.dataset.routeFloor);
check(floorKeys.every((n,i)=>i===0||n<=floorKeys[i-1]), 'Descending route floors in travel order');
// Editing invalidates the previous selected point and route.
$('#routeFrom').value='другое'; $('#routeFrom').oninput();
check(run('endpoints.from===null && routeData===null'), 'Edited text invalidates route');
$('#routeForm').onsubmit({ preventDefault() {} });
check($('#routeMessage').textContent.includes('Екі нүктені'), 'Validation translated');
// Cross-building routes and equal endpoints are handled explicitly.
run("setEndpoint('from',catalog.find(r=>r.building==='five'&&!r.partial));setEndpoint('to',catalog.find(r=>r.building==='seven'&&!r.partial));buildRoute()");
check(run("messageKey==='crossBuilding' && routeData===null"), 'No invented inter-building route');
run("setEndpoint('to',endpoints.from);buildRoute()");
check(run("messageKey==='samePoint' && routeData===null"), 'Same-place validation');
// Set both points from the map card, without a default start.
run("selectBuilding('seven');selected=data().rooms.find(r=>!r.partial).id;detail()");
$('#chooseFrom').click();
check(run("endpoints.from.building==='seven'") && !$('#planner').hidden, 'Map card sets start');
run("selected=data().rooms.find(r=>!r.partial && r.id!==endpoints.from.id).id;detail()");
$('#chooseTo').click();
check(run("endpoints.to.building==='seven'"), 'Map card sets destination');
$('#routeForm').onsubmit({ preventDefault() {} });
check(run('routeData.ok'), 'Map-selected route');
$('#clearRoute').click();
check(run('!endpoints.from&&!endpoints.to&&!routeData') && !$('#routeFrom').value && !$('#routeTo').value, 'Clear resets route');
$('#collapsePlanner').click();
check($('#planner').hidden && $('#togglePlanner').getAttribute('aria-expanded')==='false', 'Collapse and focus state');
// Full graph and both locales across all 13 floors.
const routes = run(`(()=>{let count=0;for(const [b,m] of Object.entries(MAPS)){building=b;for(const [f,d] of Object.entries(m.floors)){floor=+f;for(const lang of ['ru','kk']){setLanguage(lang);if(!svg(d).includes('<svg'))throw Error('Map render');}const target=d.rooms.find(r=>r.type!=='stair'&&!r.partial);for(const [sf,sd] of Object.entries(m.floors))for(const start of sd.rooms.filter(r=>r.type==='stair')){const result=findRoute(+sf,start.id,+f,target.id);if(!result.ok||!result.segments[f])throw Error('Disconnected '+b+sf+'->'+f);count++;}}}return count;})()`);
check(routes === 121, 'Existing 121 route connectivity checks');
// Storage restrictions do not prevent initial rendering.
const blocked = { get() { throw Error('storage disabled'); }, set() { throw Error('storage disabled'); } };
check(boot('?building=seven&floor=7', blocked).document.querySelector('#drawing svg'), 'No-storage rendering');
console.log(JSON.stringify({ assertions, routeChecks: routes, floors: 13, locales: ['ru','kk'], status: 'PASS' },null,2));
