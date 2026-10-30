import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { parseHTML } from 'linkedom';
import { createServer } from 'vite';
import { createAppServer } from '../server.mjs';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('React application supports student search and route workflows', async t => {
  const nativeFetch = globalThis.fetch;
  const httpServer = await createAppServer({ databasePath: ':memory:' });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const server = await createServer({root:project,server:{middlewareMode:true,hmr:false,ws:false},appType:'custom',logLevel:'error'});
  try {
    const {default: App} = await server.ssrLoadModule('/src/App.jsx');
    async function mount(query='?building=five&floor=1&lang=ru', { ready = true, intercept, holdBootstrap = false } = {}) {
      const {window,document} = parseHTML('<!doctype html><html><head><meta name="theme-color" content="#fff"></head><body><div id="root"></div></body></html>');
      const location = {search:query};
      const history = {entries:[query],replaceState(a,b,url){location.search=url;this.entries[this.entries.length-1]=url;},pushState(a,b,url){location.search=url;this.entries.push(url);}};
      const stored = new Map();
      const raf = new Map(); let rafId=0, focused=null;
      const saved = new Map();
      const prototypeDescriptors = [
        [window.Element.prototype,'getBoundingClientRect'],[window.Element.prototype,'scrollIntoView'],
        [window.HTMLElement.prototype,'focus'],[window.HTMLElement.prototype,'showModal'],[window.HTMLElement.prototype,'close'],
        ...(window.SVGElement ? [[window.SVGElement.prototype,'focus']] : []),
      ].map(([prototype,key])=>({prototype,key,descriptor:Object.getOwnPropertyDescriptor(prototype,key)}));
      const requests = []; let maps, releaseBootstrap;
      const bootstrapGate = holdBootstrap ? new Promise(resolve => { releaseBootstrap = resolve; }) : Promise.resolve();
      Object.defineProperty(document,'activeElement',{get:()=>focused});
      document.oninput=null;
      window.matchMedia=()=>({matches:true,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      const rect=()=>({left:100,top:100,width:600,height:450,right:700,bottom:550,x:100,y:100});
      window.Element.prototype.getBoundingClientRect=rect;
      window.Element.prototype.scrollIntoView=function(){};
      const focus=function(){
        const previous=focused;focused=this;
        if(previous&&previous!==this){const out=new window.Event('focusout',{bubbles:true});Object.assign(out,{relatedTarget:this});previous.dispatchEvent(out);}
        const inside=new window.Event('focusin',{bubbles:true});Object.assign(inside,{relatedTarget:previous});this.dispatchEvent(inside);
      };
      window.HTMLElement.prototype.focus=focus;
      if(window.SVGElement)window.SVGElement.prototype.focus=focus;
      window.HTMLElement.prototype.showModal=function(){this.open=true;};
      window.HTMLElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
      const fetch = async (input, options = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, base);
        requests.push({ url, options });
        const forward = async () => {
          if (url.pathname === '/api/v1/maps') await bootstrapGate;
          const response = await nativeFetch(url, options);
          if (url.pathname === '/api/v1/maps' && response.ok) maps = (await response.clone().json()).data;
          return response;
        };
        return intercept ? intercept(url, options, forward) : forward();
      };
      const globals={window,document,location,history,fetch,HTMLElement:window.HTMLElement,SVGElement:window.SVGElement,Element:window.Element,Node:window.Node,Event:window.Event,IS_REACT_ACT_ENVIRONMENT:true,localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,String(value))},requestAnimationFrame:callback=>{raf.set(++rafId,callback);return rafId;},cancelAnimationFrame:id=>raf.delete(id)};
      for(const [key,value]of Object.entries(globals)){
        saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
        Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
      }
      const {createRoot}=await import('react-dom/client');
      const root=createRoot(document.getElementById('root'));
      const $=selector=>document.querySelector(selector);
      const fire=(target,type,extra={})=>{assert.ok(target,`Missing event target for ${type}`);const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,extra);target.dispatchEvent(event);};
      const update=async action=>{
        await act(async()=>action?.());
        while(raf.size){const tasks=[...raf.values()];raf.clear();await act(async()=>tasks.forEach(callback=>callback(performance.now())));}
      };
      const type=async(selector,value)=>update(()=>{const input=$(selector);assert.ok(input,selector);input.setAttribute('value',value);fire(input,'input');});
      const click=async selector=>update(()=>fire(typeof selector==='string'?$(selector):selector,'click'));
      const waitFor = async (predicate, description = 'asynchronous React update', timeout = 2000) => {
        const started = performance.now();
        while (performance.now() - started < timeout) {
          const value = predicate(); if (value) return value;
          await update(() => new Promise(resolve => setTimeout(resolve, 20)));
        }
        assert.fail(`Timed out waiting for ${description}. UI: ${document.body.textContent.slice(0,400)}`);
      };
      const corpusButton=building=>[...document.querySelectorAll('#buildings .corpus-button')][building==='five'?0:1];
      let closed=false;
      const close=async()=>{
        if(closed)return;closed=true;
        await act(async()=>root.unmount());raf.clear();
        for(const {prototype,key,descriptor}of prototypeDescriptors.reverse()){
          if(descriptor)Object.defineProperty(prototype,key,descriptor);else delete prototype[key];
        }
        for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
      };
      try{
        await update(()=>root.render(React.createElement(App)));
        const loadingSeen = !!$('.bootstrap-state[data-state="loading"]');
        releaseBootstrap?.();
        if (ready) await waitFor(() => $('#drawing svg'), 'map bootstrap from HTTP API');
        return {window,document,location,stored,requests,get maps(){return maps;},loadingSeen,$,fire,update,type,click,waitFor,corpusButton,close};
      }catch(error){releaseBootstrap?.();await close();throw error;}
    }
    async function withApp(query,scenario){const app=await mount(query);try{await scenario(app);}finally{await app.close();}}

    await t.test('Russian A-corpus first floor renders usable controls from HTTP without original scans or areas',async()=>{
      const app = await mount(undefined,{holdBootstrap:true});
      try {
      assert.equal(app.loadingSeen,true);
      assert.ok(app.requests.some(request=>request.url.pathname==='/api/v1/maps'));
      assert.equal(app.document.documentElement.lang,'ru');
      assert.equal(app.$('.map-heading h1').textContent,'1 этаж');
      assert.equal(app.corpusButton('five').getAttribute('aria-pressed'),'true');
      assert.equal(app.document.querySelectorAll('#floors button').length,6);
      assert.ok(app.$('#floors button[aria-label="Подвал"]'));
      assert.ok(app.$('#canvas #drawing svg'));
      assert.equal(app.$('#planner').hidden,true);
      assert.equal(app.$('#source'),null);
      assert.doesNotMatch(app.document.body.textContent,/м²|кв\.\s*м/);
      } finally { await app.close(); }
    });

    await t.test('searching 305 changes the displayed floor, opens the room card, and Escape closes it',()=>withApp(undefined,async app=>{
      await app.type('#search','305');
      await app.waitFor(()=>[...app.document.querySelectorAll('#search-results [role="option"]')].some(option=>option.textContent.includes('305')), 'debounced API search for 305');
      const result=[...app.document.querySelectorAll('#search-results [role="option"]')].find(option=>option.textContent.includes('305'));
      assert.ok(result);
      await app.click(result);
      assert.match(app.$('#detail h3').textContent,/305/);
      assert.equal(app.$('.map-heading h1').textContent,'3 этаж');
      assert.match(app.location.search,/building=five/);
      assert.match(app.location.search,/floor=3/);
      assert.equal(app.$('#search').value,'');
      await app.update(()=>app.fire(app.document.body,'keydown',{key:'Escape'}));
      assert.equal(app.$('#roomCard'),null);
    }));

    await t.test('map endpoints, destination search, route building and Kazakh switching preserve the chosen path',()=>withApp(undefined,async app=>{
      const start=app.maps.five.floors[1].rooms.find(room=>room.type==='stair'&&!room.partial);
      const nearby=app.maps.five.floors[1].rooms.find(room=>!room.partial&&room.id!==start.id);
      await app.click(`#drawing [data-room="${start.id}"]`);
      await app.click('#chooseFrom');
      assert.equal(app.$('#planner').hidden,false);
      assert.equal(app.$('#roomCard'),null);
      assert.ok(app.$('#routeFrom').value);
      assert.match(app.$('#routeFrom-meta').textContent,/А корпус.*1 этаж/);
      await app.click(`#drawing [data-room="${nearby.id}"]`);
      await app.click('#chooseTo');
      assert.ok(app.$('#routeTo').value);
      await app.type('#routeTo','305');
      await app.waitFor(()=>[...app.document.querySelectorAll('#routeTo-results [role="option"]')].some(item=>item.textContent.includes('305')), 'destination API suggestions');
      const option=[...app.document.querySelectorAll('#routeTo-results [role="option"]')].find(item=>item.textContent.includes('305'));
      await app.click(option);
      await app.update(()=>app.fire(app.$('#routeForm'),'submit'));
      await app.waitFor(()=>app.$('.route-line'), 'route calculated by POST API');
      assert.ok(app.requests.some(request=>request.url.pathname==='/api/v1/routes'&&request.options.method==='POST'));
      assert.match(app.$('#routeSummary').textContent,/Маршрут построен/);
      assert.match(app.$('#routeSummary').textContent,/305/);
      assert.ok(app.$('.route-line'));
      assert.equal(app.$('.map-heading h1').textContent,'1 этаж');
      const pathBefore=app.$('.route-line').getAttribute('points');
      await app.click('.language-switch button[lang="kk"]');
      assert.equal(app.document.documentElement.lang,'kk');
      assert.match(app.$('#routeSummary').textContent,/Бағыт құрылды/);
      assert.equal(app.$('.route-line').getAttribute('points'),pathBefore);
      assert.equal(app.$('#routeTo').value,'305-кабинет');
      assert.equal(app.stored.get('hdu-language'),'kk');
    }));

    await t.test('corpus and floor controls preserve A basement–5 and B 1–7 mappings',()=>withApp(undefined,async app=>{
      await app.click('#floors button[aria-label="Подвал"]');
      assert.equal(app.$('.map-heading h1').textContent,'Подвал');
      assert.match(app.location.search,/floor=0/);
      await app.click(app.corpusButton('seven'));
      assert.equal(app.document.querySelectorAll('#floors button').length,7);
      assert.equal(app.$('#floors button[aria-label="Подвал"]'),null);
      await app.click('#floors button[aria-label="7 этаж"]');
      assert.equal(app.$('.map-heading h1').textContent,'7 этаж');
      assert.match(app.location.search,/building=seven/);
      assert.match(app.location.search,/floor=7/);
      await app.click(app.corpusButton('five'));
      assert.equal(app.document.querySelectorAll('#floors button').length,6);
      assert.equal(app.$('.map-heading h1').textContent,'1 этаж');
    }));

    await t.test('zoom buttons call the real MapCanvas ref and reset to the fitted view',()=>withApp(undefined,async app=>{
      assert.equal(app.$('#zoomLabel').textContent,'100%');
      await app.click('#plus');
      assert.equal(app.$('#zoomLabel').textContent,'120%');
      assert.match(app.$('#drawing').style.transform,/scale\(1\.2\)/);
      await app.click('#minus');
      assert.equal(app.$('#zoomLabel').textContent,'100%');
      await app.click('#plus');await app.click('#reset');
      assert.equal(app.$('#zoomLabel').textContent,'100%');
      assert.equal(app.$('#drawing').style.transform,'translate(0px,0px) scale(1)');
    }));

    await t.test('Kazakh basement deep link opens the planner and records its collapsed state',()=>withApp('?building=five&floor=0&lang=kk&planner=1',async app=>{
      assert.equal(app.document.documentElement.lang,'kk');
      assert.equal(app.$('.map-heading h1').textContent,'Жертөле');
      assert.equal(app.$('#planner').hidden,false);
      assert.match(app.$('.planner-heading').textContent,/Қайдан → Қайда/);
      assert.match(app.location.search,/planner=1/);
      await app.click('#collapsePlanner');
      assert.equal(app.$('#planner').hidden,true);
      assert.doesNotMatch(app.location.search,/planner=/);
    }));

    await t.test('bootstrap failure shows a retry instead of silently using local map fixtures',async()=>{
      let failures=0;
      const app=await mount(undefined,{ready:false,intercept:(url,options,forward)=>{
        if(url.pathname==='/api/v1/maps'&&failures++===0)throw new TypeError('Temporary network failure');
        return forward();
      }});
      try{
        await app.waitFor(()=>app.$('.bootstrap-state[data-state="error"]'),'bootstrap error state');
        assert.equal(app.$('#drawing'),null);
        await app.click('#retryBootstrap');
        await app.waitFor(()=>app.$('#drawing svg'),'successful retry from real HTTP backend');
        assert.equal(app.requests.filter(request=>request.url.pathname==='/api/v1/maps').length,2);
        assert.equal(app.$('.bootstrap-state[data-state="error"]'),null);
      }finally{await app.close();}
    });

    await t.test('editing an endpoint ignores an already received but delayed route response',async()=>{
      let releaseRoute,received=false,routeSignal;
      const gate=new Promise(resolve=>{releaseRoute=resolve;});
      const app=await mount(undefined,{intercept:async(url,options,forward)=>{
        const response=await forward();
        if(url.pathname==='/api/v1/routes'&&options.method==='POST'){
          await response.clone().json();received=true;routeSignal=options.signal;
          await gate;
        }
        return response;
      }});
      try{
        const start=app.maps.five.floors[1].rooms.find(room=>room.type==='stair'&&!room.partial);
        await app.click(`#drawing [data-room="${start.id}"]`);await app.click('#chooseFrom');
        await app.type('#routeTo','305');
        await app.waitFor(()=>[...app.document.querySelectorAll('#routeTo-results [role="option"]')].some(option=>option.textContent.includes('305')),'route destination suggestions');
        await app.click([...app.document.querySelectorAll('#routeTo-results [role="option"]')].find(option=>option.textContent.includes('305')));
        await app.update(()=>app.fire(app.$('#routeForm'),'submit'));
        await app.waitFor(()=>received,'real route response before artificial delivery delay');
        await app.type('#routeTo','другая точка');
        assert.equal(routeSignal?.aborted,true);
        releaseRoute();await app.update(()=>new Promise(resolve=>setTimeout(resolve,80)));
        assert.equal(app.$('.route-line'),null);
        assert.doesNotMatch(app.$('#routeSummary').textContent,/Маршрут построен/);
        assert.equal(app.$('#routeTo').value,'другая точка');
      }finally{releaseRoute();await app.close();}
    });

    await t.test('a pending route preserves a later language switch and collapsed planner',async()=>{
      let releaseRoute,received=false,routeSignal;
      const gate=new Promise(resolve=>{releaseRoute=resolve;});
      const app=await mount(undefined,{intercept:async(url,options,forward)=>{
        const response=await forward();
        if(url.pathname==='/api/v1/routes'&&options.method==='POST'){
          await response.clone().json();received=true;routeSignal=options.signal;await gate;
        }
        return response;
      }});
      try{
        const start=app.maps.five.floors[1].rooms.find(room=>room.type==='stair'&&!room.partial);
        await app.click(`#drawing [data-room="${start.id}"]`);await app.click('#chooseFrom');
        await app.type('#routeTo','305');
        await app.waitFor(()=>[...app.document.querySelectorAll('#routeTo-results [role="option"]')].some(option=>option.textContent.includes('305')),'route destination before delayed response');
        await app.click([...app.document.querySelectorAll('#routeTo-results [role="option"]')].find(option=>option.textContent.includes('305')));
        await app.update(()=>app.fire(app.$('#routeForm'),'submit'));
        await app.waitFor(()=>received,'pending route response');
        await app.click('.language-switch button[lang="kk"]');
        await app.click('#collapsePlanner');
        assert.equal(routeSignal?.aborted,false);
        releaseRoute();await app.waitFor(()=>app.$('.route-line'),'route completion after view changes');
        assert.equal(app.document.documentElement.lang,'kk');
        assert.equal(app.$('#planner').hidden,true);
        assert.match(app.location.search,/lang=kk/);
        assert.doesNotMatch(app.location.search,/planner=/);
        assert.match(app.$('#routeSummary').textContent,/Бағыт құрылды/);
        assert.equal(app.$('#routeTo').value,'305-кабинет');
      }finally{releaseRoute();await app.close();}
    });
    await t.test('a saved administrator edit refreshes the selected room and picked endpoint without resetting the student view',async()=>{
      const app=await mount('?building=five&floor=0&lang=kk&planner=1');
      try{
        const selectedId=2;
        await app.click(`#drawing [data-room="${selectedId}"]`);
        await app.click('#chooseFrom');
        assert.equal(app.$('#routeFrom').value,'01А-кабинет');
        await app.click(`#drawing [data-room="${selectedId}"]`);
        assert.match(app.$('#detail h3').textContent,/01А/);
        const originalView=app.location.search;
        // Authentication may outlast the endpoint-search debounce; keep those
        // asynchronous React updates inside act while the HTTP request runs.
        let saved;
        await app.update(async()=>{
          const setup=await nativeFetch(base+'/api/v1/admin/setup',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({password:'Automated-test-only-Қазақша-2026'})});
          assert.equal(setup.status,200);
          const auth=await setup.json(),cookie=setup.headers.get('set-cookie').split(';')[0];
          const result=await nativeFetch(base+'/api/v1/admin/rooms/five/0/2',{method:'PATCH',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':auth.data.csrfToken},body:JSON.stringify({number:'01Ғ',labelRu:'Лаборатория робототехники',labelKk:'Робототехника зертханасы',revision:auth.revision})});
          assert.equal(result.status,200);saved=await result.json();
        });
        const beforeRefreshes=app.requests.filter(request=>request.url.pathname==='/api/v1/maps').length;
        await app.update(()=>app.fire(app.window,'storage',{key:'hdu-map-revision',newValue:saved.revision}));
        await app.waitFor(()=>app.$('#detail h3')?.textContent.includes('01Ғ'),'selected room refresh after administrative save');
        await app.waitFor(()=>app.$('#routeFrom').value==='01Ғ-кабинет','picked endpoint reconciled by stable room id');
        assert.equal(app.location.search,originalView);
        assert.equal(app.document.documentElement.lang,'kk');
        assert.equal(app.$('.map-heading h1').textContent,'Жертөле');
        assert.match(app.$('#detail').textContent,/Робототехника зертханасы/);
        assert.equal(app.$('#planner').hidden,false);
        assert.ok(app.requests.filter(request=>request.url.pathname==='/api/v1/maps').length>beforeRefreshes);
        await app.click('.language-switch button[lang="ru"]');
        assert.match(app.$('#detail').textContent,/Лаборатория робототехники/);
        assert.equal(app.$('#routeFrom').value,'Кабинет 01Ғ');
        assert.match(app.location.search,/floor=0/);
      }finally{await app.close();}
    });
  } finally {await server.close();await new Promise(resolve=>httpServer.close(resolve));httpServer.closeAllConnections?.();}
});
