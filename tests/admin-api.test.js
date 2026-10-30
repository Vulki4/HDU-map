import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAdminHandler } from '../server/admin-api.js';
import { createMapRepository } from '../server/repository.js';

const PASSWORD='ХДУ - Admin 2026!';
const prefix='/api/v1/admin';
async function fixture(t,{filename=':memory:',publicOrigin}={}) {
  const repository=createMapRepository({filename}), logs=[];
  const handler=createAdminHandler({repository,publicOrigin,logger:{error:value=>logs.push(value)}});
  const server=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}`;
  let ended=false;
  const close=async()=>{if(ended)return;ended=true;const closing=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closing;handler.close();repository.close();};
  t.after(close);
  const request=async(route,{method='GET',body,cookie,csrf,headers={},raw}={})=>{
    const response=await fetch(base+prefix+route,{method,headers:{...(method==='GET'||method==='HEAD'?{}:{Origin:publicOrigin||base,'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...headers},...(body===undefined&&raw===undefined?{}:{body:raw??JSON.stringify(body)})});
    const text=await response.text();return {response,text,body:text?JSON.parse(text):null};
  };
  const setup=async()=>{
    const result=await request('/setup',{method:'POST',body:{password:PASSWORD}});
    assert.equal(result.response.status,200,result.text);
    return {cookie:result.response.headers.get('set-cookie').split(';')[0],csrf:result.body.data.csrfToken,result};
  };
  return {repository,handler,server,base,request,setup,logs,close};
}
function point(f,number='09А') {
  const room=f.repository.getMaps().five.floors[0].rooms.find(item=>item.type==='room'&&!item.partial);
  return {room,url:`/rooms/five/0/${room.id}`,body:{number,labelRu:'Центр поддержки студентов',labelKk:'Студенттерді қолдау орталығы',revision:f.repository.getRevision()}};
}
function assertPrivateFree(value) {
  if (!value||typeof value!=='object') return;
  for(const [key,child]of Object.entries(value)) {
    assert.ok(!['area','source','sourcePage','sourceAsset','explanationPage','passwordHash','password_hash','csrf_token'].includes(key),key);
    assertPrivateFree(child);
  }
}

test('administrator session starts unconfigured and protected endpoints require authentication',async t=>{
  const f=await fixture(t);
  const session=await f.request('/session');
  assert.equal(session.response.status,200);assert.deepEqual(session.body.data,{configured:false,authenticated:false,canSetup:true});
  assert.equal(session.response.headers.get('cache-control'),'no-store');
  for(const route of ['/rooms','/history/five/0/1'])assert.equal((await f.request(route)).response.status,401);
  const wrong=await f.request('/session',{method:'POST',body:{}});
  assert.equal(wrong.response.status,405);assert.equal(wrong.response.headers.get('allow'),'GET, HEAD');
  assert.equal((await f.request('/session?unexpected=1')).response.status,400);
  const head=await f.request('/session',{method:'HEAD'});assert.equal(head.response.status,200);assert.equal(head.text,'');
});

test('local setup stores a salted hash and issues a strict HttpOnly session that logout revokes',async t=>{
  const f=await fixture(t), auth=await f.setup();
  assert.deepEqual({...auth.result.body.data,csrfToken:undefined},{configured:true,authenticated:true,canSetup:false,csrfToken:undefined});
  const header=auth.result.response.headers.get('set-cookie');
  assert.match(header,/HttpOnly/);assert.match(header,/SameSite=Strict/);assert.match(header,/Path=\/api\/v1\/admin/);assert.match(header,/Max-Age=28800/);
  const credential=f.repository.getAdminCredential();
  assert.match(credential.passwordHash,/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);assert.ok(!credential.passwordHash.includes(PASSWORD));
  assert.equal((await f.request('/setup',{method:'POST',body:{password:PASSWORD}})).body.error.code,'ALREADY_CONFIGURED');
  const session=await f.request('/session',auth);assert.equal(session.body.data.authenticated,true);assert.equal(session.body.data.csrfToken,auth.csrf);
  assertPrivateFree((await f.request('/rooms',auth)).body);
  const csrf=await f.request('/logout',{method:'POST',body:{},cookie:auth.cookie,csrf:'bad'});assert.equal(csrf.response.status,403);assert.equal(csrf.body.error.code,'CSRF_INVALID');
  const logout=await f.request('/logout',{method:'POST',body:{},...auth});assert.equal(logout.response.status,200);assert.match(logout.response.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await f.request('/rooms',auth)).response.status,401);
  assert.equal((await f.request('/login',{method:'POST',body:{password:'Wrong password 123!'}})).body.error.code,'INVALID_CREDENTIALS');
  const login=await f.request('/login',{method:'POST',body:{password:PASSWORD}});assert.equal(login.response.status,200);assert.equal(login.body.data.authenticated,true);assert.notEqual(login.response.headers.get('set-cookie').split(';')[0],auth.cookie);
});

test('same-origin mutation and loopback hostname setup rules reject cross-site and DNS rebinding requests',async t=>{
  const f=await fixture(t);
  for(const headers of [{Origin:'https://evil.example'},{Origin:''},{'Sec-Fetch-Site':'cross-site'}]) {
    const result=await f.request('/setup',{method:'POST',body:{password:PASSWORD},headers});
    assert.equal(result.response.status,403);assert.equal(result.body.error.code,'FORBIDDEN');
  }
  // Native fetch rewrites Host, so use an actual HTTP request to exercise rebinding.
  const result=await new Promise((resolve,reject)=>{
    const body=JSON.stringify({password:PASSWORD});
    const req=http.request(f.base+prefix+'/setup',{method:'POST',headers:{Host:'evil.example',Origin:'http://evil.example','Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });req.on('error',reject);req.end(body);
  });
  assert.equal(result.status,403);assert.equal(result.body.error.code,'SETUP_LOCAL_ONLY');
  assert.equal(f.repository.getAdminCredential(),null);
  const auth=await f.setup(), edit=point(f);
  const changed=await f.request(edit.url,{method:'PATCH',body:edit.body,...auth,headers:{Origin:'https://evil.example'}});
  assert.equal(changed.response.status,403);
  const missing=await f.request(edit.url,{method:'PATCH',body:edit.body,cookie:auth.cookie});assert.equal(missing.body.error.code,'CSRF_INVALID');
  const cookieOnly=await f.request(edit.url,{method:'PATCH',body:edit.body,csrf:auth.csrf});assert.equal(cookieOnly.response.status,401);
});

test('authenticated room edits preserve geometry and leading zeros, return public fields, and record history',async t=>{
  const f=await fixture(t), auth=await f.setup(), edit=point(f);
  const before=structuredClone(edit.room);
  const result=await f.request(edit.url,{method:'PATCH',body:edit.body,...auth});
  assert.equal(result.response.status,200,result.text);assertPrivateFree(result.body);
  assert.equal(result.body.data.number,'09А');assert.equal(result.body.data.labelRu,edit.body.labelRu);assert.equal(result.body.data.labelKk,edit.body.labelKk);
  assert.notEqual(result.body.revision,edit.body.revision);
  const saved=f.repository.getMaps().five.floors[0].rooms.find(room=>room.id===before.id);
  const {number:unused,label:unused2,labelRu:unused3,labelKk:unused4,...geometry}=saved;
  const {number:oldNumber,label:oldLabel,...oldGeometry}=before;
  assert.deepEqual(geometry,oldGeometry);
  const list=await f.request('/rooms?building=five&floor=0&q=09A',auth);assert.equal(list.body.data.length,1);assert.equal(list.body.data[0].number,'09А');
  const history=await f.request(`/history/five/0/${before.id}`,auth);assert.equal(history.body.data.length,1);assert.equal(history.body.data[0].after.number,'09А');assert.equal(history.body.data[0].after.labelKk,edit.body.labelKk);assertPrivateFree(history.body);
  const stale=await f.request(edit.url,{method:'PATCH',body:{...edit.body,number:'08А'},...auth});assert.equal(stale.response.status,409);assert.equal(stale.body.error.code,'REVISION_CONFLICT');
  const duplicate=f.repository.getMaps().five.floors[0].rooms.find(room=>room.number&&room.id!==before.id);
  const conflict=await f.request(edit.url,{method:'PATCH',body:{...edit.body,number:duplicate.number,revision:result.body.revision},...auth});assert.equal(conflict.response.status,409);assert.equal(conflict.body.error.code,'DUPLICATE_NUMBER');
});

test('room edit validation rejects extra fields, markup, oversized text, wrong methods and unknown rooms',async t=>{
  const f=await fixture(t), auth=await f.setup(), edit=point(f);
  for(const body of [{...edit.body,x:1},{...edit.body,id:999},{...edit.body,labelRu:'<script>oops</script>'},{...edit.body,number:123},{...edit.body,labelKk:'x'.repeat(121)},{...edit.body,labelRu:'\u0000bad'},{...edit.body,revision:undefined}]) {
    const result=await f.request(edit.url,{method:'PATCH',body,...auth});assert.equal(result.response.status,400,result.text);assert.equal(result.body.error.code,'VALIDATION_ERROR');
  }
  assert.equal((await f.request('/rooms/five/0/99999',{method:'PATCH',body:edit.body,...auth})).response.status,404);
  assert.equal((await f.request('/history/five/0/99999',auth)).response.status,404);
  assert.equal((await f.request(edit.url,{method:'DELETE',...auth})).response.status,405);
  for(const query of ['building=constructor','floor=-1','floor=999','building=five&floor=7','q=a&q=b','extra=1'])assert.equal((await f.request('/rooms?'+query,auth)).response.status,400);
  assert.equal(f.repository.getRevision(),edit.body.revision);
});

test('JSON bodies enforce content type, UTF-8, size and password policy without leaking secrets',async t=>{
  const cases=[
    {raw:'{}',headers:{'Content-Type':'text/plain'},status:415},
    {raw:'{broken',status:400},
    {raw:Buffer.from([0xff]),status:400},
    {body:{password:'x'.repeat(9000)},status:413},
    {body:{password:'short'},status:400},
    {body:{password:PASSWORD,extra:'should-not-show'},status:400}
  ];
  for(const item of cases){const f=await fixture(t);try{const result=await f.request('/setup',{method:'POST',...item});assert.equal(result.response.status,item.status,result.text);assert.ok(!result.text.includes(PASSWORD));assert.ok(!result.text.includes('should-not-show'));assert.deepEqual(f.logs,[]);assert.equal(f.repository.getAdminCredential(),null);}finally{await f.close();}}
});

test('five failed authentication attempts are rate limited without trusting forwarded IP headers',async t=>{
  const f=await fixture(t);await f.setup();
  for(let index=0;index<5;index++){
    const result=await f.request('/login',{method:'POST',body:{password:'Wrong password 123!'},headers:{'X-Forwarded-For':`192.0.2.${index}`}});
    assert.equal(result.response.status,401,result.text);
  }
  const limited=await f.request('/login',{method:'POST',body:{password:PASSWORD},headers:{'X-Forwarded-For':'192.0.2.99'}});
  assert.equal(limited.response.status,429);assert.equal(limited.body.error.code,'RATE_LIMITED');assert.ok(Number(limited.response.headers.get('retry-after'))>0);
});

test('credentials and room edits persist after restart while old administrator sessions do not',async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'hdu-admin-api-'));let first,second;
  t.after(async()=>{await first?.close();await second?.close();await rm(folder,{recursive:true,force:true});});
  const filename=path.join(folder,'map.sqlite');first=await fixture(t,{filename});const auth=await first.setup(), edit=point(first);
  const saved=await first.request(edit.url,{method:'PATCH',body:edit.body,...auth});assert.equal(saved.response.status,200);
  await first.close();
  second=await fixture(t,{filename});
  const session=await second.request('/session',auth);assert.equal(session.body.data.configured,true);assert.equal(session.body.data.authenticated,false);assert.equal(session.body.data.canSetup,false);
  assert.equal((await second.request('/rooms',auth)).response.status,401);
  const login=await second.request('/login',{method:'POST',body:{password:PASSWORD}});assert.equal(login.response.status,200);
  const next={cookie:login.response.headers.get('set-cookie').split(';')[0],csrf:login.body.data.csrfToken};
  const result=await second.request('/rooms?building=five&floor=0&q=09А',next);assert.equal(result.body.data.length,1);assert.equal(result.body.data[0].labelRu,edit.body.labelRu);assert.equal(result.body.revision,saved.body.revision);
});

test('Secure cookies are set for a configured HTTPS origin and setup rejects a remote public hostname',async t=>{
  const f=await fixture(t);await f.setup();
  const handler=createAdminHandler({repository:f.repository,publicOrigin:'https://map.example'});
  const server=http.createServer(async(req,res)=>{await handler(req,res,new URL(req.url,'http://localhost'));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{const closing=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closing;handler.close();});
  const response=await fetch(`http://127.0.0.1:${server.address().port}${prefix}/login`,{method:'POST',headers:{Origin:'https://map.example','Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD})});
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/; Secure/);await response.arrayBuffer();
});
