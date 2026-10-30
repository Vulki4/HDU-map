const ROOT = '/api/v1/admin';

export class AdminError extends Error {
  constructor(code, status = 0) { super(code); this.name = 'AdminError'; this.code = code; this.status = status; }
}

function abortError() { const error = new Error('Aborted'); error.name = 'AbortError'; return error; }

async function request(path, { method = 'GET', body, csrfToken, signal } = {}) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let rejectCancellation;
  const cancelled = new Promise((resolve, reject) => { rejectCancellation = reject; });
  const onAbort = () => { controller.abort(); rejectCancellation(abortError()); };
  const timer = setTimeout(() => { controller.abort(); rejectCancellation(new AdminError('NETWORK_ERROR')); }, 8000);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([(async () => {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      const response = await fetch(ROOT + path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      let payload;
      try { payload = await response.json(); } catch { throw new AdminError(response.ok ? 'INVALID_RESPONSE' : 'SERVER_ERROR', response.status); }
      if (!response.ok) throw new AdminError(typeof payload?.error?.code === 'string' ? payload.error.code : 'SERVER_ERROR', response.status);
      if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'data') || !/^[a-f0-9]{64}$/.test(payload.revision??'')) throw new AdminError('INVALID_RESPONSE');
      return payload;
    })(), cancelled]);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' && signal?.aborted) throw abortError();
    if (error instanceof AdminError) throw error;
    throw new AdminError('NETWORK_ERROR');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
  }
}

const validate = (response, predicate) => { if(!predicate(response.data))throw new AdminError('INVALID_RESPONSE');return response; };
const sessionValid = data => data&&typeof data.configured==='boolean'&&typeof data.authenticated==='boolean'&&typeof data.canSetup==='boolean'&&(!data.authenticated||typeof data.csrfToken==='string'&&data.csrfToken.length>20);
const roomValid = room => room&&['five','seven'].includes(room.building)&&Number.isInteger(room.floor)&&Number.isInteger(room.id)&&room.id>0&&typeof room.label==='string'&&typeof room.labelRu==='string'&&typeof room.labelKk==='string'&&(room.number===undefined||typeof room.number==='string');
export const getSession = options => request('/session', options).then(response=>validate(response,sessionValid));
export const authenticate = (password, setup = false, options = {}) => request(setup ? '/setup' : '/login', { ...options, method: 'POST', body: { password } }).then(response=>validate(response,sessionValid));
export const logout = (csrfToken, options = {}) => request('/logout', { ...options, method: 'POST', body: {}, csrfToken });
export const getRooms = (building, floor, options = {}) => request(`/rooms?${new URLSearchParams({ building, floor: String(floor) })}`, options).then(response=>validate(response,data=>Array.isArray(data)&&data.every(roomValid)));
export const getRoomHistory = (point, options = {}) => request(`/history/${encodeURIComponent(point.building)}/${point.floor}/${point.id}`, options).then(response=>validate(response,data=>Array.isArray(data)&&data.every(item=>item&&Number.isInteger(item.id)&&typeof item.createdAt==='string'&&['before','after'].every(key=>item[key]&&['number','labelRu','labelKk'].every(field=>typeof item[key][field]==='string')))));
export const saveRoom = (point, draft, revision, csrfToken, options = {}) => request(`/rooms/${encodeURIComponent(point.building)}/${point.floor}/${point.id}`, { ...options, method: 'PATCH', csrfToken, body: { number: draft.number, labelRu: draft.labelRu, labelKk: draft.labelKk, revision } }).then(response=>validate(response,roomValid));
