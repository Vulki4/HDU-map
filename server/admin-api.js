import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { buildCatalog, searchRooms } from '../src/map-core.js';
import { ROOM_KK } from '../src/i18n.js';

const scrypt = promisify(scryptCallback);
const PREFIX = '/api/v1/admin';
const COOKIE = 'hdu_admin_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const BODY_LIMIT = 8192;
const ROOM_FIELDS = ['id','number','label','labelRu','labelKk','type','x','y','w','h','cx','cy','points','start','door','partial'];
const own = (value, key) => value && Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class AdminError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new AdminError(status, code, message); };
function send(req, res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Length':body.length});
  res.end(req.method === 'HEAD' ? undefined : body);
}
function methods(req, res, allowed) {
  if (allowed.includes(req.method)) return;
  req.resume(); res.setHeader('Allow', allowed.join(', '));
  fail(405, 'METHOD_NOT_ALLOWED', 'This method is not supported.');
}
function params(searchParams, allowed) {
  for (const key of searchParams.keys()) if (!allowed.includes(key) || searchParams.getAll(key).length !== 1) fail(400,'INVALID_QUERY','Invalid query parameters.');
}
function fields(body, keys) {
  if (!object(body) || Object.keys(body).length !== keys.length || keys.some(key => !own(body,key))) fail(400,'VALIDATION_ERROR','Invalid request fields.');
}
function integer(value, minimum = 0) {
  if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) fail(400,'VALIDATION_ERROR','Invalid room identifier.');
  return Number(value);
}
function readJSON(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json' || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    req.resume(); return Promise.reject(new AdminError(415,'UNSUPPORTED_MEDIA_TYPE','Use an uncompressed application/json body.'));
  }
  if (Number(req.headers['content-length']) > BODY_LIMIT) {
    req.resume(); return Promise.reject(new AdminError(413,'PAYLOAD_TOO_LARGE','Request body exceeds 8192 bytes.'));
  }
  return new Promise((resolve,reject) => {
    const chunks = []; let size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      req.removeListener('data',onData); req.removeListener('end',onEnd); req.removeListener('aborted',onAbort);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
      if (size > BODY_LIMIT) { finish(new AdminError(413,'PAYLOAD_TOO_LARGE','Request body exceeds 8192 bytes.')); return; }
      chunks.push(bytes);
    };
    const onEnd = () => {
      try { finish(null,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))); }
      catch { finish(new AdminError(400,'INVALID_JSON','Request body must be valid JSON.')); }
    };
    const onAbort = () => finish(new AdminError(400,'INVALID_JSON','Request body was interrupted.'));
    req.on('data',onData); req.once('end',onEnd); req.once('aborted',onAbort);
    req.once('error',onAbort);
  });
}
function requestOrigin(req) {
  try {
    const url = new URL(`${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host || ''}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}
function localSetup(req) {
  const peer = req.socket.remoteAddress;
  const origin = requestOrigin(req);
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer) && !!origin && ['localhost','127.0.0.1','[::1]','::1'].includes(origin.hostname);
}
function publicPoint(point) {
  const data = Object.fromEntries(ROOM_FIELDS.filter(key => own(point,key) && point[key] !== undefined).map(key => [key,structuredClone(point[key])]));
  return {...data,labelRu:point.labelRu || point.label,labelKk:point.labelKk || ROOM_KK[point.label] || '',building:point.building,floor:point.floor};
}
function passwordValue(body) {
  fields(body,['password']);
  if (typeof body.password !== 'string' || [...body.password].length < 12 || [...body.password].length > 128 || /[\u0000-\u001f\u007f]/u.test(body.password)) fail(400,'VALIDATION_ERROR','Password must contain 12 to 128 printable characters.');
  return body.password;
}
function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first,second);
}

/** Separate authenticated API. Password hashes stay in SQLite; sessions expire on restart. */
export function createAdminHandler({repository,logger,publicOrigin} = {}) {
  if (!repository || typeof repository.getMaps !== 'function') throw new TypeError('A map repository is required.');
  let configuredOrigin;
  if (publicOrigin !== undefined && publicOrigin !== '') {
    const parsed = new URL(publicOrigin);
    if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new TypeError('publicOrigin must be an HTTP origin.');
    configuredOrigin = parsed.origin;
  }
  const sessions = new Map(), failures = new Map();
  let hashing = 0;
  function prune(map, max) {
    const now = Date.now();
    for (const [key,value] of map) if (value.expires <= now) map.delete(key);
    while (map.size >= max) map.delete(map.keys().next().value);
  }
  function assertOrigin(req) {
    const expected = configuredOrigin || requestOrigin(req)?.origin;
    if (!expected || req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') fail(403,'FORBIDDEN','A same-origin request is required.');
  }
  function findSession(req) {
    const values = String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE+'='));
    if (values.length !== 1) return null;
    const token = values[0].slice(COOKIE.length+1);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expires <= Date.now()) { sessions.delete(token); return null; }
    return {token,...session};
  }
  function requireSession(req, csrf = false) {
    const session = findSession(req);
    if (!session) fail(401,'UNAUTHORIZED','Administrator sign-in is required.');
    if (csrf && !equalSecret(req.headers['x-csrf-token'],session.csrfToken)) fail(403,'CSRF_INVALID','The security token is invalid.');
    return session;
  }
  const secure = req => !!req.socket.encrypted || configuredOrigin?.startsWith('https:');
  function setCookie(req, res, token, expire = false) {
    res.setHeader('Set-Cookie',`${COOKIE}=${token}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${expire?0:SESSION_MS/1000}${secure(req)?'; Secure':''}`);
  }
  function openSession(req,res) {
    prune(sessions,1024);
    // Rotate a browser's existing session during each successful authentication.
    const previous = findSession(req); if (previous) sessions.delete(previous.token);
    const token = randomBytes(32).toString('hex'), csrfToken = randomBytes(32).toString('hex');
    const session = {csrfToken,expires:Date.now()+SESSION_MS}; sessions.set(token,session); setCookie(req,res,token);
    return {token,...session};
  }
  function authData(req,session = findSession(req)) {
    const configured = !!repository.getAdminCredential();
    return {configured,authenticated:!!session,canSetup:!configured&&localSetup(req),...(session?{csrfToken:session.csrfToken}:{})};
  }
  function authLimit(req,res) {
    const key = req.socket.remoteAddress || 'unknown'; let item = failures.get(key);
    if (item && item.expires > Date.now() && item.count >= 5) {
      res.setHeader('Retry-After',Math.max(1,Math.ceil((item.expires-Date.now())/1000)));
      fail(429,'RATE_LIMITED','Too many sign-in attempts. Try again later.');
    }
    // Reserve before asynchronous scrypt so concurrent failures cannot bypass the cap.
    if (!item || item.expires <= Date.now()) { prune(failures,1024); item={count:0,expires:Date.now()+AUTH_WINDOW_MS}; failures.set(key,item); }
    item.count++;
    return key;
  }
  async function withHash(res, callback) {
    if (hashing >= 4) { res.setHeader('Retry-After','1'); fail(429,'RATE_LIMITED','Authentication is busy. Try again shortly.'); }
    hashing++;
    try { return await callback(); } finally { hashing--; }
  }
  async function encodePassword(password,res) {
    return withHash(res,async()=>{
      const salt=randomBytes(16).toString('hex');
      const digest=await scrypt(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024});
      return `scrypt-v1$${salt}$${digest.toString('hex')}`;
    });
  }
  async function verifyPassword(password,stored,res) {
    if (typeof stored !== 'string' || !/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(stored)) return false;
    const [,salt,digest] = stored.split('$');
    const actual = await withHash(res,()=>scrypt(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}));
    return timingSafeEqual(actual,Buffer.from(digest,'hex'));
  }
  function pointIdentifiers(building,floor,id) {
    if (!['five','seven'].includes(building)) fail(404,'NOT_FOUND','Room was not found.');
    return {building,floor:integer(floor),id:integer(id,1)};
  }
  const handler = async (req,res,url) => {
    const parsed = url instanceof URL ? url : new URL(url || req.url,'http://localhost');
    if (parsed.pathname !== PREFIX && !parsed.pathname.startsWith(PREFIX+'/')) return false;
    let endpoint = 'unknown';
    try {
      const suffix = parsed.pathname.slice(PREFIX.length);
      const roomMatch = suffix.match(/^\/rooms\/([^/]+)\/([^/]+)\/([^/]+)$/);
      const historyMatch = suffix.match(/^\/history\/([^/]+)\/([^/]+)\/([^/]+)$/);
      endpoint = ['/session','/setup','/login','/logout','/rooms'].includes(suffix) ? suffix.slice(1) : roomMatch ? 'edit' : historyMatch ? 'history' : 'unknown';
      if (endpoint === 'unknown') fail(404,'NOT_FOUND','Administrator endpoint was not found.');
      methods(req,res,['session','rooms','history'].includes(endpoint)?['GET','HEAD']:endpoint==='edit'?['PATCH']:['POST']);
      if (!['GET','HEAD'].includes(req.method)) assertOrigin(req);
      params(parsed.searchParams,endpoint==='rooms'?['building','floor','q']:[]);
      const success = data => send(req,res,200,{data,revision:repository.getRevision()});
      if (endpoint === 'session') success(authData(req));
      else if (endpoint === 'setup' || endpoint === 'login') {
        const key = authLimit(req,res);
        if (endpoint === 'setup') {
          if (!localSetup(req)) fail(403,'SETUP_LOCAL_ONLY','Initial setup is available only on the local computer.');
          if (repository.getAdminCredential()) fail(409,'ALREADY_CONFIGURED','Administrator access has already been configured.');
        }
        const body = await readJSON(req);
        const password=passwordValue(body);
        if (endpoint === 'setup') {
          const encoded = await encodePassword(password,res);
          if (!repository.setAdminCredential(encoded)) fail(409,'ALREADY_CONFIGURED','Administrator access has already been configured.');
        } else {
          const credential = repository.getAdminCredential();
          if (!credential || !await verifyPassword(password,credential.passwordHash,res)) fail(401,'INVALID_CREDENTIALS','The password is incorrect.');
        }
        failures.delete(key); success(authData(req,openSession(req,res)));
      } else if (endpoint === 'logout') {
        const session = requireSession(req,true); fields(await readJSON(req),[]);
        sessions.delete(session.token); setCookie(req,res,'',true); success(authData(req,null));
      } else if (endpoint === 'rooms') {
        requireSession(req);
        const query = parsed.searchParams;
        let catalog = buildCatalog(repository.getMaps());
        const building = query.get('building'), floor = query.has('floor')?integer(query.get('floor')):undefined;
        if (building !== null && !['five','seven'].includes(building)) fail(400,'INVALID_QUERY','Invalid building filter.');
        if (building !== null) catalog=catalog.filter(room=>room.building===building);
        if (floor !== undefined) {
          if (!catalog.some(room=>room.floor===floor)) fail(400,'INVALID_QUERY','Invalid floor filter.');
          catalog=catalog.filter(room=>room.floor===floor);
        }
        const q=query.get('q')||'';
        if ([...q].length>120 || /[\u0000-\u001f\u007f]/u.test(q)) fail(400,'INVALID_QUERY','Invalid search text.');
        success(searchRooms(q,{catalog,building:building??undefined,floor}).map(publicPoint));
      } else if (endpoint === 'edit') {
        requireSession(req,true);
        const point=pointIdentifiers(...roomMatch.slice(1)), body=await readJSON(req);
        fields(body,['number','labelRu','labelKk','revision']);
        const result=repository.updateRoom({...point,...body});
        send(req,res,200,{data:publicPoint({...result.room,...point}),revision:result.revision});
      } else {
        requireSession(req);
        const point=pointIdentifiers(...historyMatch.slice(1));
        const exists=repository.getMaps()[point.building]?.floors[point.floor]?.rooms.some(room=>room.id===point.id);
        if (!exists) fail(404,'NOT_FOUND','Room was not found.');
        success(repository.getRoomHistory({...point,limit:20}));
      }
    } catch(error) {
      req.resume();
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof AdminError) send(req,res,error.status,{error:{code:error.code,message:error.message}});
      else if (['NOT_FOUND','REVISION_CONFLICT','VALIDATION_ERROR','DUPLICATE_NUMBER'].includes(error?.code)) {
        const status=error.code==='NOT_FOUND'?404:['REVISION_CONFLICT','DUPLICATE_NUMBER'].includes(error.code)?409:400;
        const messages={NOT_FOUND:'Room was not found.',REVISION_CONFLICT:'The map changed. Reload before saving.',VALIDATION_ERROR:'The room fields are invalid.',DUPLICATE_NUMBER:'This cabinet number already exists on this floor.'};
        send(req,res,status,{error:{code:error.code,message:messages[error.code]}});
      } else {
        try { logger?.error?.({event:'admin_request_failed',endpoint,code:'INTERNAL_ERROR'}); } catch {}
        send(req,res,500,{error:{code:'INTERNAL_ERROR',message:'The administrator service could not complete the request.'}});
      }
    }
    return true;
  };
  handler.close=()=>{sessions.clear();failures.clear();};
  return handler;
}
