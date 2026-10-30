import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';

const clampZoom = value => Math.max(.5, Math.min(5, value));
function RoomShape({ room, ...props }) {
  return room.points ? <polygon points={room.points} {...props} /> : <rect x={room.x} y={room.y} width={room.w} height={room.h} rx="2" {...props} />;
}
function ServiceIcon({ room, wide }) {
  const size = Math.max(12, Math.min(wide ? 24 : 22, room.w ? room.w - 6 : 22, room.h ? room.h - 6 : 22));
  return <svg className="room-map-icon" x={room.cx - size / 2} y={room.cy - size / 2} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ color: 'var(--label)' }}>
    {room.type === 'stair' ? <path d="M3 20h5v-5h5v-5h5V5h3M4 9V3h6M4 3l8 8" /> : room.label === 'Душевая' ? <path d="m5 4 5 5m-6 2 7-7m1 6 1 1m2 2 1 1m-7-1 1 1m2 2 1 1m-7-1 1 1m2 2 1 1" /> : <><circle cx="7" cy="5" r="2" /><circle cx="17" cy="5" r="2" /><path d="M5 10h4v6H5zm2 6v5m10-11-3 7h6zm0 7v4" /></>}
  </svg>;
}

const MapCanvas = forwardRef(function MapCanvas({ floorData, building, floor, selectedId, routePoints, roomName, roomLabel, t, onSelect, onZoomChange }, ref) {
  const canvasRef = useRef(null), drawingRef = useRef(null);
  const transform = useRef({ zoom: 1, x: 0, y: 0 });
  const callbacks = useRef({ onZoomChange }); callbacks.current = { onZoomChange };
  const lastZoom = useRef(null), suppressClick = useRef(false), gestureActive = useRef(false);
  const [hoveredId, setHoveredId] = useState(null), [focusedId, setFocusedId] = useState(null);
  const commitTransform = useCallback(() => {
    const { x, y, zoom } = transform.current;
    if (drawingRef.current) drawingRef.current.style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
    if (lastZoom.current !== zoom) { lastZoom.current = zoom; callbacks.current.onZoomChange?.(zoom); }
  }, []);
  const reset = useCallback(() => { transform.current = { zoom: 1, x: 0, y: 0 }; commitTransform(); }, [commitTransform]);
  const zoomAt = useCallback((value, x, y) => {
    if (!drawingRef.current || !Number.isFinite(value)) return;
    const current = transform.current, next = clampZoom(value), ratio = next / current.zoom;
    const rect = drawingRef.current.getBoundingClientRect();
    current.x += (x - rect.left - rect.width / 2) * (1 - ratio);
    current.y += (y - rect.top - rect.height / 2) * (1 - ratio);
    current.zoom = next; commitTransform();
  }, [commitTransform]);
  const zoomBy = useCallback(factor => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) zoomAt(transform.current.zoom * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [zoomAt]);
  const focusRoom = useCallback(id => { drawingRef.current?.querySelector(`[data-room="${Number(id)}"]`)?.focus({ preventScroll: true }); }, []);
  useImperativeHandle(ref, () => ({ zoomIn: () => zoomBy(1.2), zoomOut: () => zoomBy(1 / 1.2), reset, focusRoom }), [zoomBy, reset, focusRoom]);
  useLayoutEffect(() => { setHoveredId(null); setFocusedId(null); reset(); }, [building, floor, reset]);

  useEffect(() => {
    const canvas = canvasRef.current, pointers = new Map();
    let drag = null, pinch = null, timer = null;
    const capture = id => { try { canvas.setPointerCapture?.(id); } catch {} };
    const beginPinch = () => {
      const [a, b] = [...pointers.values()], rect = drawingRef.current.getBoundingClientRect();
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), ...transform.current, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
      drag = null; suppressClick.current = true; gestureActive.current = true; setHoveredId(null);
      pointers.forEach((_, id) => capture(id));
    };
    const down = event => {
      if (event.button !== 0 || event.target.closest('button,input,select,.room-card')) return;
      clearTimeout(timer); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) { drag = { x: event.clientX, y: event.clientY, xOffset: transform.current.x, yOffset: transform.current.y, moved: false }; suppressClick.current = false; }
      else if (pointers.size === 2) beginPinch();
    };
    const move = event => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const current = transform.current;
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        current.zoom = clampZoom(pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.distance));
        const ratio = current.zoom / pinch.zoom;
        current.x = pinch.x + (a.x + b.x) / 2 - pinch.mx + (pinch.mx - pinch.cx) * (1 - ratio);
        current.y = pinch.y + (a.y + b.y) / 2 - pinch.my + (pinch.my - pinch.cy) * (1 - ratio);
        commitTransform(); return;
      }
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 6) { drag.moved = true; capture(event.pointerId); gestureActive.current = true; setHoveredId(null); }
      if (drag.moved) { suppressClick.current = true; current.x = drag.xOffset + dx; current.y = drag.yOffset + dy; commitTransform(); }
    };
    const end = event => {
      if (!pointers.has(event.pointerId)) return;
      const moved = drag?.moved || !!pinch || suppressClick.current;
      pointers.delete(event.pointerId); drag = null; pinch = null;
      if (pointers.size === 1) { const [point] = pointers.values(); drag = { x: point.x, y: point.y, xOffset: transform.current.x, yOffset: transform.current.y, moved: !!moved }; }
      else if (pointers.size === 2) beginPinch();
      else { gestureActive.current = false; if (moved) timer = setTimeout(() => { suppressClick.current = false; }, 100); }
    };
    const clear = () => { pointers.clear(); drag = pinch = null; suppressClick.current = gestureActive.current = false; clearTimeout(timer); setHoveredId(null); };
    const wheel = event => { event.preventDefault(); setHoveredId(null); zoomAt(transform.current.zoom * Math.exp(-event.deltaY * .0015), event.clientX, event.clientY); };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end); window.addEventListener('blur', clear);
    return () => {
      clear(); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('wheel', wheel);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); window.removeEventListener('blur', clear);
    };
  }, [commitTransform, zoomAt, building, floor]);

  const activeId = hoveredId ?? focusedId;
  const rooms = useMemo(() => {
    const ordered = [...floorData.rooms.filter(room => room.type === 'corridor'), ...floorData.rooms.filter(room => room.type !== 'corridor')];
    const active = ordered.find(room => room.id === activeId);
    return active ? [...ordered.filter(room => room !== active), active] : ordered;
  }, [floorData, activeId]);
  const hover = (event, id) => {
    if (gestureActive.current || event.pointerType === 'touch') return;
    if (window.matchMedia && !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    setHoveredId(id);
  };
  const bubble = room => {
    const full = roomName(room), title = full.length > 29 ? `${full.slice(0, 28)}…` : full;
    const width = Math.max(84, Math.min(245, title.length * 7.3 + 24)), height = 32;
    const [vx, vy, vw] = floorData.view;
    const cx = Math.max(vx + width / 2 + 4, Math.min(vx + vw - width / 2 - 4, room.cx));
    const top = Math.max(vy + 4, room.cy - Math.min(30, (room.h || 40) / 2 + 9) - height);
    return <g className="room-bubble" transform={`translate(${cx - width / 2} ${top})`} aria-hidden="true" pointerEvents="none"><rect width={width} height={height} rx="10" /><path d={`M${width / 2 - 5} ${height - 1}l5 6 5-6`} /><text x={width / 2} y="20" textAnchor="middle">{title}</text></g>;
  };
  return <div className="canvas" id="canvas" ref={canvasRef}>
    <div className="grid" aria-hidden="true" />
    <div id="drawing" className={floorData.wide ? 'wide-map' : ''} ref={drawingRef}>
      <svg viewBox={floorData.view.join(' ')} role="group" aria-label={`${t('mapAria')}, ${t(building)}, ${floor === 0 ? t('basement') : t('floor', { n: floor })}`}>
        {rooms.map(room => {
          const narrow = room.type === 'terrace' || (room.w && room.w < 55);
          const title = room.number || (room.label === 'Помещение' ? t('roomShort') : room.label === 'Подсобное помещение' ? t('utilityShort') : roomLabel(room));
          const baseSize = room.number ? (floorData.wide ? 19 : 17) : narrow ? 10 : title.length > 14 ? 10 : floorData.wide ? 13 : 12;
          const size = room.w ? Math.max(6, Math.min(baseSize, room.w * 1.55 / title.length)) : baseSize;
          const service = !room.number && (room.type === 'stair' || room.type === 'wc');
          return <g key={room.id} className={`map-room${hoveredId === room.id ? ' is-hovered' : ''}${selectedId === room.id ? ' is-selected' : ''}`} data-room={room.id} data-type={room.type || 'room'} role="button" tabIndex="0" aria-label={roomName(room)} aria-pressed={selectedId === room.id}
            onPointerEnter={event => hover(event, room.id)} onPointerLeave={() => setHoveredId(current => current === room.id ? null : current)} onFocus={() => setFocusedId(room.id)} onBlur={() => setFocusedId(current => current === room.id ? null : current)}
            onClick={() => { if (!suppressClick.current) onSelect?.(room.id, { keyboard: false }); }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(room.id, { keyboard: true }); event.currentTarget.focus({ preventScroll: true }); } }}>
            <title>{roomName(room)}</title>
            <g className="room-visual" pointerEvents="none"><RoomShape room={room} className={`room ${room.type || ''}${selectedId === room.id ? ' selected' : ''}${room.partial ? ' partial' : ''}`} />{service ? <ServiceIcon room={room} wide={floorData.wide} /> : <text className="room-label" style={{ fontSize: `${size}px` }} x={room.cx} y={room.cy + 4}>{title}</text>}</g>
            <RoomShape room={room} className="room-hitbox" fill="transparent" stroke="none" />
            {activeId === room.id && bubble(room)}
          </g>;
        })}
        {floorData.rooms.filter(room => room.door && !room.partial).map(room => <circle key={`door-${room.id}`} cx={room.door[0]} cy={room.door[1]} r="3.3" fill="var(--door)" stroke="var(--hall)" strokeWidth="1" pointerEvents="none" />)}
        {routePoints?.length > 0 && <g className="route-overlay" pointerEvents="none"><polyline className="route-line" points={routePoints.map(point => point.join(',')).join(' ')} fill="none" stroke="var(--route)" strokeWidth={floorData.wide ? 5 : 4} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="8 6" /><circle className="route-marker" cx={routePoints[0][0]} cy={routePoints[0][1]} r="7" fill="var(--route-start)" stroke="var(--route-outline)" strokeWidth="2" /><circle className="route-marker" cx={routePoints.at(-1)[0]} cy={routePoints.at(-1)[1]} r="7" fill="var(--route-end)" stroke="var(--route-outline)" strokeWidth="2" /></g>}
      </svg>
    </div>
  </div>;
});

export default MapCanvas;
