const API_ROOT = '/api/v1';
const REQUEST_TIMEOUT = 8000;
const BUILDINGS = new Set(['five', 'seven']);
const CODE_KEYS = {
  CROSS_BUILDING: 'crossBuilding', PARTIAL_PLAN: 'partial', SAME_POINT: 'samePoint',
  NO_ROUTE: 'noRoute', VALIDATION_ERROR: 'routeError', INVALID_QUERY: 'searchError',
  INTERNAL_ERROR: 'serverError', NETWORK_ERROR: 'networkError', TIMEOUT: 'networkError'
};

export class ApiError extends Error {
  constructor(message = 'The request could not be completed.', { status = 0, code = 'NETWORK_ERROR', errorKey = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.errorKey = errorKey || CODE_KEYS[code] || (status >= 500 ? 'serverError' : 'networkError');
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isInteger(value);
const coordinate = value => Array.isArray(value) && value.length === 2 && value.every(finite);
const revision = value => typeof value === 'string' && value.length > 0 || finite(value);
const abortError = () => new DOMException('The request was cancelled.', 'AbortError');
const invalidResponse = () => new ApiError('The server returned an invalid response.', { code: 'INVALID_RESPONSE', errorKey: 'serverError' });

function validRoom(room) {
  if (!object(room) || !integer(room.id) || room.id < 1 || typeof room.label !== 'string' || !finite(room.cx) || !finite(room.cy)) return false;
  if (room.number !== undefined && room.number !== null && typeof room.number !== 'string') return false;
  if (['labelRu', 'labelKk'].some(key => room[key] !== undefined && typeof room[key] !== 'string')) return false;
  if (room.partial !== undefined && typeof room.partial !== 'boolean') return false;
  if (room.points !== undefined) return typeof room.points === 'string' && room.points.length > 0;
  return ['x', 'y', 'w', 'h'].every(key => finite(room[key])) && room.w > 0 && room.h > 0;
}
function validMaps(maps) {
  return object(maps) && [...BUILDINGS].every(building => {
    const map = maps[building];
    if (!object(map) || !object(map.floors) || !Object.keys(map.floors).length) return false;
    return Object.entries(map.floors).every(([key, floor]) => {
      if (!/^\d+$/.test(key) || !object(floor)) return false;
      if (!Array.isArray(floor.view) || floor.view.length !== 4 || !floor.view.every(finite) || floor.view[2] <= 0 || floor.view[3] <= 0) return false;
      return Array.isArray(floor.rooms) && floor.rooms.every(validRoom);
    });
  });
}
function validSearch(points) {
  return Array.isArray(points) && points.length <= 60 && points.every(point => validRoom(point) && BUILDINGS.has(point.building) && integer(point.floor));
}
function validRoute(route) {
  if (!object(route) || route.ok !== true || !BUILDINGS.has(route.building)) return false;
  if (!['fromId', 'fromFloor', 'targetFloor', 'targetId'].every(key => integer(route[key]))) return false;
  return object(route.segments) && Object.keys(route.segments).length > 0 && Object.entries(route.segments).every(([floor, points]) => /^\d+$/.test(floor) && Array.isArray(points) && points.length > 0 && points.every(coordinate));
}

async function request(path, { method = 'GET', body, signal, validate } = {}) {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let timer, rejectCancellation;
  const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
  const cancel = error => { rejectCancellation(error); controller.abort(error); };
  const onAbort = () => cancel(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(() => cancel(new ApiError('The request timed out.', { code: 'TIMEOUT', errorKey: 'networkError' })), REQUEST_TIMEOUT);
  try {
    const fetchResult = (async () => {
      const response = await fetch(`${API_ROOT}${path}`, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store'
      });
      let payload;
      try { payload = await response.json(); }
      catch { if (!response.ok) throw new ApiError('The server could not complete the request.', { status: response.status, code: 'HTTP_ERROR', errorKey: response.status >= 500 ? 'serverError' : 'networkError' }); throw invalidResponse(); }
      if (!response.ok) {
        const code = object(payload?.error) && typeof payload.error.code === 'string' ? payload.error.code : 'HTTP_ERROR';
        // Backend diagnostics are intentionally not copied into user-facing errors.
        throw new ApiError('The server could not complete the request.', {
          status: response.status, code,
          errorKey: CODE_KEYS[code] || (response.status >= 500 ? 'serverError' : method === 'POST' ? 'routeError' : 'networkError')
        });
      }
      if (!object(payload) || !revision(payload.revision) || !Object.hasOwn(payload, 'data') || !validate(payload.data)) throw invalidResponse();
      return { data: payload.data, revision: payload.revision };
    })();
    return await Promise.race([fetchResult, cancelled]);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw abortError();
    if (error instanceof ApiError) throw error;
    throw new ApiError('The server is not reachable.', { code: 'NETWORK_ERROR', errorKey: 'networkError' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** All calls resolve to the backend envelope { data, revision }. */
export function loadMaps({ signal } = {}) {
  return request('/maps', { signal, validate: validMaps });
}
export function searchRoomsRemote(query, { building, floor, routeOnly = false, signal } = {}) {
  if (typeof query !== 'string' || query.length > 120 || building !== undefined && !BUILDINGS.has(building) || floor !== undefined && !integer(floor) || typeof routeOnly !== 'boolean') {
    return Promise.reject(new ApiError('Invalid search parameters.', { code: 'INVALID_QUERY', errorKey: 'searchError' }));
  }
  const params = new URLSearchParams({ q: query, routeOnly: String(routeOnly), limit: '60' });
  // UI context changes ranking, never hides matches on other floors or in the other corpus.
  if (building !== undefined) params.set('contextBuilding', building);
  if (floor !== undefined) params.set('contextFloor', String(floor));
  return request(`/search?${params}`, { signal, validate: validSearch });
}
function canonicalEndpoint(point) {
  if (!object(point) || !BUILDINGS.has(point.building) || !integer(point.floor) || !integer(point.id) || point.id < 1) throw new ApiError('Invalid route endpoint.', { code: 'VALIDATION_ERROR', errorKey: 'routeError' });
  // Technical ids stay separate from cabinet numbers such as 01А or 06Б.
  return { building: point.building, floor: point.floor, id: point.id };
}
export function createRoute(from, to, { signal } = {}) {
  let body;
  try { body = { from: canonicalEndpoint(from), to: canonicalEndpoint(to) }; }
  catch (error) { return Promise.reject(error); }
  return request('/routes', { method: 'POST', body, signal, validate: validRoute });
}
