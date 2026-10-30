import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { parseHTML } from 'linkedom';
import { createServer } from 'vite';
import { makeTranslator } from '../src/i18n.js';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('React SearchPicker renders accessible controls and handles explicit selection', async t => {
  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div><button id="outside">Outside</button></body></html>');
  const saved = new Map();
  for (const [key,value] of Object.entries({window,document,HTMLElement:window.HTMLElement,Node:window.Node,Event:window.Event,IS_REACT_ACT_ENVIRONMENT:true})) {
    saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  // linkedom does not advertise native input support unless this property exists.
  // Set it before importing react-dom/client so React uses modern input events.
  document.oninput = null;
  let server, reactRoot;
  try {
    server = await createServer({root:project,server:{middlewareMode:true,hmr:false,ws:false},appType:'custom',logLevel:'error'});
    const { default: SearchPicker } = await server.ssrLoadModule('/src/components/SearchPicker.jsx');
    const { createRoot } = await import('react-dom/client');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const points = [
      {id:1,building:'seven',floor:2,number:'211'},
      {id:2,building:'seven',floor:2,number:'212'},
    ];
    let chosen = null, changed = null;
    const props = {
      id:'search',value:'21',onChange(value){changed=value;},results:points,onSelect(point){chosen=point;},
      t:makeTranslator('ru'),roomName:point=>`Кабинет ${point.number}`,placeMeta:()=> 'Б корпус · 2 этаж',
      icon:()=>React.createElement('span',null,'□'),
    };
    const fire = (target,type,extra={}) => {
      const event = new window.Event(type,{bubbles:true,cancelable:true});
      Object.assign(event,extra); target.dispatchEvent(event);
    };
    reactRoot = createRoot(document.getElementById('root'));
    const render = async next => { await act(async()=>reactRoot.render(React.createElement(SearchPicker,next))); };
    await render(props);

    await t.test('server markup supports both locales and labelled endpoint metadata', () => {
      for (const language of ['ru','kk']) {
        const translate = makeTranslator(language);
        const markup = renderToStaticMarkup(React.createElement(SearchPicker,{
          ...props,id:'route-to',label:translate('to'),placeholder:translate('toPlaceholder'),
          compact:true,destination:true,meta:translate('seven'),t:translate,
        }));
        const {document: ssr} = parseHTML(`<html><body>${markup}</body></html>`);
        assert.equal(ssr.querySelector('label').getAttribute('for'),'route-to');
        assert.equal(ssr.querySelector('label').textContent,translate('to'));
        assert.equal(ssr.querySelector('input').getAttribute('role'),'combobox');
        assert.equal(ssr.querySelector('input').getAttribute('aria-controls'),'route-to-results');
        assert.equal(ssr.querySelector('input').getAttribute('aria-describedby'),'route-to-meta');
        assert.equal(ssr.querySelector('#route-to-meta').textContent,translate('seven'));
        assert.ok(ssr.querySelector('.endpoint-dot.destination'));
        assert.ok(ssr.querySelector('[role="listbox"]').hasAttribute('hidden'));
      }
      assert.ok(document.querySelector('.search-icon'));
      assert.ok(document.querySelector('.suggestion-title'));
      assert.ok(document.querySelector('.suggestion-meta'));
    });

    await t.test('typing reports text without choosing a fabricated endpoint', async () => {
      const input = document.getElementById('search');
      input.setAttribute('value','22');
      await act(async()=>fire(input,'input'));
      assert.equal(changed,'22');
      assert.equal(chosen,null);
      await render(props);
    });

    await t.test('ArrowUp, ArrowDown and Enter select the explicit highlighted point', async () => {
      const input = document.getElementById('search');
      await act(async()=>fire(input,'focusin'));
      assert.equal(input.getAttribute('aria-expanded'),'true');
      await act(async()=>fire(input,'keydown',{key:'ArrowUp'}));
      assert.equal(input.getAttribute('aria-activedescendant'),'search-results-1');
      assert.equal(document.getElementById('search-results-1').getAttribute('aria-selected'),'true');
      await act(async()=>fire(input,'keydown',{key:'ArrowDown'}));
      assert.equal(input.getAttribute('aria-activedescendant'),'search-results-0');
      await act(async()=>fire(input,'keydown',{key:'Enter'}));
      assert.equal(chosen,points[0]);
      assert.equal(input.getAttribute('aria-expanded'),'false');
      assert.equal(input.hasAttribute('aria-activedescendant'),false);
    });

    await t.test('click selection closes suggestions and does not submit a surrounding form', async () => {
      const input = document.getElementById('search');
      await act(async()=>fire(input,'focusin'));
      const option = document.getElementById('search-results-1');
      assert.equal(option.getAttribute('type'),'button');
      await act(async()=>fire(option,'click'));
      assert.equal(chosen,points[1]);
      assert.equal(input.getAttribute('aria-expanded'),'false');
    });

    await t.test('Escape, Tab, outside pointer and outside focus close the open list', async () => {
      const input = document.getElementById('search');
      for (const key of ['Escape','Tab']) {
        await act(async()=>fire(input,'focusin'));
        await act(async()=>fire(input,'keydown',{key}));
        assert.equal(input.getAttribute('aria-expanded'),'false');
      }
      for (const event of ['pointerdown','focusin']) {
        await act(async()=>fire(input,'focusin'));
        await act(async()=>fire(document.getElementById('outside'),event));
        assert.equal(input.getAttribute('aria-expanded'),'false');
      }
    });

    await t.test('an empty match list announces the translated state and Enter selects nothing', async () => {
      chosen = null;
      await render({...props,value:'unknown',results:[],t:makeTranslator('kk')});
      const input = document.getElementById('search');
      await act(async()=>fire(input,'focusin'));
      assert.equal(document.querySelector('.search-empty p').textContent,makeTranslator('kk')('noResults'));
      assert.equal(document.querySelectorAll('[role="option"]').length,0);
      await act(async()=>fire(input,'keydown',{key:'Enter'}));
      assert.equal(chosen,null);
      assert.equal(input.hasAttribute('aria-activedescendant'),false);
    });
  } finally {
    if (reactRoot) await act(async()=>reactRoot.unmount());
    if (server) await server.close();
    for (const [key,descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  }
});
