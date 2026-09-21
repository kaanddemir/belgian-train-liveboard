import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getStations, searchStations } from '../services/irail.js';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

// One dialog, two faces. Opening the search button always lands on the
// picker as it has always been; From -> To is a secondary action beneath
// it, and it swaps the contents of the same panel rather than opening
// anything new.
const STATION = 'station';
const ROUTE = 'route';

// How long the outgoing face is given to fade out before the incoming one
// is mounted. Matches --transition-fast, which is what styles.css runs the
// exit animation at; the two have to stay in step.
const EXIT_MS = 140;

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function StationModal({
  open, onClose, onSelect, onRoute, t, lang = 'nl',
  currentStation = null, destination = null,
}) {
  const [stations, setStations] = useState(null);   // { lang, list }
  const [mode, setMode] = useState(STATION);
  // The face currently animating out, or null. Only ever set for the
  // length of the exit animation.
  const [exiting, setExiting] = useState(false);
  // The first face of an opening is not animated: the panel already rises
  // on its own, and animating its contents at the same time reads as two
  // separate movements.
  const [swapped, setSwapped] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);

  // Route mode holds canonical station objects, never the typed text. The
  // query strings are only what is in the two fields; a field with no
  // object behind it cannot be applied.
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [fromQuery, setFromQuery] = useState('');
  const [toQuery, setToQuery] = useState('');
  const [field, setField] = useState('to');        // which route field is being edited

  const inputRef = useRef(null);
  const fromRef = useRef(null);
  const toRef = useRef(null);
  const listRef = useRef(null);
  const dialogRef = useRef(null);
  const openerRef = useRef(null);
  const routeLinkRef = useRef(null);
  const exitTimer = useRef(0);
  // Whether the user has touched the From field during this opening. The
  // default origin is seeded from the board's station, which is only
  // fully resolved once /stations lands — without this the list arriving
  // mid-typing would overwrite what the user had entered.
  const fromTouched = useRef(false);

  // The station list is only worth fetching once the picker is opened —
  // and again whenever the language changes, since the names are
  // translated. getStations caches each language, so this is one call.
  const loaded = stations?.lang === lang;
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    getStations(lang)
      .then((list) => { if (!cancelled) setStations({ lang, list }); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, loaded, lang]);

  // Every opening is the station picker, with the caret already in the
  // field — never the route form, however far the last one got. Only a
  // filter the board is actually applying is carried back in.
  useEffect(() => {
    if (!open) return;
    setMode(STATION);
    setExiting(false);
    setSwapped(false);
    setQuery('');
    setActive(0);
    setFailed(false);
    setTo(destination);
    setToQuery(destination?.name || '');
    setField('to');
    fromTouched.current = false;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
    // `destination` is read as the opening value only: changing the live
    // filter must not reset a form the user is already filling in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => clearTimeout(exitTimer.current), []);

  // The board's own station is the default origin. It is resolved out of
  // the real station list by id, so a station that the URL only named by
  // slug still arrives here as a full, canonical object.
  const boardStation = useMemo(() => {
    if (!currentStation?.id) return null;
    return stations?.list.find((s) => s.id === currentStation.id)
      || (currentStation.name ? currentStation : null);
  }, [stations, currentStation]);

  useEffect(() => {
    if (!open || fromTouched.current) return;
    setFrom(boardStation);
    setFromQuery(boardStation?.name || '');
  }, [open, boardStation]);

  /* --- swapping the two faces in place ----------------------------- */

  // The panel stays exactly where it is: only its contents cross over.
  // Under reduced motion the swap is immediate, which loses the movement
  // and nothing else.
  const goTo = useCallback((target) => {
    clearTimeout(exitTimer.current);
    const arrive = () => {
      setMode(target);
      setExiting(false);
      setSwapped(true);
      requestAnimationFrame(() => {
        // From is already filled in, so the destination is what is being
        // asked for; coming back, focus returns to the control that left.
        if (target === ROUTE) (toRef.current || fromRef.current)?.focus();
        else routeLinkRef.current?.focus();
      });
    };
    if (prefersReducedMotion()) { arrive(); return; }
    setExiting(true);
    exitTimer.current = setTimeout(arrive, EXIT_MS);
  }, []);

  /* --- focus trap, Escape, scroll lock ----------------------------- */

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) ?? [])];
      if (!controls.length) return;
      const first = controls[0];
      const last = controls.at(-1);
      if (e.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    // The board scrolls on phones; hold it still behind the overlay.
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
      const opener = openerRef.current;
      requestAnimationFrame(() => opener?.isConnected && opener.focus?.());
    };
  }, [open, onClose]);

  // One search, whichever face is asking: the same cached list, the same
  // ranking. Route mode searches for the field currently being edited, and
  // a field that already holds a station is not searching for one.
  const routeQuery = field === 'from' ? fromQuery : toQuery;
  const routeSelected = field === 'from' ? from : to;
  const term = mode === ROUTE ? (routeSelected ? '' : routeQuery) : query;
  const results = useMemo(
    () => (loaded ? searchStations(stations.list, term) : []),
    [loaded, stations, term]);

  // Keep the highlighted row in view when the arrow keys run past the edge.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  if (!open) return null;

  /* --- picking a station: unchanged behaviour ---------------------- */

  const choose = (station) => { onSelect(station); onClose(); };

  /* --- route mode --------------------------------------------------- */

  const pickRoute = (station) => {
    if (field === 'from') {
      fromTouched.current = true;
      setFrom(station);
      setFromQuery(station.name);
      setField('to');
      requestAnimationFrame(() => toRef.current?.focus());
    } else {
      setTo(station);
      setToQuery(station.name);
    }
    setActive(0);
  };

  const routeReady = Boolean(from && to && from.id !== to.id);
  const applyRoute = () => {
    if (!routeReady) return;
    onRoute(from, to);
    onClose();
  };

  /* --- keyboard ------------------------------------------------------ */

  const onListKeyDown = (e, commit) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (results.length ? (i + step + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = results[active] || results[0];
      if (picked) commit(picked);
      else if (mode === ROUTE) applyRoute();
    }
  };

  const status = failed
    ? t.listFailed
    : !loaded
      ? t.loading
      : term && !results.length
        ? t.noResults
        : null;

  const suggestions = (commit) => (
    results.length > 0 && (
      <ul className="station-results" id="station-results" role="listbox" ref={listRef}>
        {results.map((station, i) => (
          <li
            key={station.id}
            id={`station-option-${i}`}
            role="option"
            aria-selected={i === active}
            className={`station-result${i === active ? ' is-active' : ''}`}
            onMouseEnter={() => setActive(i)}
            // mousedown, not click: the input must not blur first
            onMouseDown={(e) => { e.preventDefault(); commit(station); }}
          >
            {station.name}
          </li>
        ))}
      </ul>
    )
  );

  const faceClass = `station-face station-face--${mode}`
    + (swapped ? ' is-entering' : '')
    + (exiting ? ' is-leaving' : '');

  return (
    <div
      className="station-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="station-modal"
        role="dialog"
        aria-modal="true"
        aria-label={mode === ROUTE ? t.modeRoute : t.pick}
      >
        {mode === STATION ? (
          <div className={faceClass} key={STATION}>
            <div className="station-field">
              <input
                ref={inputRef}
                className="station-input"
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                onKeyDown={(e) => onListKeyDown(e, choose)}
                placeholder={t.search}
                aria-label={t.search}
                autoComplete="off"
                spellCheck="false"
                role="combobox"
                aria-expanded={results.length > 0}
                aria-controls={results.length ? 'station-results' : undefined}
                aria-activedescendant={results.length ? `station-option-${active}` : undefined}
              />
              <svg className="station-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" />
                <line x1="15.8" y1="15.8" x2="20" y2="20" />
              </svg>
            </div>

            {status && <p className="station-status" role="status" aria-live="polite">{status}</p>}

            {suggestions(choose)}

            {/* The second thing the search button can do, offered rather
                than asked about: the picker is already usable above it. */}
            <button
              type="button"
              ref={routeLinkRef}
              className="station-route-link"
              onClick={() => goTo(ROUTE)}
            >
              <svg className="station-route-link__icon" viewBox="0 0 24 24" aria-hidden="true">
                <line x1="3.5" y1="12" x2="18" y2="12" />
                <polyline points="13.5 7 18.5 12 13.5 17" />
              </svg>
              <span className="station-route-link__text">
                <span className="station-route-link__label">{t.modeRoute}</span>
                <span className="station-route-link__hint">{t.modeRouteHint}</span>
              </span>
            </button>
          </div>
        ) : (
          <div className={faceClass} key={ROUTE}>
            <div className="station-modal__bar">
              <button type="button" className="station-back" onClick={() => goTo(STATION)}>
                <svg className="station-back__icon" viewBox="0 0 24 24" aria-hidden="true">
                  <polyline points="14.5 5 7.5 12 14.5 19" />
                </svg>
                {t.back}
              </button>
            </div>

            {[
              { key: 'from', label: t.fromLabel, value: fromQuery, ref: fromRef, station: from },
              { key: 'to', label: t.toLabel, value: toQuery, ref: toRef, station: to },
            ].map((row) => (
              <div key={row.key} className="station-route__row">
                <label className="station-route__label" htmlFor={`station-route-${row.key}`}>
                  {row.label}
                </label>
                <div className={`station-field station-field--row${row.station ? ' is-set' : ''}`}>
                  <input
                    id={`station-route-${row.key}`}
                    ref={row.ref}
                    className="station-input"
                    type="text"
                    value={row.value}
                    onFocus={() => { setField(row.key); setActive(0); }}
                    onChange={(e) => {
                      const v = e.target.value;
                      // Typing invalidates the station behind the field:
                      // only a picked result is ever committed.
                      if (row.key === 'from') {
                        fromTouched.current = true;
                        setFromQuery(v);
                        setFrom(null);
                      } else { setToQuery(v); setTo(null); }
                      setField(row.key);
                      setActive(0);
                    }}
                    onKeyDown={(e) => onListKeyDown(e, pickRoute)}
                    placeholder={t.search}
                    autoComplete="off"
                    spellCheck="false"
                    role="combobox"
                    aria-expanded={field === row.key && results.length > 0}
                    aria-controls={field === row.key && results.length ? 'station-results' : undefined}
                    aria-activedescendant={field === row.key && results.length
                      ? `station-option-${active}` : undefined}
                  />
                </div>
                {field === row.key && suggestions(pickRoute)}
              </div>
            ))}

            {status && <p className="station-status" role="status" aria-live="polite">{status}</p>}

            <button
              type="button"
              className="station-apply"
              disabled={!routeReady}
              onClick={applyRoute}
            >
              {t.showDepartures}
            </button>
            <p className="station-route__note">{t.directOnly}</p>
          </div>
        )}
      </div>
    </div>
  );
}
