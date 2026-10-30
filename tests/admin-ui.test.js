import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { parseHTML } from 'linkedom';
import { createServer } from 'vite';

const project=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const revision='a'.repeat(64),updatedRevision='b'.repeat(64),csrf='test-csrf-token-'.repeat(3);
const initialRooms=[
  {building:'five',floor:1,id:1,number:'01А',label:'Кабинет',labelRu:'Кабинет',labelKk:'Кабинет',type:'room',x:0,y:0,w:100,h:80,cx:50,cy:40},
  {building:'five',floor:1,id:2,label:'Холл',labelRu:'Холл',labelKk:'Холл',type:'corridor',x:100,y:0,w:100,h:80,cx:150,cy:40}
];

test('admin React UI supports protected editing and preserves user drafts',async t=>{
  const vite=await createServer({root:project,server:{middlewareMode:true,hmr:false,ws:false},appType:'custom',logLevel:'error'});
  try{
    const {default:AdminApp}=await vite.ssrLoadModule('/src/admin/AdminApp.jsx');
    async function mount({authenticated=true,configured=true,conflict=false,expirePatch=false,lang='ru'}={}){
      const {window,document}=parseHTML('<html><head><meta name="theme-color" content="#fff"></head><body class="light"><div id="root"></div></body></html>');
      document.oninput=null;
      const location={search:`?building=five&floor=1&lang=${lang}`,pathname:'/admin'};
      window.history={replaceState(a,b,url){location.search=url.slice(url.indexOf('?'));}};
      const stored=new Map(),requests=[],roomStore=structuredClone(initialRooms),changes=[];
      let currentRevision=revision,confirmResult=true,expiryUsed=false;
      window.confirm=()=>confirmResult;
      const session=()=>({configured,authenticated,canSetup:!configured,...(authenticated?{csrfToken:csrf}:{})});
      const answer=(data,status=200)=>new Response(JSON.stringify(status===200?{data,revision:currentRevision}:{error:{code:data,message:'diagnostic text never shown'}}),{status,headers:{'Content-Type':'application/json'}});
      const fetch=async(input,options={})=>{
        const url=new URL(input,'http://127.0.0.1:8765');requests.push({url,options});
        if(url.pathname.endsWith('/session'))return answer(session());
        if(url.pathname.endsWith('/setup')||url.pathname.endsWith('/login')){configured=true;authenticated=true;return answer(session());}
        if(url.pathname.endsWith('/logout')){assert.equal(options.headers['X-CSRF-Token'],csrf);authenticated=false;return answer(session());}
        if(url.pathname.endsWith('/rooms'))return answer(roomStore.filter(room=>room.building===url.searchParams.get('building')&&room.floor===Number(url.searchParams.get('floor'))));
        if(url.pathname.includes('/history/'))return answer(changes);
        if(options.method==='PATCH'){
          assert.equal(options.headers['X-CSRF-Token'],csrf);
          const body=JSON.parse(options.body);assert.equal(body.revision,revision);
          if(expirePatch&&!expiryUsed){expiryUsed=true;authenticated=false;return answer('UNAUTHORIZED',401);}
          if(conflict)return answer('REVISION_CONFLICT',409);
          const room=roomStore.find(room=>room.id===Number(url.pathname.split('/').at(-1)));
          const before={number:room.number??'',labelRu:room.labelRu,labelKk:room.labelKk};
          Object.assign(room,{number:body.number,label:body.labelRu,labelRu:body.labelRu,labelKk:body.labelKk});
          changes.unshift({id:1,before,after:{number:body.number,labelRu:body.labelRu,labelKk:body.labelKk},createdAt:'2026-10-21T08:00:00Z'});
          currentRevision=updatedRevision;return answer(room);
        }
        return answer('NOT_FOUND',404);
      };
      const saved=new Map();
      for(const [key,value] of Object.entries({window,document,location,fetch,Event:window.Event,CustomEvent:window.CustomEvent,HTMLElement:window.HTMLElement,Node:window.Node,IS_REACT_ACT_ENVIRONMENT:true,localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value))}})){
        saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
      }
      const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root'));
      const $=selector=>document.querySelector(selector);
      const fire=(target,type)=>{assert.ok(target,`Missing target ${type}`);target.dispatchEvent(new window.Event(type,{bubbles:true,cancelable:true}));};
      const update=action=>act(async()=>{await action?.();});
      const click=selector=>update(()=>fire(typeof selector==='string'?$(selector):selector,'click'));
      const type=(selector,value)=>update(()=>{const input=$(selector);assert.ok(input,selector);input.setAttribute('value',value);fire(input,'input');});
      const submit=selector=>update(()=>fire($(selector),'submit'));
      const waitFor=async(predicate)=>{for(let i=0;i<100;i++){if(predicate())return;await update(()=>new Promise(resolve=>setTimeout(resolve,10)));}assert.fail(`Timeout: ${document.body.textContent.slice(0,500)}`);};
      await update(()=>root.render(React.createElement(AdminApp)));
      await waitFor(()=>authenticated?!!$('[data-admin-room="1"]'):!!$('#adminAuthForm'));
      return {window,document,location,$,stored,requests,roomStore,click,type,submit,waitFor,update,setConfirm(value){confirmResult=value;},async close(){await act(async()=>root.unmount());for(const [key,value]of saved){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}}};
    }
    await t.test('first setup uses chosen password, clears it after authentication, and displays all editable labels',async()=>{
      const app=await mount({authenticated:false,configured:false});
      try{
        assert.match(app.document.body.textContent,/Создайте пароль/);
        await app.type('#adminPassword','Valid long secret 123');await app.type('#adminPasswordConfirm','different secret');await app.submit('#adminAuthForm');
        assert.match(app.document.body.textContent,/Пароли не совпадают/);
        assert.equal(app.requests.filter(item=>item.url.pathname.endsWith('/setup')).length,0);
        await app.type('#adminPasswordConfirm','Valid long secret 123');await app.submit('#adminAuthForm');
        await app.waitFor(()=>app.$('[data-admin-room="1"]'));
        assert.equal(app.$('#adminPassword'),null);
        assert.deepEqual([...app.stored.keys()],['hdu-language']);
        await app.click('[data-admin-room="1"]');
        assert.equal(app.$('#adminRoomNumber').value,'01А');
        assert.equal(app.$('#adminLabelRu').value,'Кабинет');
        assert.equal(app.$('#adminLabelKk').value,'Кабинет');
      }finally{await app.close();}
    });
    await t.test('saves a leading-zero number and bilingual names through canonical PATCH and refreshes history',async()=>{
      const app=await mount();
      try{
        let notified=0;app.window.addEventListener('hdu-map-updated',()=>notified++);
        await app.type('#adminRoomSearch','01A');assert.ok(app.$('[data-admin-room="1"]'));assert.equal(app.$('[data-admin-room="2"]'),null);
        await app.click('[data-admin-room="1"]');
        await app.type('#adminRoomNumber','06Б');await app.type('#adminLabelRu','Кабинет информатики');await app.type('#adminLabelKk','Информатика кабинеті');
        await app.submit('#adminEditForm');await app.waitFor(()=>app.$('#adminSuccess'));
        const patch=app.requests.find(item=>item.options.method==='PATCH');assert.ok(patch);
        assert.deepEqual(JSON.parse(patch.options.body),{number:'06Б',labelRu:'Кабинет информатики',labelKk:'Информатика кабинеті',revision});
        assert.equal(app.stored.get('hdu-map-revision'),updatedRevision);assert.equal(notified,1);
        assert.equal(app.$('#adminSave').disabled,true);
        await app.waitFor(()=>app.$('.admin-history time'));
        assert.match(app.$('.admin-history').textContent,/06Б/);
        assert.match(app.$('.admin-history').textContent,/Информатика кабинеті/);
      }finally{await app.close();}
    });
    await t.test('conflicting changes preserve the draft and unsaved guards protect room changes and logout',async()=>{
      const app=await mount({conflict:true});
      try{
        await app.click('[data-admin-room="1"]');await app.type('#adminLabelRu','Мой черновик');await app.submit('#adminEditForm');
        await app.waitFor(()=>app.$('#adminReloadConflict'));
        assert.equal(app.$('#adminLabelRu').value,'Мой черновик');assert.equal(app.$('#adminSave').disabled,false);
        app.setConfirm(false);await app.click('[data-admin-room="2"]');assert.equal(app.$('#adminLabelRu').value,'Мой черновик');
        await app.click('#adminLogout');assert.equal(app.$('#adminAuthForm'),null);
        app.setConfirm(true);await app.click('#adminLogout');await app.waitFor(()=>app.$('#adminAuthForm'));
        assert.equal(app.$('#adminEditForm'),null);assert.equal(app.document.querySelectorAll('[data-admin-room]').length,0);
      }finally{await app.close();}
    });
    await t.test('session expiry preserves unsaved form in memory for reauthentication, and Kazakh UI remains usable',async()=>{
      const app=await mount({expirePatch:true,lang:'kk'});
      try{
        assert.equal(app.document.documentElement.lang,'kk');assert.match(app.document.body.textContent,/Кабинеттер мен атаулар/);
        await app.click('[data-admin-room="1"]');await app.type('#adminLabelRu','Несохранённое название');await app.submit('#adminEditForm');
        await app.waitFor(()=>app.$('#adminAuthForm'));
        assert.equal(app.$('#adminEditForm'),null);
        assert.equal([...app.stored.values()].includes('Несохранённое название'),false);
        const unload=new app.window.Event('beforeunload',{cancelable:true});
        app.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true,'suspended draft still protects browser unload');
        app.setConfirm(false);
        const back=new app.window.Event('click',{cancelable:true,bubbles:true});app.$('.admin-map-link').dispatchEvent(back);
        assert.equal(back.defaultPrevented,true,'suspended draft protects returning to the map');
        app.setConfirm(true);
        await app.type('#adminPassword','Valid long secret 123');await app.submit('#adminAuthForm');
        await app.waitFor(()=>app.$('#adminLabelRu'));
        assert.equal(app.$('#adminLabelRu').value,'Несохранённое название');assert.equal(app.$('#adminSave').disabled,false);
      }finally{await app.close();}
    });
  }finally{await vite.close();}
});
