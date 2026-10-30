const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),path=require('path');
const {parseHTML}=require('linkedom');
const dist=path.resolve(__dirname,'../dist');
let checks=0;function ok(value,message){assert.ok(value,message);checks++;}
function boot(query='?building=five&floor=1',blockedStorage=false){
 const {document}=parseHTML(fs.readFileSync(path.join(dist,'index.html'),'utf8'));
 let active=null;Object.defineProperty(document,'activeElement',{get:()=>active});
 document.querySelectorAll('input,button,a').forEach(el=>el.focus=()=>{active=el;el.onfocus?.()});
 const modal=document.querySelector('#modal');modal.showModal=()=>modal.open=true;modal.close=()=>modal.open=false;
 const events={},location={search:query},history={entries:[query],index:0,replaceState(a,b,url){location.search=url;this.entries[this.index]=url;},pushState(a,b,url){location.search=url;this.entries.splice(++this.index);this.entries.push(url);}};
 const sandbox={document,window:{addEventListener(type,fn){(events[type]??=[]).push(fn)}},location,history,URLSearchParams,localStorage:{getItem(){if(blockedStorage)throw Error('blocked');return null},setItem(){if(blockedStorage)throw Error('blocked')}},setTimeout,clearTimeout,console};
 vm.createContext(sandbox);for(const file of ['data.js','i18n.js','app.js'])vm.runInContext(fs.readFileSync(path.join(dist,file),'utf8'),sandbox);
 const run=code=>vm.runInContext(code,sandbox),$=s=>document.querySelector(s),fire=(type,event={})=>(events[type]??[]).forEach(fn=>fn(event));
 const captured=[];$('#canvas').setPointerCapture=id=>captured.push(id);
 $('#drawing').getBoundingClientRect=()=>({left:100+run('panX'),top:100+run('panY'),width:500*run('zoom'),height:400*run('zoom')});
 const pointer=(type,id,x,y,target=$('#drawing'))=>{const e=new document.defaultView.Event(type,{bubbles:true});Object.assign(e,{pointerId:id,button:0,clientX:x,clientY:y});if(type==='pointerdown')target.dispatchEvent(e);else fire(type,e);};
 return {document,run,$,fire,pointer,captured,location,history};
}
for(const bad of ['toString','constructor','__proto__','unknown']){const app=boot('?building='+bad+'&floor=999');ok(app.run("building==='seven'&&floor===1"),'Invalid URL corpus '+bad);}
{
 const app=boot('?building=five&floor=0&lang=kk&planner=1');
 ok(!app.$('#planner').hidden&&app.location.search.includes('planner=1'),'Planner deep link survives render');
 app.$('#collapsePlanner').click();ok(!app.location.search.includes('planner='),'Collapsed state in URL');
 app.$('#togglePlanner').click();ok(app.location.search.includes('planner=1'),'Expanded state in URL');
 const corpus=app.run("searchRooms('корпус А 01А')");ok(corpus.length&&corpus.every(r=>r.building==='five'&&r.number==='01А'),'Corpus-first Russian query');
 const corpusKK=app.run("searchRooms('корпусы Б баспалдақ')");ok(corpusKK.length&&corpusKK.every(r=>r.building==='seven'),'Corpus-first Kazakh query');
 app.$('[data-lang="ru"]').click();
 ok(!app.$('#planner').hidden&&app.location.search.includes('lang=ru')&&app.location.search.includes('planner=1'),'Language switch preserves open planner and URL');
 app.$('[data-lang="kk"]').click();
 ok(!app.$('#planner').hidden&&app.location.search.includes('lang=kk')&&app.location.search.includes('planner=1'),'Reverse language switch preserves planner and URL');
 app.$('#routeFrom').value='лестница';app.$('#routeFrom').oninput();
 const options=app.$('#fromResults').querySelectorAll('[data-result]');
 app.$('#routeFrom').onkeydown({key:'ArrowUp',preventDefault(){}});
 ok(app.$('#routeFrom').getAttribute('aria-activedescendant')===options[options.length-1].id,'ArrowUp starts at last result');
 app.$('#routeFrom').onkeydown({key:'ArrowDown',preventDefault(){}});
 ok(app.$('#routeFrom').getAttribute('aria-activedescendant')===options[0].id,'ArrowDown wraps from last to first');
 app.run("selected=data().rooms.find(r=>!r.partial&&r.id!==endpoints.from?.id).id;detail()");
 app.$('#chooseFrom').click();
 app.run("selected=data().rooms.find(r=>!r.partial&&r.id!==endpoints.from.id).id;detail()");
 app.$('#chooseTo').click();
 ok(app.run("messageKey===''")&&app.document.activeElement===app.$('#buildRoute'),'Complete map selection focuses build without wrong prompt');
 app.$('#routeForm').onsubmit({preventDefault(){}});
 const route=app.run('JSON.stringify(routeData)');
 app.$('[data-building="five"]').click();
 ok(app.run('JSON.stringify(routeData)')===route,'Active corpus button does not erase route');
 const previous=app.location.search;
 app.$('[data-building="seven"]').click();
 ok(app.history.entries.length>1&&app.run("building==='seven'"),'Corpus navigation creates history entry');
 app.location.search=previous;app.fire('popstate');
 ok(app.run("building==='five'&&floor===0&&language==='kk'&&plannerOpen"),'Back restores corpus, basement, language and planner');
}
{
 const app=boot();
 app.pointer('pointerdown',1,300,300);
 ok(!app.captured.length,'Tap does not capture room click');
 app.pointer('pointermove',1,320,330);
 ok(app.captured.includes(1)&&app.run('panX===20&&panY===30&&suppressClick'),'Drag captures after threshold');
 app.pointer('pointermove',1,350,380);
 ok(app.run('panX===50&&panY===80'),'Window pointer moves continue outside canvas');
 app.fire('blur');ok(app.run('pointers.size===0&&!drag&&!pinch&&!suppressClick'),'Window blur clears stuck gesture');
 app.pointer('pointerdown',2,300,300);app.pointer('pointerdown',3,400,300);
 app.pointer('pointermove',3,500,300);
 ok(app.run('zoom===2&&suppressClick'),'Pinch zoom responds to two pointers');
 const before=app.run('panX');
 app.pointer('pointerup',3,500,300);app.pointer('pointermove',2,320,300);
 ok(app.run('panX')===before+20,'One finger continues panning after pinch');
 app.pointer('pointercancel',2,320,300);
 ok(app.run('pointers.size===0&&!drag&&!pinch'),'Pointer cancellation clears gesture');
 app.fire('blur');
}
{
 const app=boot('?building=seven&floor=1',true);
 app.$('[data-lang="kk"]').click();app.$('#theme').click();app.$('#togglePlanner').click();
 ok(app.run("language==='kk'&&plannerOpen"),'Language, theme and planner callbacks tolerate blocked storage');
 app.$('#routeFrom').value='баспалдақ';app.$('#routeFrom').oninput();
 app.$('#fromResults [data-result]').click();
 app.$('#routeTo').value='211';app.$('#routeTo').oninput();
 app.$('#toResults [data-result]').click();app.$('#routeForm').onsubmit({preventDefault(){}});
 ok(app.run('routeData.ok'),'Route callbacks tolerate blocked storage');
}
console.log(JSON.stringify({status:'PASS',logicAuditChecks:checks},null,2));
