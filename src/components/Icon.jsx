import React from 'react';

const shapes = {
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  swap: <path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" />,
  route: <><circle cx="5" cy="5" r="2" /><circle cx="19" cy="19" r="2" /><path d="M5 7v7a5 5 0 0 0 5 5h7M10 5h9v8m-4-4 4 4 4-4" /></>,
  pin: <><circle cx="12" cy="9" r="3" /><path d="M19 9c0 6-7 12-7 12S5 15 5 9a7 7 0 1 1 14 0Z" /></>,
  room: <path d="M5 21V3h13v18M3 21h18M14 12h.01" />,
  stair: <path d="M3 20h5v-5h5v-5h5V5h3M4 9V3h6M4 3l8 8" />,
  wc: <><circle cx="7" cy="5" r="2" /><circle cx="17" cy="5" r="2" /><path d="M5 10h4v6H5zm2 6v5m10-11-3 7h6zm0 7v4" /></>,
  shower: <path d="m5 4 5 5m-6 2 7-7m1 6 1 1m2 2 1 1m-7-1 1 1m2 2 1 1m-7-1 1 1m2 2 1 1" />,
  corridor: <path d="M3 8h18M3 16h18m-5-7 3 3-3 3m-8-6-3 3 3 3" />,
  hall: <path d="M3 21h18M5 21V9l7-4 7 4v12M9 21v-7h6v7M3 9h18" />,
  library: <path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14" />,
  lab: <path d="M9 3h6m-5 0v7L4 19a1.3 1.3 0 0 0 1 2h14a1.3 1.3 0 0 0 1-2l-6-9V3M7 15h10" />,
  dining: <path d="M5 3v7m3-7v7m3-7v7M5 7h6m-3 3v11M19 3c-3 3-3 7 0 9V3Zm0 9v9" />,
  terrace: <path d="M3 21h18M5 21v-7m7 7V4m7 17v-7M3 14h18M6 7h12l-6-4-6 4Z" />,
  five: <path d="M4 21V8h16v13M2 21h20M8 8V3h8v5M8 12h1m6 0h1m-8 4h1m6 0h1m-5 5v-4h2v4" />,
  seven: <path d="M5 21V7l7-4 7 4v14M2 21h20M9 21v-5h6v5M9 8h1m4 0h1m-6 4h1m4 0h1" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  moon: <path d="M20 15.3A8.5 8.5 0 0 1 8.7 4a8.5 8.5 0 1 0 11.3 11.3Z" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
  plus: <path d="M5 12h14M12 5v14" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8m-4-4v8" />,
};

export function Icon({ type = 'room', className = 'ui-icon', ...props }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{shapes[type] || shapes.room}</svg>;
}
export function roomIconType(r) {
  if (r.label === 'Душевая') return 'shower';
  if (['stair', 'wc', 'terrace'].includes(r.type)) return r.type;
  if (/Библиотека|Читальный/.test(r.label)) return 'library';
  if (r.label === 'Лаборатория') return 'lab';
  if (/Столовая|Кухня|Моечная/.test(r.label)) return 'dining';
  if (r.type === 'corridor') return /Холл|Вестибюль/.test(r.label) ? 'hall' : 'corridor';
  return 'room';
}
