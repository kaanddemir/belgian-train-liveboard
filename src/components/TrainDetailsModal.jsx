import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import DepartureRow, { formatTime } from './DepartureRow.jsx';

// The optional route map, and with it Leaflet, Leaflet's stylesheet and
// the Infrabel rail graph, are reached only through this dynamic import.
// Nothing about the map is in the board's initial bundle: the chunk is
// requested the first time a reader presses "open map", and never
// otherwise. Keep this the only reference to the module.
const TrainRouteMap = lazy(() => import('./TrainRouteMap.jsx'));

const PHONE_QUERY = '(max-width: 599px)';
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/* ------------------------------------------------------------------
   Train details — one more SNCB screen, laid over the board.

   Three sections, and nothing else:
     1. the clicked departure, drawn by the board's own DepartureRow so
        the grid, the type, the yellow destination, the badge and the
        cancellation rules are literally the same code;
     2. the whole /vehicle journey as a horizontal timeline;
     3. the passenger load iRail reported for this journey, secondary to
        the route and absent entirely when there is no reading.

   The route is fetched by App through the shared /vehicle cache and
   queue and handed down as a prop — nothing here touches the API.
   ------------------------------------------------------------------ */

// Only real values are printed: a field iRail did not send is dropped
// rather than shown empty. Delay is the stop's own, already in minutes.
function stopRows(stop, t) {
  const rows = [];
  const time = (d, delay) => (
    <>
      {formatTime(d)}
      {delay > 0 && <span className="train-tip__delay"> +{delay}&#39;</span>}
    </>
  );
  if (stop.arrival) rows.push([t.arrival, time(stop.arrival, stop.arrivalDelay)]);
  if (stop.departure) rows.push([t.departureAt, time(stop.departure, stop.departureDelay)]);
  if (!stop.arrival && !stop.departure && stop.time) {
    rows.push([t.departureAt, time(stop.time, 0)]);
  }
  if (stop.platform) {
    rows.push([t.platform, stop.platformChanged
      ? <span className="train-tip__changed">{stop.platform}</span>
      : stop.platform]);
  }
  return rows;
}

// The detail body, shared by the desktop tooltip and the phone's inline
// expansion: one design, two placements. The tooltip floats away from
// the stop and so names it; the inline block opens directly under the
// stop's own name in the timeline, so it does not repeat it.
function StopDetail({ stop, t, withName = true }) {
  return (
    <>
      {withName && <div className="train-tip__name">{stop.name}</div>}
      <dl className="train-tip__list">
        {stopRows(stop, t).map(([label, value]) => (
          <div className="train-tip__row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {stop.cancelled && <div className="train-tip__flag train-tip__flag--alert">{t.cancelled}</div>}
      {!stop.cancelled && stop.extra && <div className="train-tip__flag train-tip__flag--notice">{t.extraStop}</div>}
      {!stop.cancelled && stop.platformChanged && (
        <div className="train-tip__flag train-tip__flag--notice">{t.platformChange}</div>
      )}
    </>
  );
}

function stopClass(stop, isHere, index, last) {
  return 'train-stop'
    + (stop.cancelled ? ' is-cancelled' : '')
    + (stop.extra ? ' is-extra' : '')
    + (!stop.cancelled && (stop.departureDelay > 0 || stop.arrivalDelay > 0) ? ' is-delayed' : '')
    + (isHere ? ' is-here' : '')
    + (index === 0 || index === last ? ' is-terminus' : '');
}

function stopDescription(stop, isHere, t) {
  const parts = [];
  if (isHere) parts.push(t.currentStation);
  if (stop.cancelled) parts.push(t.cancelled);
  else {
    if (stop.extra) parts.push(t.extraStop);
    const delay = Math.max(stop.arrivalDelay, stop.departureDelay);
    if (delay > 0) parts.push(t.delayedBy(delay));
  }
  if (stop.platform) {
    parts.push(stop.platformChanged
      ? `${t.platformChange}: ${stop.platform}`
      : `${t.platform} ${stop.platform}`);
  }
  return parts.join(', ');
}

/* --- occupancy ----------------------------------------------------
   iRail reports a passenger load per stop (`stops.stop[].occupancy.name`),
   normalised in the service to 'low' | 'medium' | 'high' | null. Nothing
   is ever inferred: no reading means no section.

   Which stop speaks for the journey the reader is about to make: the
   board's own station, because that is where they board. Only if iRail
   sent no reading there does it look forward along the same journey for
   the first stop that has one — still this train, still ahead of the
   reader, never a stop already behind them and never an arbitrary one.
   If the board's station is not on the route at all, nothing is shown. */
function journeyOccupancy(route, stationId) {
  if (!route?.length || !stationId) return null;
  const here = route.findIndex((s) => s.id === stationId);
  if (here === -1) return null;
  for (let i = here; i < route.length; i += 1) {
    if (route[i].occupancy) return route[i].occupancy;
  }
  return null;
}

// Three seats' worth of passengers: filled up to the reported level,
// outlined beyond it. Decorative — the wording beside them carries the
// meaning, so the whole group is hidden from assistive technology.
const OCCUPANCY_FILLED = { low: 1, medium: 2, high: 3 };

function OccupancyIcons({ level }) {
  const filled = OCCUPANCY_FILLED[level] ?? 0;
  return (
    <span className="train-occupancy__icons" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <svg key={i} className={'train-occupancy__figure' + (i < filled ? ' is-on' : '')} viewBox="0 0 24 24">
          <circle cx="12" cy="7" r="3.6" />
          <path d="M5.4 21v-1.6A6.6 6.6 0 0 1 12 12.8a6.6 6.6 0 0 1 6.6 6.6V21Z" />
        </svg>
      ))}
    </span>
  );
}

export default function TrainDetailsModal({
  departure, route, loading, stationId, layout, viaStops, t, onClose,
}) {
  // Which stop the phone has opened. Desktop uses hover instead, so this
  // stays null there; either way only one stop is ever active.
  const [activeStop, setActiveStop] = useState(null);
  // The map is a second view of this same panel, not a second dialog:
  // one overlay, one focus trap, and the details are still behind it.
  const [mapOpen, setMapOpen] = useState(false);
  // The accuracy note, folded behind the info control in the title bar.
  const [infoOpen, setInfoOpen] = useState(false);
  // No extra lookup: `train` / `trainNumber` are the normalised identity
  // the board row already prints.
  const trainLabel = [departure?.train, departure?.trainNumber]
    .filter(Boolean).join(' ');
  const closeRef = useRef(null);
  const openerRef = useRef(null);
  const dialogRef = useRef(null);
  const openMapRef = useRef(null);
  const backRef = useRef(null);
  const timelineId = useId();
  const infoId = useId();
  const [phoneDetails, setPhoneDetails] = useState(
    () => window.matchMedia(PHONE_QUERY).matches);

  const open = Boolean(departure);

  // Read by the Escape handler below. A ref rather than the state value
  // itself, so opening the map does not re-run the effect that traps and
  // moves focus — which would pull focus back to the close button the
  // moment the map appeared.
  const mapOpenRef = useRef(false);
  mapOpenRef.current = mapOpen;
  const infoOpenRef = useRef(false);
  infoOpenRef.current = infoOpen;

  // Leaving the map returns focus to the control that opened it, the
  // same contract the overlay itself keeps with the departure row.
  const closeMap = useCallback(() => {
    setMapOpen(false);
    setInfoOpen(false);
    requestAnimationFrame(() => openMapRef.current?.focus());
  }, []);

  // The map view's first control is "back", so focus lands there as it
  // opens — the same contract the overlay keeps with its close button.
  useEffect(() => {
    if (!mapOpen) return undefined;
    const id = requestAnimationFrame(() => backRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [mapOpen]);

  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const sync = () => setPhoneDetails(mq.matches);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Focus goes into the dialog and comes back to the row afterwards.
    openerRef.current = document.activeElement;
    setActiveStop(null);
    // A different train must never inherit the previous one's map.
    setMapOpen(false);
    setInfoOpen(false);
    const id = requestAnimationFrame(() => closeRef.current?.focus());
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // One layer per press, outermost first: the accuracy note, then
        // the map, then the overlay itself.
        if (infoOpenRef.current) setInfoOpen(false);
        else if (mapOpenRef.current) closeMap();
        else onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) ?? [])];
      if (!controls.length) return;
      const first = controls[0];
      const lastControl = controls.at(-1);
      if (e.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        e.preventDefault();
        lastControl.focus();
      } else if (!e.shiftKey && document.activeElement === lastControl) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
      const opener = openerRef.current;
      requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus?.();
        else document.querySelector('.departure-row.is-openable, .topbar-pick')?.focus?.();
      });
    };
  }, [open, onClose, closeMap]);

  if (!open) return null;

  const last = route ? route.length - 1 : -1;
  const occupancy = journeyOccupancy(route, stationId);

  return (
    <div
      className="train-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <section ref={dialogRef} className="train-details" role="dialog" aria-modal="true" aria-label={t.details}>
        {/* The overlay's own title bar: the board's own topbar, reused
            whole — same blue, same height, same centred title. It is
            also the control layer, above and outside the row. */}
        <header className="topbar train-details__bar">
          {/* The bar's left track: empty on the details view, the way
              back out of the map on the map view. The map itself has no
              chrome, so both of the panel's controls sit in this one bar
              on either side of the title. */}
          {mapOpen ? (
            <button
              type="button"
              className="topbar-pick train-map__back"
              onClick={closeMap}
              ref={backRef}
              aria-label={t.backToDetails}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <polyline points="14.5,5 7.5,12 14.5,19" />
              </svg>
              {t.back}
            </button>
          ) : (
            /* The train's own label, already normalised by the service's
               `vehicleLabel()` (shortname first, type/number only as its
               fallback) and carried on the departure. It sits in the
               bar's left track, so the centre track keeps the bar's true
               centre line whatever the label's width. */
            <span className="train-details__label">{trainLabel}</span>
          )}
          <div className="topbar-title">{t.details}</div>
          {/* The bar's right-hand track. While the map is open it also
              carries the accuracy note, folded behind an info control so
              the map itself shows no disclaimer text at all. */}
          <div className="train-details__controls">
            {mapOpen && (
              <>
                <button
                  type="button"
                  className="topbar-pick train-info"
                  onClick={() => setInfoOpen((v) => !v)}
                  aria-expanded={infoOpen}
                  aria-controls={infoOpen ? infoId : undefined}
                  aria-label={t.approximateRoute}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <line x1="12" y1="11" x2="12" y2="16.5" />
                    <line x1="12" y1="7.6" x2="12" y2="7.7" />
                  </svg>
                </button>
                {infoOpen && (
                  <div className="train-info__panel" id={infoId} role="note">
                    <strong className="train-info__title">{t.approximateRoute}</strong>
                    <p className="train-info__text">{t.approximateRouteInfo}</p>
                  </div>
                )}
              </>
            )}
            <button
              type="button"
              className="topbar-pick train-close"
              onClick={onClose}
              aria-label={t.close}
              ref={closeRef}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        {/* 1. the clicked row: the board's component at the board's
            own measurements, a direct child so nothing wraps it */}
        <DepartureRow departure={departure} layout={layout} viaStops={viaStops} t={t} />

        {/* The optional map, shown instead of the timeline while it is
            open. The details are not unmounted-and-rebuilt around it:
            everything below is simply not rendered, so coming back shows
            the same timeline, the same scroll position logic and the
            same occupancy as before. */}
        {mapOpen && (
          <Suspense fallback={(
            <p className="train-details__message" role="status" aria-live="polite">{t.loadingMap}</p>
          )}>
            <TrainRouteMap
              departure={departure}
              route={route}
              stationId={stationId}
              t={t}
            />
          </Suspense>
        )}

        {/* 2. the route — the board's timeline, unchanged. It is simply
            not rendered while the map is open, and comes back exactly as
            it was when the reader presses "back to details". */}
        {!mapOpen && loading && <p className="train-details__message" role="status" aria-live="polite">{t.loadingRoute}</p>}
        {!mapOpen && !loading && !route && <p className="train-details__message" role="status" aria-live="polite">{t.noRoute}</p>}

        {!mapOpen && !loading && route && (
          <>
            <div className="train-timeline">
              <ol className="train-timeline__track">
                {route.map((stop, i) => {
                  const isHere = stop.id === stationId;
                  const description = stopDescription(stop, isHere, t);
                  const descriptionId = `${timelineId}-description-${i}`;
                  const panelId = `${timelineId}-panel-${i}`;
                  return (
                  <li key={`${stop.id}-${i}`} className={stopClass(stop, isHere, i, last)}>
                    <button
                      type="button"
                      className="train-stop__hit"
                      aria-current={isHere ? 'location' : undefined}
                      aria-describedby={description ? descriptionId : undefined}
                      aria-expanded={phoneDetails ? activeStop === i : undefined}
                      aria-controls={phoneDetails && activeStop === i ? panelId : undefined}
                      onClick={() => setActiveStop((s) => (s === i ? null : i))}
                    >
                      <span className="train-stop__time">{formatTime(stop.time)}</span>
                      <span className="train-stop__track">
                        <span className="train-stop__node" />
                      </span>
                      <span className="train-stop__name">{stop.name}</span>
                    </button>
                    {description && <span id={descriptionId} className="sr-only">{description}</span>}
                    {/* desktop: revealed on hover/focus of the whole stop,
                        which is why it lives inside the hover target */}
                    <div className="train-tip">
                      <StopDetail stop={stop} t={t} />
                    </div>
                    {/* phone: the same detail, opened in place under this
                        stop rather than floating over the route or
                        collecting at the foot of the panel. Only the one
                        expanded stop renders it, so the information is
                        never duplicated for assistive technology. */}
                    {phoneDetails && activeStop === i && (
                      <div id={panelId} className="train-stop__detail">
                        <StopDetail stop={stop} t={t} withName={false} />
                      </div>
                    )}
                  </li>
                  );
                })}
              </ol>
            </div>

            {/* 3. the panel's foot, closed off by the same rule that
                separates the departure row from the route above it.

                It carries the reported passenger load — still secondary,
                still absent entirely when iRail sent no reading, never an
                empty slot and never "unknown" — and, opposite it, the one
                way in to the optional map. */}
            <div className="train-details__footer">
              {occupancy && (
                <p className={`train-occupancy is-${occupancy}`}>
                  <OccupancyIcons level={occupancy} />
                  <span className="train-occupancy__label">{t.occupancy[occupancy]}</span>
                </p>
              )}
              <button
                type="button"
                className="train-details__map-open"
                onClick={() => setMapOpen(true)}
                ref={openMapRef}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <polygon points="3,6 9,3 15,6 21,3 21,18 15,21 9,18 3,21" />
                  <line x1="9" y1="3" x2="9" y2="18" />
                  <line x1="15" y1="6" x2="15" y2="21" />
                </svg>
                {t.openMap}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
