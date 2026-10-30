import { createHash } from 'node:crypto';
import { buildCatalog, findRoute, searchRooms } from '../src/map-core.js';

const PREFIX = '/api/v1';
const BODY_LIMIT = 8 * 1024;
const ROOM_FIELDS = ['id','number','label','labelRu','labelKk','type','x','y','w','h','cx','cy','points','start','door','partial'];
const FLOOR_FIELDS = ['view','spineX','spineY','wide','partialAnnex'];
const BUILDING_NAMES = {
  five: { code:'A', name:{ru:'А корпус',kk:'А корпусы'} },
  seven: { code:'B', name:{ru:'Б корпус',kk:'Б корпусы'} },
};

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
const own = (object,key) => object && Object.prototype.hasOwnProperty.call(object,key);
const invalidQuery = message => new ApiError(400,'INVALID_QUERY',message);
const objectLike = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copyFields = (value, fields) => Object.fromEntries(fields.filter(key=>own(value,key)&&value[key]!==undefined).map(key=>[key,structuredClone(value[key])]));
const publicRoom = room => copyFields(room, ROOM_FIELDS);
const publicFloor = floor => ({...copyFields(floor,FLOOR_FIELDS),rooms:floor.rooms.map(publicRoom)});
const publicPoint = point => ({...publicRoom(point),building:point.building,floor:point.floor});

/** Only student-facing map data is serialized; plan provenance and areas stay private. */
export function sanitizeMaps(maps) {
  return Object.fromEntries(Object.entries(maps).map(([id,map])=>[id,{
    ...copyFields(map,['name','short']),
    floors:Object.fromEntries(Object.entries(map.floors).map(([floor,data])=>[floor,publicFloor(data)])),
  }]));
}

function validateParams(params, allowed) {
  for (const key of params.keys()) {
    if (!allowed.includes(key)) throw invalidQuery(`Unknown query parameter: ${key}.`);
    if (params.getAll(key).length !== 1) throw invalidQuery(`Repeated query parameter: ${key}.`);
  }
}
function integerString(value, label, {min=0,max=Number.MAX_SAFE_INTEGER}={}) {
  if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max) throw invalidQuery(`${label} must be an integer between ${min} and ${max}.`);
  return Number(value);
}
function canonicalPoint(value, maps) {
  const invalid = () => new ApiError(400,'VALIDATION_ERROR','Each endpoint must identify an existing building, floor and room.');
  if (!objectLike(value) || typeof value.building!=='string' || !own(maps,value.building) || typeof value.floor!=='number' || !Number.isSafeInteger(value.floor) || typeof value.id!=='number' || !Number.isSafeInteger(value.id) || value.id<1) throw invalid();
  const floor = maps[value.building].floors[value.floor];
  const room = floor?.rooms.find(item=>item.id===value.id);
  if (!room) throw invalid();
  return {...room,building:value.building,floor:value.floor};
}

function readJSON(req) {
  const contentType=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
  if (contentType!=='application/json' || req.headers['content-encoding'] && req.headers['content-encoding']!=='identity') {
    req.resume();
    return Promise.reject(new ApiError(415,'UNSUPPORTED_MEDIA_TYPE','Use an uncompressed application/json request body.'));
  }
  const declared=req.headers['content-length'];
  if (declared!==undefined && Number(declared)>BODY_LIMIT) {
    req.resume();
    return Promise.reject(new ApiError(413,'PAYLOAD_TOO_LARGE','Request body exceeds 8192 bytes.'));
  }
  return new Promise((resolve,reject)=>{
    let settled=false, length=0;
    const chunks=[];
    const finish=(error,value)=>{
      if(settled)return;settled=true;
      req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('aborted',onAborted);
      if(error){req.resume();reject(error);}else resolve(value);
    };
    const onData=chunk=>{
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      length+=bytes.length;
      if(length>BODY_LIMIT){finish(new ApiError(413,'PAYLOAD_TOO_LARGE','Request body exceeds 8192 bytes.'));return;}
      chunks.push(bytes);
    };
    const onEnd=()=>{
      try { finish(null,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))); }
      catch { finish(new ApiError(400,'INVALID_JSON','Request body must be valid JSON.')); }
    };
    const onAborted=()=>finish(new ApiError(400,'INVALID_JSON','Request body was interrupted.'));
    req.on('data',onData);req.once('end',onEnd);req.once('aborted',onAborted);
    // Keep a one-shot error listener even after an early rejection while the stream drains.
    req.once('error',()=>finish(new ApiError(400,'INVALID_JSON','Request body was interrupted.')));
  });
}

function sendJSON(req,res,status,payload,{cache='no-store',conditional=false}={}) {
  const body=Buffer.from(JSON.stringify(payload));
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control',cache);
  res.setHeader('X-Content-Type-Options','nosniff');
  if(conditional){
    const etag=`"${createHash('sha256').update(body).digest('hex')}"`;
    res.setHeader('ETag',etag);
    const matches=String(req.headers['if-none-match']||'').split(',').some(tag=>tag.trim()==='*'||tag.trim().replace(/^W\//,'')===etag);
    if(matches){res.writeHead(304);res.end();return;}
  }
  res.setHeader('Content-Length',body.length);
  res.writeHead(status);res.end(req.method==='HEAD'?undefined:body);
}
function allow(req,res,methods) {
  if(methods.includes(req.method))return;
  req.resume();res.setHeader('Allow',methods.join(', '));
  throw new ApiError(405,'METHOD_NOT_ALLOWED','This method is not supported for this endpoint.');
}

/** Native HTTP adapter. Return false for routes outside /api/v1 so static serving can continue. */
export function createApiHandler({repository,logger}={}) {
  if(!repository || typeof repository.getMaps!=='function' || typeof repository.getRevision!=='function') throw new TypeError('A map repository is required.');
  return async function handleApi(req,res,url) {
    let parsed;
    try { parsed=url instanceof URL?url:new URL(url??req.url,'http://localhost'); }
    catch { return false; }
    const pathname=parsed.pathname;
    if(pathname!==PREFIX && !pathname.startsWith(PREFIX+'/'))return false;
    let routeKind='unknown';
    try {
      const path=pathname.slice(PREFIX.length);
      const floorMatch=path.match(/^\/buildings\/([^/]+)\/floors\/([^/]+)$/);
      routeKind=path==='/maps'?'maps':path==='/buildings'?'buildings':path==='/search'?'search':path==='/routes'?'routes':floorMatch?'floor':'unknown';
      if(routeKind==='unknown')throw new ApiError(404,'NOT_FOUND','API endpoint was not found.');
      allow(req,res,routeKind==='routes'?['POST']:['GET','HEAD']);
      const maps=repository.getMaps(), revision=repository.getRevision();
      if(routeKind==='maps'){
        validateParams(parsed.searchParams,[]);
        sendJSON(req,res,200,{data:sanitizeMaps(maps),revision},{cache:'no-cache',conditional:true});
      } else if(routeKind==='buildings'){
        validateParams(parsed.searchParams,[]);
        const data=Object.keys(maps).map(id=>({id,code:BUILDING_NAMES[id]?.code??id,name:BUILDING_NAMES[id]?.name??{ru:maps[id].name,kk:maps[id].name},floors:Object.keys(maps[id].floors).map(Number).sort((a,b)=>a-b)}));
        sendJSON(req,res,200,{data,revision},{cache:'no-cache',conditional:true});
      } else if(routeKind==='floor'){
        validateParams(parsed.searchParams,[]);
        const [,building,floorText]=floorMatch;
        if(!own(maps,building))throw new ApiError(404,'NOT_FOUND','Building was not found.');
        const floor=integerString(floorText,'floor');
        if(!own(maps[building].floors,floor))throw new ApiError(404,'NOT_FOUND','Floor was not found.');
        sendJSON(req,res,200,{data:publicFloor(maps[building].floors[floor]),revision},{cache:'no-cache',conditional:true});
      } else if(routeKind==='search'){
        const params=parsed.searchParams;
        validateParams(params,['q','building','floor','contextBuilding','contextFloor','routeOnly','limit']);
        const q=params.get('q')??'';
        if([...q].length>120 || /[\u0000-\u001f\u007f]/u.test(q))throw invalidQuery('q must contain at most 120 printable characters.');
        const building=params.get('building')??undefined;
        if(building!==undefined&&!own(maps,building))throw invalidQuery('building must identify an existing corpus.');
        const floor=params.has('floor')?integerString(params.get('floor'),'floor'):undefined;
        if(floor!==undefined && !(building?own(maps[building].floors,floor):Object.values(maps).some(map=>own(map.floors,floor))))throw invalidQuery('floor must identify an existing floor.');
        const contextBuilding=params.get('contextBuilding')??undefined;
        if(contextBuilding!==undefined&&!own(maps,contextBuilding))throw invalidQuery('contextBuilding must identify an existing corpus.');
        const contextFloor=params.has('contextFloor')?integerString(params.get('contextFloor'),'contextFloor'):undefined;
        if(contextFloor!==undefined && (contextBuilding===undefined || !own(maps[contextBuilding].floors,contextFloor)))throw invalidQuery('contextFloor requires an existing floor in contextBuilding.');
        const routeOnly=params.get('routeOnly')??'false';
        if(!['true','false'].includes(routeOnly))throw invalidQuery('routeOnly must be true or false.');
        const limit=params.has('limit')?integerString(params.get('limit'),'limit',{min:1,max:60}):60;
        let catalog=buildCatalog(maps);
        if(building!==undefined)catalog=catalog.filter(room=>room.building===building);
        if(floor!==undefined)catalog=catalog.filter(room=>room.floor===floor);
        const data=searchRooms(q,{catalog,building:contextBuilding??building,floor:contextFloor??floor},routeOnly==='true').slice(0,limit).map(publicPoint);
        sendJSON(req,res,200,{data,revision});
      } else {
        validateParams(parsed.searchParams,[]);
        const body=await readJSON(req);
        if(!objectLike(body))throw new ApiError(400,'VALIDATION_ERROR','Request body must contain from and to endpoints.');
        const from=canonicalPoint(body.from,maps), to=canonicalPoint(body.to,maps);
        if(from.building!==to.building)throw new ApiError(422,'CROSS_BUILDING','A verified route between corpora is unavailable.');
        if(from.partial||to.partial)throw new ApiError(422,'PARTIAL_PLAN','An endpoint belongs to an incomplete plan.');
        if(from.floor===to.floor&&from.id===to.id)throw new ApiError(422,'SAME_POINT','The start and destination must differ.');
        const route=findRoute(maps,from.building,from.floor,from.id,to.floor,to.id);
        if(!route.ok)throw new ApiError(422,'NO_ROUTE','No continuous route was found between these endpoints.');
        sendJSON(req,res,200,{data:route,revision});
      }
    } catch(error) {
      if(res.destroyed || res.writableEnded)return true;
      if(error instanceof ApiError)sendJSON(req,res,error.status,{error:{code:error.code,message:error.message}});
      else {
        const event={level:'error',code:'INTERNAL_ERROR',endpoint:routeKind,method:req.method};
        try { if(typeof logger==='function')logger(event);else logger?.error?.(event); } catch {}
        sendJSON(req,res,500,{error:{code:'INTERNAL_ERROR',message:'The map service could not complete this request.'}});
      }
    }
    return true;
  };
}
