import React from 'react';
import SearchPicker from './SearchPicker.jsx';
import { Icon } from './Icon.jsx';

export default function RoutePlanner({ open, onClose, points, texts, results, searches = {}, busy = false, onText, onChoose, onSwap, onBuild, onClear, message, route, currentFloor, onFloor, t, floorName, roomName, placeMeta, pointIcon }) {
  const floors = route?.ok ? Object.keys(route.segments).map(Number).sort((a,b)=>points.from.floor <= points.to.floor ? a-b : b-a) : [];
  const shared = { t, roomName, placeMeta, icon: pointIcon, compact: true, emptyText: t('noRouteResults') };
  const networkProps = side => ({loading:!!searches[side]?.loading,emptyText:searches[side]?.loading?t('searchLoading'):searches[side]?.error?t(searches[side].error.errorKey||'searchError'):t('noRouteResults'),onRetry:searches[side]?.error?searches[side].retry:undefined});
  return <section id="planner" className="route-planner" aria-label={t('routeTitle')} hidden={!open}>
    <div className="planner-heading"><span className="planner-mark"><Icon type="route" /></span><div className="planner-heading-copy"><p className="eyebrow">{t('plannerEyebrow')}</p><b>{t('routeTitle')}</b></div><button id="collapsePlanner" type="button" className="icon-button" aria-label={t('routeClose')} onClick={onClose}><Icon type="close" /></button></div>
    <form id="routeForm" autoComplete="off" onSubmit={event=>{event.preventDefault();onBuild();}}>
      <SearchPicker {...shared} {...networkProps('from')} id="routeFrom" label={t('from')} placeholder={t('fromPlaceholder')} value={texts.from} onChange={value=>onText('from',value)} results={results.from} selectedPoint={points.from} meta={points.from ? placeMeta(points.from) : ''} onSelect={point=>onChoose('from',point)} />
      <button id="swapRoute" type="button" className="swap-route icon-button" aria-label={t('swap')} title={t('swap')} onClick={onSwap}><Icon type="swap" /></button>
      <SearchPicker {...shared} {...networkProps('to')} id="routeTo" label={t('to')} placeholder={t('toPlaceholder')} value={texts.to} onChange={value=>onText('to',value)} results={results.to} selectedPoint={points.to} meta={points.to ? placeMeta(points.to) : ''} onSelect={point=>onChoose('to',point)} destination />
      <button id="buildRoute" type="submit" className="primary" disabled={busy} aria-busy={busy}><span>{t(busy?'routeLoading':'build')}</span><Icon type="arrow" /></button>
    </form>
    <div className="planner-bottom"><p id="plannerHint">{t('endpointHint')}</p><button id="clearRoute" type="button" onClick={onClear}>{t('clear')}</button></div>
    <div id="routeMessage" role="status" aria-live="polite">{message ? t(message) : ''}</div>
    <div id="routeSummary">{route?.ok && <>
      <div className="route-status" role="status"><Icon type="route" />{t('routeReady')} · {floors.length === 1 ? t('oneFloor') : t('floorCount',{n:floors.length})}</div>
      <ol className="route-steps"><li>{floorName(points.from.floor)} · {roomName(points.from)}</li><li>{points.from.floor===points.to.floor ? t('corridorStep') : points.to.floor===0 ? t('basementStep') : t('stairsStep',{n:points.to.floor})}</li><li>{floorName(points.to.floor)} · {roomName(points.to)}</li></ol>
      <div className="route-floor-links">{floors.map(f=><button key={f} type="button" aria-pressed={f===currentFloor} onClick={()=>onFloor(f)}>{floorName(f)}</button>)}</div><p className="route-note">{t('routeNote')}</p>
    </>}</div>
  </section>;
}
