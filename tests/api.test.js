import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import maps from '../src/data.js';
import { buildCatalog, findRoute } from '../src/map-core.js';
import { createApiHandler, sanitizeMaps } from '../server/api.js';

const seed=structuredClone(maps), initial=JSON.stringify(seed);
const revision=createHash('sha256').update(initial).digest('hex');
const catalog=buildCatalog(seed);
let server,base;
async function start(repository,logger){
  const handler=createApiHandler({repository,logger});
  const instance=http.createServer(async(req,res)=>{if(!await handler(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});
  await new Promise((resolve,reject)=>{instance.once('error',reject);instance.listen(0,'127.0.0.1',resolve);});
  return {instance,url:`http://127.0.0.1:${instance.address().port}`};
}
before(async()=>{({instance:server,url:base}=await start({getMaps:()=>seed,getRevision:()=>revision}));});
after(async()=>{server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));assert.equal(JSON.stringify(seed),initial,'API requests must not mutate repository data');});
const request=async(path,options)=>{const response=await fetch(base+path,options);const text=await response.text();return {response,text,body:text?JSON.parse(text):null};};
const post=body=>request('/api/v1/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const point=room=>({building:room.building,floor:room.floor,id:room.id});
const from=catalog.find(room=>room.building==='five'&&room.floor===1&&room.type==='stair');
const to=catalog.find(room=>room.building==='five'&&room.number==='305');
const forbidden=new Set(['area','source','sourcePage','sourceAsset','explanationPage']);
function noPrivateFields(value){
  if(!value||typeof value!=='object')return;
  for(const [key,child]of Object.entries(value)){assert.ok(!forbidden.has(key),`Private field exposed: ${key}`);noPrivateFields(child);}
}
function streamRequest(path,chunks,headers={}){
  return new Promise((resolve,reject)=>{
    const req=http.request(base+path,{method:'POST',headers},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:text?JSON.parse(text):null}));});
    req.on('error',reject);for(const chunk of chunks)req.write(chunk);req.end();
  });
}

test('public map and floor responses whitelist geometry without areas or source provenance',async()=>{
  const result=await request('/api/v1/maps');
  assert.equal(result.response.status,200);assert.equal(result.body.revision,revision);
  assert.equal(Object.values(result.body.data).flatMap(map=>Object.keys(map.floors)).length,13);
  assert.equal(buildCatalog(result.body.data).length,170);noPrivateFields(result.body);
  assert.deepEqual(result.body.data.five.floors[0].view,seed.five.floors[0].view);
  assert.ok(result.response.headers.get('etag'));assert.equal(result.response.headers.get('cache-control'),'no-cache');
  const floor=await request('/api/v1/buildings/five/floors/0');
  assert.equal(floor.response.status,200);noPrivateFields(floor.body);
  assert.deepEqual(floor.body.data, result.body.data.five.floors[0]);
  const sanitized=sanitizeMaps(seed);sanitized.five.floors[0].rooms[0].label='Changed copy';
  assert.notEqual(seed.five.floors[0].rooms[0].label,'Changed copy');
});

test('building metadata, HEAD, ETags and conditional floor requests follow HTTP semantics',async()=>{
  const buildings=await request('/api/v1/buildings');
  assert.equal(buildings.response.status,200);assert.equal(buildings.body.data.length,2);
  const five=buildings.body.data.find(building=>building.id==='five');
  assert.deepEqual(five.floors,[0,1,2,3,4,5]);assert.deepEqual(five.name,{ru:'А корпус',kk:'А корпусы'});
  const seven=buildings.body.data.find(building=>building.id==='seven');
  assert.deepEqual(seven.floors,[1,2,3,4,5,6,7]);
  const first=await request('/api/v1/buildings/seven/floors/7');
  const etag=first.response.headers.get('etag');
  const cached=await request('/api/v1/buildings/seven/floors/7',{headers:{'If-None-Match':`W/${etag}`}});
  assert.equal(cached.response.status,304);assert.equal(cached.text,'');
  const head=await request('/api/v1/maps',{method:'HEAD'});
  assert.equal(head.response.status,200);assert.equal(head.text,'');assert.ok(Number(head.response.headers.get('content-length'))>0);
});

test('global bilingual search ranks context without filtering other floors or corpora',async()=>{
  const match=await request('/api/v1/search?q=305&contextBuilding=five&contextFloor=1');
  assert.equal(match.response.status,200);assert.ok(match.body.data.some(room=>room.number==='305'&&room.floor===3));
  const otherCorpus=await request('/api/v1/search?q=211&contextBuilding=five');
  assert.ok(otherCorpus.body.data.some(room=>room.number==='211'&&room.building==='seven'));
  const ru=await request('/api/v1/search?q='+encodeURIComponent('библиотека'));
  const kk=await request('/api/v1/search?q='+encodeURIComponent('кітапхана'));
  assert.deepEqual(ru.body.data,kk.body.data);assert.ok(kk.body.data.length);noPrivateFields(kk.body);
  const zero=await request('/api/v1/search?q=01A');
  assert.ok(zero.body.data.some(room=>room.number==='01А'&&room.floor===0));
  const restricted=await request('/api/v1/search?building=five&floor=0&routeOnly=true&limit=3');
  assert.equal(restricted.body.data.length,3);assert.ok(restricted.body.data.every(room=>room.building==='five'&&room.floor===0&&!room.partial));
  const empty=await request('/api/v1/search?q=zzzz-no-room');
  assert.equal(empty.response.status,200);assert.deepEqual(empty.body.data,[]);
  assert.equal(empty.response.headers.get('cache-control'),'no-store');
});

test('invalid query parameters and unknown resources receive explicit JSON errors',async()=>{
  for(const query of ['q='+ 'a'.repeat(121),'building=constructor','floor=-1','floor=1.5','building=five&floor=7','contextBuilding=five&contextFloor=7','contextFloor=1','routeOnly=1','limit=0','limit=61','q=a&q=b','unknown=1','q=%00']){
    const result=await request('/api/v1/search?'+query);
    assert.equal(result.response.status,400,query);assert.equal(result.body.error.code,'INVALID_QUERY',query);
  }
  for(const path of ['/api/v1/no-such-route','/api/v1/buildings/constructor/floors/1','/api/v1/buildings/five/floors/99']){
    const result=await request(path);assert.equal(result.response.status,404);assert.equal(result.body.error.code,'NOT_FOUND');
  }
  const wrongMethod=await request('/api/v1/maps',{method:'POST'});
  assert.equal(wrongMethod.response.status,405);assert.equal(wrongMethod.body.error.code,'METHOD_NOT_ALLOWED');assert.equal(wrongMethod.response.headers.get('allow'),'GET, HEAD');
  const getRoute=await request('/api/v1/routes');
  assert.equal(getRoute.response.status,405);assert.equal(getRoute.response.headers.get('allow'),'POST');
});

test('route requests use canonical endpoints and preserve the existing schematic graph',async()=>{
  const result=await post({from:{...point(from),label:'forged',start:[-999,-999]},to:{...point(to),number:'fake',door:[-999,-999]}});
  assert.equal(result.response.status,200);assert.equal(result.body.revision,revision);
  assert.deepEqual(result.body.data,findRoute(seed,'five',from.floor,from.id,to.floor,to.id));
  assert.equal(result.response.headers.get('cache-control'),'no-store');noPrivateFields(result.body);
});

test('route validation distinguishes malformed, missing, cross-corpus, partial and equal points',async()=>{
  const other=catalog.find(room=>room.building==='seven'&&!room.partial);
  const partial=catalog.find(room=>room.building==='five'&&room.partial);
  for(const body of [null,[],{}, {from:point(from)}, {from:{...point(from),floor:'1'},to:point(to)},{from:{...point(from),id:99999},to:point(to)},{from:{...point(from),building:'__proto__'},to:point(to)}]){
    const result=await post(body);assert.equal(result.response.status,400);assert.equal(result.body.error.code,'VALIDATION_ERROR');
  }
  for(const [body,code]of [[{from:point(from),to:point(other)},'CROSS_BUILDING'],[{from:{...point(partial),partial:false},to:point(to)},'PARTIAL_PLAN'],[{from:point(from),to:point(from)},'SAME_POINT']]){
    const result=await post(body);assert.equal(result.response.status,422);assert.equal(result.body.error.code,code);
  }
  const disconnected=structuredClone(seed);
  for(const floor of Object.values(disconnected.five.floors))floor.rooms=floor.rooms.filter(room=>room.type!=='stair');
  const alternate=buildCatalog(disconnected).find(room=>room.building==='five'&&room.floor===1&&!room.partial);
  const isolated=await start({getMaps:()=>disconnected,getRevision:()=>revision});
  try{
    const result=await fetch(isolated.url+'/api/v1/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:point(alternate),to:point(to)})});
    assert.equal(result.status,422);assert.equal((await result.json()).error.code,'NO_ROUTE');
  }finally{isolated.instance.closeIdleConnections();await new Promise(resolve=>isolated.instance.close(resolve));}
});

test('JSON parsing enforces media type, UTF-8, malformed syntax and 8KB streamed limits',async()=>{
  const media=await request('/api/v1/routes',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});
  assert.equal(media.response.status,415);assert.equal(media.body.error.code,'UNSUPPORTED_MEDIA_TYPE');
  const malformed=await request('/api/v1/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"from":'});
  assert.equal(malformed.response.status,400);assert.equal(malformed.body.error.code,'INVALID_JSON');
  const declared=await request('/api/v1/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(8193)});
  assert.equal(declared.response.status,413);assert.equal(declared.body.error.code,'PAYLOAD_TOO_LARGE');
  const streamed=await streamRequest('/api/v1/routes',[Buffer.alloc(5000,32),Buffer.alloc(5000,32)],{'Content-Type':'application/json'});
  assert.equal(streamed.status,413);assert.equal(streamed.body.error.code,'PAYLOAD_TOO_LARGE');
  const invalidUTF8=await streamRequest('/api/v1/routes',[Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xc3,0x28,0x22,0x7d])],{'Content-Type':'application/json'});
  assert.equal(invalidUTF8.status,400);assert.equal(invalidUTF8.body.error.code,'INVALID_JSON');
  assert.equal((await request('/api/v1/maps')).response.status,200,'A rejected body must not break subsequent requests');
});

test('unexpected repository failures return generic errors and log no raw request data',async()=>{
  const logs=[];
  const broken=await start({getMaps(){throw new Error('secret-sql-path');},getRevision:()=>revision},event=>logs.push(event));
  try{
    const response=await fetch(broken.url+'/api/v1/search?q=private-query');
    const body=await response.json();assert.equal(response.status,500);assert.equal(body.error.code,'INTERNAL_ERROR');
    assert.doesNotMatch(JSON.stringify(body),/secret-sql-path|private-query/);
    assert.equal(logs.length,1);assert.doesNotMatch(JSON.stringify(logs),/secret-sql-path|private-query/);
  }finally{broken.instance.closeIdleConnections();await new Promise(resolve=>broken.instance.close(resolve));}
});
