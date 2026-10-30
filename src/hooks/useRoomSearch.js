import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchRoomsRemote } from '../api-client.js';

const pointKey = point => point && `${point.building}:${point.floor}:${point.id}`;

/** Debounced server search. Building/floor are ranking context, not result filters.
 * A failed request never falls back to a local catalog. */
export default function useRoomSearch(query, { building, floor, revision, routeOnly = false, enabled = true, selectedPoint = null } = {}) {
  const effectiveQuery = selectedPoint ? '' : String(query ?? '').trim();
  const requestKey = JSON.stringify([effectiveQuery, building ?? null, floor ?? null, routeOnly, revision ?? null]);
  const [state, setState] = useState({ key: null, results: [], loading: false, error: null });
  const [attempt, setAttempt] = useState(0);
  const sequence = useRef(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    const current = ++sequence.current;
    if (!enabled) {
      setState({ key: requestKey, results: [], loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ key: requestKey, results: [], loading: true, error: null });
    const timer = setTimeout(async () => {
      try {
        const response = await searchRoomsRemote(effectiveQuery, { building, floor, routeOnly, signal: controller.signal });
        if (!controller.signal.aborted && current === sequence.current) setState({ key: requestKey, results: response.data, loading: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted && current === sequence.current && error?.name !== 'AbortError') setState({ key: requestKey, results: [], loading: false, error });
      }
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [requestKey, effectiveQuery, building, floor, routeOnly, enabled, attempt]);

  const active = enabled && state.key === requestKey;
  const results = useMemo(() => {
    if (!active || state.loading || state.error) return [];
    if (!selectedPoint || routeOnly && selectedPoint.partial) return state.results;
    const selectedKey = pointKey(selectedPoint);
    const canonical = state.results.find(point => pointKey(point) === selectedKey) || selectedPoint;
    return [canonical, ...state.results.filter(point => pointKey(point) !== selectedKey)].slice(0, 60);
  }, [active, state.loading, state.error, state.results, selectedPoint, routeOnly]);
  return { results, loading: !!enabled && (!active || state.loading), error: active ? state.error : null, retry };
}

export { useRoomSearch };
