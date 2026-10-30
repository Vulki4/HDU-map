import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROOM_KK, makeTranslator } from './i18n.js';
import { buildCatalog, keyOf } from './map-core.js';
import { loadMaps, createRoute } from './api-client.js';
import useRoomSearch from './hooks/useRoomSearch.js';
import { Icon, roomIconType } from './components/Icon.jsx';
import SearchPicker from './components/SearchPicker.jsx';
import RoutePlanner from './components/RoutePlanner.jsx';
import MapCanvas from './components/MapCanvas.jsx';

const storage = { get(key) { try { return localStorage.getItem(key); } catch { return null; } }, set(key,value) { try { localStorage.setItem(key,value); } catch {} } };
const pointIcon = point => <Icon type={roomIconType(point)} />;
export function readView(search, maps) {
  const params = new URLSearchParams(search);
  const building = Object.hasOwn(maps,params.get('building')) ? params.get('building') : 'seven';
  const wanted = Number(params.get('floor') ?? 1);
  return { building, floor: Object.hasOwn(maps[building].floors,wanted) ? wanted : 1, language: ['ru','kk'].includes(params.get('lang')) ? params.get('lang') : storage.get('hdu-language') === 'kk' ? 'kk' : 'ru', planner: params.get('planner') === '1' };
}
export function viewURL(view) {
  const params = new URLSearchParams({building:view.building,floor:String(view.floor),lang:view.language});
  if (view.planner) params.set('planner','1');
  return `?${params}`;
}

export default function App() {
  const [bootstrap,setBootstrap] = useState({maps:null,error:null,revision:null});
  const [attempt,setAttempt] = useState(0);
  const language = new URLSearchParams(location.search).get('lang') || storage.get('hdu-language') || 'ru';
  const t = makeTranslator(language==='kk'?'kk':'ru');
  useEffect(()=>{
    let controller,closed=false;
    const refresh=()=>{
      controller?.abort();
      const request=new AbortController();controller=request;
      loadMaps({signal:request.signal}).then(response=>{
        if(!closed&&!request.signal.aborted)setBootstrap(current=>current.revision===response.revision?current:{maps:response.data,error:null,revision:response.revision});
      }).catch(error=>{
        if(!closed&&!request.signal.aborted)setBootstrap(current=>current.maps?current:{maps:null,error,revision:null});
      });
    };
    setBootstrap({maps:null,error:null,revision:null});refresh();
    const onStorage=event=>{if(event.key==='hdu-map-revision')refresh();};
    const onVisible=()=>{if(document.visibilityState==='visible')refresh();};
    window.addEventListener('focus',refresh);
    window.addEventListener('storage',onStorage);
    window.addEventListener('hdu-map-updated',refresh);
    document.addEventListener('visibilitychange',onVisible);
    return()=>{closed=true;controller?.abort();window.removeEventListener('focus',refresh);window.removeEventListener('storage',onStorage);window.removeEventListener('hdu-map-updated',refresh);document.removeEventListener('visibilitychange',onVisible);};
  },[attempt]);
  useEffect(()=>{
    document.documentElement.lang=language==='kk'?'kk':'ru';
    document.title=t('title');
    document.body.classList.toggle('light',storage.get('hdu-theme-emerald-gold')!=='dark');
  },[language]);
  if(bootstrap.maps)return <CampusApp maps={bootstrap.maps} revision={bootstrap.revision} />;
  return <main className="bootstrap-state" data-state={bootstrap.error?'error':'loading'}>
    <img src="/assets/hdu-logo.png" width="72" height="72" alt={t('logo')} />
    <h1>{t('title')}</h1>
    <p role="status" aria-live="polite">{t(bootstrap.error?'loadError':'loadingMap')}</p>
    {bootstrap.error?<button id="retryBootstrap" type="button" className="primary" onClick={()=>setAttempt(value=>value+1)}>{t('retry')}</button>:<span className="loading-orbit" aria-hidden="true" />}
  </main>;
}

export function CampusApp({maps,revision}) {
  const catalog = useMemo(()=>buildCatalog(maps),[maps]);
  const [view,setView] = useState(()=>readView(location.search,maps));
  const viewRef = useRef(view);
  viewRef.current=view;
  const [theme,setTheme] = useState(()=>storage.get('hdu-theme-emerald-gold') === 'dark' ? 'dark' : 'light');
  const [selected,setSelected] = useState(null);
  const [query,setQuery] = useState('');
  const [points,setPoints] = useState({from:null,to:null});
  const [texts,setTexts] = useState({from:'',to:''});
  const [route,setRoute] = useState(null);
  const [message,setMessage] = useState('');
  const [routing,setRouting] = useState(false);
  const [zoom,setZoom] = useState(1);
  const [about,setAbout] = useState(false);
  const mapRef = useRef(null), dialogRef = useRef(null);
  const routeRequest = useRef({sequence:0,controller:null});
  const cancelRoute = useCallback(()=>{
    routeRequest.current.sequence++;
    routeRequest.current.controller?.abort();
    routeRequest.current.controller=null;
    setRouting(false);
  },[]);
  useEffect(()=>()=>routeRequest.current.controller?.abort(),[]);
  const t = useMemo(()=>makeTranslator(view.language),[view.language]);
  const floorName = useCallback(f=>Number(f)===0 ? t('basement') : t('floor',{n:f}),[t]);
  const roomLabel = useCallback(r=>view.language === 'kk' ? r.labelKk || ROOM_KK[r.label] || r.labelRu || r.label : r.labelRu || r.label,[view.language]);
  const roomName = useCallback(r=>r.number ? t('room',{n:r.number}) : roomLabel(r),[t,roomLabel]);
  const placeMeta = useCallback(r=>`${t(r.building)} · ${floorName(r.floor)}${r.number ? '' : ' · '+t('planId',{n:r.id})}`,[t,floorName]);
  const floorData = maps[view.building].floors[view.floor];
  useEffect(()=>{
    setPoints(current=>Object.fromEntries(['from','to'].map(side=>[side,current[side]?catalog.find(point=>keyOf(point)===keyOf(current[side]))||null:null])));
  },[catalog]);
  const selectedPoint = catalog.find(r=>r.building===view.building && r.floor===view.floor && r.id===selected);
  const navigate = useCallback((patch,push=false)=>{
    // A route response may arrive after the language or planner state changed.
    const next = {...viewRef.current,...patch};
    const url = viewURL(next);
    if (push && url !== location.search) history.pushState(null,'',url);
    else history.replaceState(null,'',url);
    viewRef.current=next;setView(next);
  },[]);

  useEffect(()=>{
    document.documentElement.lang=view.language; document.title=t('title');
    document.body.classList.toggle('light',theme==='light');
    document.body.classList.toggle('planner-open',view.planner);
    document.body.classList.toggle('has-selection',!!selectedPoint);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='light'?'#f5f8f5':'#0b130f');
    storage.set('hdu-language',view.language); storage.set('hdu-theme-emerald-gold',theme);
    history.replaceState(null,'',viewURL(view));
  },[view,theme,t,selectedPoint]);
  useEffect(()=>{
    const onPop=()=>{cancelRoute();const next=readView(location.search,maps);if(next.building!==view.building){setRoute(null);setMessage('');}setSelected(null);viewRef.current=next;setView(next);};
    window.addEventListener('popstate',onPop);return()=>window.removeEventListener('popstate',onPop);
  },[view.building,maps,cancelRoute]);
  useEffect(()=>{
    setTexts(current=>({from:points.from?roomName(points.from):current.from,to:points.to?roomName(points.to):current.to}));
  },[roomName,points]);
  useEffect(()=>{
    const dialog=dialogRef.current;
    if(about && !dialog.open) dialog.showModal(); else if(!about && dialog.open) dialog.close();
  },[about]);
  const closeSelection = useCallback(()=>{
    const id=selected;setSelected(null);
    if(id!==null) requestAnimationFrame(()=>mapRef.current?.focusRoom(id));
  },[selected]);
  useEffect(()=>{
    const onKey=event=>{
      if(event.key==='/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||'')){event.preventDefault();document.getElementById('search')?.focus();}
      if(event.key==='Escape' && !about && !event.target.closest?.('[role="combobox"]')) closeSelection();
    };
    document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey);
  },[about,closeSelection]);

  const search = useRoomSearch(query,{building:view.building,floor:view.floor,revision,enabled:!!query.trim()});
  const fromSearch = useRoomSearch(texts.from,{building:view.building,floor:view.floor,revision,routeOnly:true,enabled:view.planner,selectedPoint:points.from});
  const toSearch = useRoomSearch(texts.to,{building:view.building,floor:view.floor,revision,routeOnly:true,enabled:view.planner,selectedPoint:points.to});
  const searchState = state => state.loading?t('searchLoading'):state.error?t(state.error.errorKey||'searchError'):null;
  const endpointResults = {from:fromSearch.results,to:toSearch.results};
  const chooseEndpoint = (side,point,fromMap=false)=>{
    cancelRoute();
    const next={...points,[side]:point};setPoints(next);setTexts(current=>({...current,[side]:roomName(point)}));setRoute(null);setMessage('');
    if(fromMap){navigate({planner:true});setSelected(null);setMessage(next.from&&next.to?'':side==='from'?'fromChosen':'toChosen');requestAnimationFrame(()=>document.getElementById(next.from&&next.to?'buildRoute':side==='from'?'routeTo':'routeFrom')?.focus());}
  };
  const editEndpoint = (side,value)=>{cancelRoute();setTexts(current=>({...current,[side]:value}));setPoints(current=>({...current,[side]:null}));setRoute(null);setMessage('');};
  const build = async (chosen=points)=>{
    cancelRoute();
    const {from,to}=chosen;
    const error=!from||!to?'chooseBoth':from.building!==to.building?'crossBuilding':keyOf(from)===keyOf(to)?'samePoint':'';
    if(error){setMessage(error);setRoute(null);return;}
    const controller=new AbortController();
    const sequence=routeRequest.current.sequence;
    routeRequest.current.controller=controller;
    setRouting(true);setRoute(null);setMessage('');
    try{
      const {data:result}=await createRoute(from,to,{signal:controller.signal});
      if(controller.signal.aborted||routeRequest.current.sequence!==sequence)return;
      setRoute(result);navigate({building:from.building,floor:from.floor},true);setSelected(null);mapRef.current?.reset();
    }catch(error){
      if(!controller.signal.aborted&&routeRequest.current.sequence===sequence)setMessage(error.errorKey||'routeError');
    }finally{
      if(routeRequest.current.sequence===sequence){routeRequest.current.controller=null;setRouting(false);}
    }
  };
  const handleRoomSelect = useCallback((id,{keyboard=false}={})=>{setSelected(id);if(keyboard)requestAnimationFrame(()=>mapRef.current?.focusRoom(id));},[]);
  function selectBuilding(building){if(building===view.building)return;cancelRoute();navigate({building,floor:1},true);setSelected(null);setRoute(null);setMessage('');}
  function selectFloor(floor){cancelRoute();navigate({floor},true);mapRef.current?.reset();setSelected(route?.building===view.building&&route.targetFloor===floor?route.targetId:null);}
  function selectSearch(point){cancelRoute();navigate({building:point.building,floor:point.floor},true);mapRef.current?.reset();setSelected(point.id);setQuery('');if(route?.building!==point.building)setRoute(null);}
  const searchProps={t,roomName,placeMeta,icon:pointIcon};

  return <>
    <header className="app-header">
      <div className="topbar">
        <a className="brand" href="./" aria-label={t('brandAria')}><span className="logo"><img src="/assets/hdu-logo.png" alt={t('logo')} width="44" height="44" /></span><span className="brand-copy"><b>ХДУ<span className="brand-dot" aria-hidden="true">.</span></b><small>{t('brand')}</small></span></a>
        <SearchPicker {...searchProps} id="search" placeholder={t('searchPlaceholder')} value={query} onChange={setQuery} results={search.results} loading={search.loading} onSelect={selectSearch} emptyText={searchState(search)||t('noResults')} onRetry={search.error?search.retry:undefined} />
        <div className="header-actions"><div className="language-switch" role="group" aria-label={t('languages')}>{[['kk','ҚАЗ','Қазақша'],['ru','РУС','Русский']].map(([lang,label,aria])=><button key={lang} type="button" lang={lang} aria-label={aria} aria-pressed={view.language===lang} className={view.language===lang?'active':''} onClick={()=>navigate({language:lang})}>{label}</button>)}</div><button id="theme" className="icon-button" type="button" aria-label={t('theme')} title={t('theme')} onClick={()=>setTheme(theme==='light'?'dark':'light')}><Icon type={theme==='light'?'moon':'sun'} /></button><button id="about" className="icon-button" type="button" aria-label={t('about')} title={t('about')} onClick={()=>setAbout(true)}><Icon type="info" /></button></div>
      </div>
      <div className="map-toolbar"><nav id="buildings" aria-label={t('buildings')}>{['five','seven'].map(b=><button key={b} type="button" className={`corpus-button${view.building===b?' active':''}`} aria-pressed={view.building===b} onClick={()=>selectBuilding(b)}><span className="corpus-icon"><Icon type={b} /></span><b>{t(b)}</b><span className="corpus-active-dot" aria-hidden="true" /></button>)}</nav><span className="toolbar-divider" aria-hidden="true" /><div className="route-launcher"><button id="togglePlanner" type="button" className={route?'has-route':''} aria-expanded={view.planner} aria-controls="planner" onClick={()=>navigate({planner:!view.planner})}><Icon type="route" /><span>{t('route')}</span></button></div></div>
      <RoutePlanner open={view.planner} onClose={()=>{navigate({planner:false});requestAnimationFrame(()=>document.getElementById('togglePlanner')?.focus());}} points={points} texts={texts} results={endpointResults} searches={{from:fromSearch,to:toSearch}} busy={routing} onText={editEndpoint} onChoose={chooseEndpoint} onSwap={()=>{cancelRoute();const swapped={from:points.to,to:points.from};setPoints(swapped);setTexts({from:texts.to,to:texts.from});setMessage('');setRoute(null);if(route)void build(swapped);}} onBuild={()=>{void build();}} onClear={()=>{cancelRoute();setPoints({from:null,to:null});setTexts({from:'',to:''});setRoute(null);setMessage('');}} message={message} route={route} currentFloor={view.floor} onFloor={selectFloor} t={t} floorName={floorName} roomName={roomName} placeMeta={placeMeta} pointIcon={pointIcon} />
    </header>
    <main><section className="map-panel" aria-label={t('mapAria')}>
      <MapCanvas ref={mapRef} floorData={floorData} building={view.building} floor={view.floor} selectedId={selected} routePoints={route?.building===view.building?route.segments[view.floor]:null} roomName={roomName} roomLabel={roomLabel} t={t} onSelect={handleRoomSelect} onZoomChange={setZoom} />
      <div className="map-heading"><span className="eyebrow">{t(view.building)} · {t('floorMap')}</span><h1>{floorName(view.floor)}</h1><p className="map-context-help">{t('mapHint')}</p></div>
      <div className="map-hint">{t('hint')}</div>
      <div className="floor-rail"><span className="floor-caption">{t('floorCaption')}</span><div id="floors" aria-label={t('floors')}>{Object.keys(maps[view.building].floors).map(Number).sort((a,b)=>b-a).map(f=><button key={f} type="button" className={f===view.floor?'active':''} aria-label={floorName(f)} aria-pressed={f===view.floor} onClick={()=>selectFloor(f)}>{f===0?t('basementShort'):f}</button>)}</div></div>
      {selectedPoint && <section id="roomCard" className={`room-card${selectedPoint.partial?' is-partial':''}`} aria-label={t('selectedRoom')}><div className="sheet-handle" aria-hidden="true" /><button id="closeDetail" type="button" className="close-card icon-button" aria-label={t('closeCard')} onClick={closeSelection}><Icon type="close" /></button><div id="detail"><div className="detail-kicker"><span>{t('selectedRoomKicker')}</span><span className="badge">{floorName(view.floor)}</span></div><div className="detail-heading"><span className="room-icon"><Icon type={roomIconType(selectedPoint)} /></span><h3>{roomName(selectedPoint)}</h3></div><div className="detail-meta room-meta"><span>{t(view.building)}</span><span>{selectedPoint.number?roomLabel(selectedPoint):t('planId',{n:selectedPoint.id})}</span></div>{selectedPoint.partial?<p className="partial-message">{t('partial')}</p>:<div className="room-route-actions"><button id="chooseFrom" type="button" onClick={()=>chooseEndpoint('from',selectedPoint,true)}><Icon type="pin" /><span>{t('hereFrom')}</span></button><button id="chooseTo" type="button" className="primary" onClick={()=>chooseEndpoint('to',selectedPoint,true)}><Icon type="arrow" /><span>{t('hereTo')}</span></button></div>}</div></section>}
      <div className="zoom"><button id="minus" type="button" aria-label={t('minus')} onClick={()=>mapRef.current?.zoomOut()}><Icon type="minus" /></button><span id="zoomLabel">{Math.round(zoom*100)}%</span><button id="plus" type="button" aria-label={t('plus')} onClick={()=>mapRef.current?.zoomIn()}><Icon type="plus" /></button><span className="zoom-divider" aria-hidden="true" /><button id="reset" type="button" aria-label={t('fit')} onClick={()=>mapRef.current?.reset()}><Icon type="fit" /></button></div>
      <footer><div className="legend">{[['room','rooms'],['stair','stairs'],['wc','toilets']].map(([type,key])=><span className="legend-item" key={type}><span className={`key ${type}-key`} /><span>{t(key)}</span></span>)}</div><span className="footer-note">{t('footer')}</span></footer>
    </section></main>
    <dialog id="modal" ref={dialogRef} aria-label={t('about')} onClose={()=>setAbout(false)} onClick={event=>{if(event.target===event.currentTarget)setAbout(false);}}><button id="close" type="button" className="close icon-button" aria-label={t('close')} onClick={()=>setAbout(false)}><Icon type="close" /></button><div><h2>{t('aboutTitle')}</h2><p>{t('aboutText')}</p><p>{t('aboutLimits')}</p><p><a className="admin-entry-link" href={`/admin?${new URLSearchParams({building:view.building,floor:String(view.floor),lang:view.language})}`}>{t('adminPanel')}</a></p></div></dialog>
  </>;
}
