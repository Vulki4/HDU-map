import { useEffect, useRef, useState } from 'react';

const pointKey = point => `${point?.building ?? ''}:${point?.floor ?? ''}:${point?.id ?? ''}`;

/** Controlled room picker shared by campus search and the two route endpoints. */
export default function SearchPicker({
  id,
  label,
  placeholder,
  value = '',
  onChange,
  results = [],
  onSelect,
  selectedPoint = null,
  meta = '',
  emptyText,
  loading = false,
  onRetry,
  t,
  roomName,
  placeMeta,
  icon,
  compact = false,
  destination = false,
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapperRef = useRef(null);
  const optionRefs = useRef(new Map());
  const listId = `${id}-results`;
  const metaId = `${id}-meta`;
  const activeId = open && active >= 0 && active < results.length ? `${listId}-${active}` : undefined;

  function close() {
    setOpen(false);
    setActive(-1);
  }

  useEffect(() => {
    const outside = event => {
      if (!wrapperRef.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, []);

  useEffect(() => { setActive(-1); }, [results]);

  useEffect(() => {
    if (open && active >= 0) optionRefs.current.get(active)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  function choose(point) {
    if (!point) return;
    close();
    onSelect?.(point);
  }

  function handleKeyDown(event) {
    if (event.nativeEvent?.isComposing || event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (!results.length) { setActive(-1); return; }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActive(previous => !open || previous < 0
        ? direction === 1 ? 0 : results.length - 1
        : (previous + direction + results.length) % results.length);
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      if (results.length) choose(results[active < 0 ? 0 : active]);
    } else if (event.key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); }
      close();
    } else if (event.key === 'Tab') {
      close();
    }
  }

  const field = (
    <input
      id={id}
      type="text"
      value={value}
      placeholder={placeholder}
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      enterKeyHint="search"
      role="combobox"
      aria-label={!compact ? label || t('searchAria') : undefined}
      aria-autocomplete="list"
      aria-busy={loading}
      maxLength={120}
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={activeId}
      aria-describedby={meta ? metaId : undefined}
      onChange={event => {
        const next = event.target.value;
        setActive(-1);
        setOpen(compact || !!next.trim());
        onChange?.(next);
      }}
      onFocus={() => {
        if (compact || value.trim()) { setOpen(true); setActive(-1); }
      }}
      onKeyDown={handleKeyDown}
    />
  );

  return (
    <div
      ref={wrapperRef}
      className={compact ? 'endpoint' : 'search'}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      {compact && label && <label htmlFor={id}>{label}</label>}
      {compact ? (
        <div className="endpoint-input">
          <span className={`endpoint-dot${destination ? ' destination' : ''}`} aria-hidden="true" />
          {field}
        </div>
      ) : (
        <>
          <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
          {field}
          <kbd aria-hidden="true">/</kbd>
        </>
      )}
      {meta && <small id={metaId}>{meta}</small>}
      <div id={listId} className="suggestions" role="listbox" aria-label={label || t('results')} hidden={!open}>
        {results.length ? results.map((point, index) => (
          <button
            key={pointKey(point) || index}
            ref={node => {
              if (node) optionRefs.current.set(index, node);
              else optionRefs.current.delete(index);
            }}
            id={`${listId}-${index}`}
            type="button"
            tabIndex={-1}
            role="option"
            aria-selected={index === active}
            className={index === active ? 'active' : ''}
            data-result={index}
            data-selected={selectedPoint && pointKey(point) === pointKey(selectedPoint) ? 'true' : undefined}
            onPointerDown={event => event.preventDefault()}
            onClick={() => choose(point)}
          >
            {icon && <span className="suggestion-icon" aria-hidden="true">{icon(point)}</span>}
            <span className="suggestion-copy"><b className="suggestion-title">{roomName(point)}</b><small className="suggestion-meta">{placeMeta(point)}</small></span>
          </button>
        )) : (
          <div className="search-empty" role="status"><p>{emptyText || t(compact ? 'noRouteResults' : 'noResults')}</p>{onRetry&&<button type="button" className="search-retry" onClick={onRetry}>{t('retry')}</button>}</div>
        )}
      </div>
    </div>
  );
}
