import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import React, { act } from 'react';
import { parseHTML } from 'linkedom';
import maps from '../src/data.js';
import { makeTranslator } from '../src/i18n.js';

const project = new URL('../', import.meta.url);
const require = createRequire(new URL('package.json', project));

test('React MapCanvas handles hover, selection, viewport gestures and cleanup (20 checks)', async () => {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const saved = new Map();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let focused = null;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  window.matchMedia = () => ({ matches: true });
  const focusDescriptor = Object.getOwnPropertyDescriptor(window.Element.prototype, 'focus');
  window.Element.prototype.focus = function () { focused = this; this.dispatchEvent(new window.Event('focusin', { bubbles: true })); };
  let root, tempDir, modulePath;
  try {
    const { transformWithOxc } = await import(pathToFileURL(require.resolve('vite')).href);
    const source = fs.readFileSync(new URL('src/components/MapCanvas.jsx', project), 'utf8');
    const transformed = await transformWithOxc(source, 'MapCanvas.jsx', { jsx: { runtime: 'automatic' } });
    const compiled = transformed.code
      .replace(/from (["'])react\1/g, `from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)}`)
      .replace(/from (["'])react\/jsx-runtime\1/g, `from ${JSON.stringify(pathToFileURL(require.resolve('react/jsx-runtime')).href)}`);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdu-mapcanvas-test-'));
    modulePath = path.join(tempDir, 'MapCanvas.mjs');
    fs.writeFileSync(modulePath, compiled);
    const { default: MapCanvas } = await import(pathToFileURL(modulePath).href);
    const { createRoot } = await import('react-dom/client');
    const ref = React.createRef(), zoom = [], selections = [];
    root = createRoot(document.getElementById('root'));
    let props = { floorData: maps.five.floors[3], building: 'five', floor: 3, selectedId: null, routePoints: null, roomName: room => room.number ? `Кабинет ${room.number}` : room.label, roomLabel: room => room.label, t: makeTranslator('ru'), onSelect: (...args) => selections.push(args), onZoomChange: value => zoom.push(value) };
    const render = async patch => { props = { ...props, ...patch }; await act(() => root.render(React.createElement(MapCanvas, { ...props, ref }))); };
    let checks = 0;
    const ok = (value, message) => { assert.ok(value, message); checks++; };
    const fire = async (target, type, attrs = {}) => { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, attrs); await act(() => target.dispatchEvent(event)); return event; };
    await render({});
    const canvas = document.getElementById('canvas'), drawing = document.getElementById('drawing');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 800 });
    drawing.getBoundingClientRect = () => ({ left: 100, top: 100, width: 500, height: 400 });
    const captured = []; canvas.setPointerCapture = id => captured.push(id);
    ok(document.querySelectorAll('.map-room').length === props.floorData.rooms.length, 'All rooms render');
    const id = props.floorData.rooms.find(room => room.number === '305').id;
    const group = document.querySelector(`[data-room="${id}"]`);
    ok(group.querySelector('.room-hitbox') && group.querySelector('.room-visual'), 'Stable hit area and independent visual');
    await fire(group, 'pointerover', { pointerType: 'mouse', relatedTarget: null });
    ok(group.classList.contains('is-hovered') && group.querySelector('.room-bubble'), 'Fine-pointer hover shows bubble');
    ok(document.querySelector('svg[role="group"]').querySelectorAll('.map-room').item(props.floorData.rooms.length - 1) === group, 'Hovered room raised last');
    await fire(group, 'pointerout', { pointerType: 'mouse', relatedTarget: null });
    await fire(group, 'pointerover', { pointerType: 'touch', relatedTarget: null });
    ok(!group.classList.contains('is-hovered'), 'Touch does not leave hover state');
    await fire(group, 'keydown', { key: 'Enter' });
    ok(selections.at(-1)?.[0] === id && selections.at(-1)?.[1].keyboard, 'Keyboard reports selected room');
    await render({ selectedId: id });
    ok(document.querySelector(`[data-room="${id}"]`) === group && group.classList.contains('is-selected'), 'Selection preserves keyed SVG node and focus');
    await act(() => ref.current.focusRoom(id)); ok(document.activeElement === group, 'Imperative focus restores room');
    await act(() => ref.current.zoomIn()); ok(Math.abs(zoom.at(-1) - 1.2) < .001, 'Imperative zoom updates root label');
    await act(() => ref.current.reset()); ok(zoom.at(-1) === 1 && drawing.style.transform.includes('translate(0px,0px)'), 'Reset fits map');
    await fire(group, 'pointerdown', { button: 0, pointerId: 1, clientX: 300, clientY: 300 });
    ok(!captured.length, 'Tap keeps native room click target');
    await fire(window, 'pointermove', { pointerId: 1, clientX: 325, clientY: 340 });
    ok(captured.includes(1) && drawing.style.transform.includes('translate(25px,40px)'), 'Drag capture and pan after threshold');
    const before = selections.length; await fire(group, 'click'); ok(selections.length === before, 'Drag suppresses room click');
    await fire(window, 'blur');
    await fire(group, 'pointerdown', { button: 0, pointerId: 2, clientX: 300, clientY: 300 });
    await fire(group, 'pointerdown', { button: 0, pointerId: 3, clientX: 400, clientY: 300 });
    await fire(window, 'pointermove', { pointerId: 3, clientX: 500, clientY: 300 });
    ok(zoom.at(-1) === 2, 'Two-pointer pinch scales map');
    await fire(window, 'pointerup', { pointerId: 3 });
    const previous = drawing.style.transform; await fire(window, 'pointermove', { pointerId: 2, clientX: 320, clientY: 300 }); ok(drawing.style.transform !== previous, 'Pinch continues as one-finger pan');
    await fire(window, 'pointercancel', { pointerId: 2 }); await fire(window, 'blur');
    const wheel = await fire(canvas, 'wheel', { deltaY: -100000, clientX: 400, clientY: 400 }); ok(wheel.defaultPrevented && zoom.at(-1) === 5, 'Wheel is intercepted and max zoom clamped');
    await fire(canvas, 'wheel', { deltaY: 100000, clientX: 400, clientY: 400 }); ok(zoom.at(-1) === .5, 'Min zoom clamped');
    await render({ floor: 4, floorData: maps.five.floors[4], selectedId: null }); ok(zoom.at(-1) === 1 && drawing.style.transform.includes('translate(0px,0px)'), 'Floor change resets viewport');
    await render({ routePoints: [[10, 20], [30, 40]] });
    ok(document.querySelector('.route-overlay').getAttribute('pointer-events') === 'none' && document.querySelector('.route-line').getAttribute('points') === '10,20 30,40', 'Route geometry stays outside room animation');
    await act(() => root.unmount()); root = null;
    const count = zoom.length; await fire(window, 'pointermove', { pointerId: 2, clientX: 500, clientY: 500 }); ok(zoom.length === count, 'Unmount removes gesture listeners');
    assert.equal(checks, 20);
  } finally {
    if (root) await act(() => root.unmount());
    if (modulePath && fs.existsSync(modulePath)) fs.unlinkSync(modulePath);
    if (tempDir && fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    if (focusDescriptor) Object.defineProperty(window.Element.prototype, 'focus', focusDescriptor);
    else delete window.Element.prototype.focus;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
