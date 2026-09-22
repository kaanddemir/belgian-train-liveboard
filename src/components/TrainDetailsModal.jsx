import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import DepartureRow, { formatTime } from './DepartureRow.jsx';
import { hasPerformance } from '../services/punctuality.js';

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

/* --- historical performance ---------------------------------------
   How this train has run at this station over the last 30 service
   days, from the static Infrabel aggregate App fetched. Three figures,
   all of them the same sample described three ways, so one count in
   the heading speaks for all of them.

   Nothing is computed here: the median, the percentage and the p90
   were decided by the build script. This only turns seconds into the
   minutes a reader reads. */

// Delay, to the nearest minute and always signed — except at zero,
// where "+0 min" would claim a precision the rounding does not have.
// Early is a real answer and keeps its sign.
function delayMinutes(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return '0';
  return minutes > 0 ? `+${minutes}` : `−${Math.abs(minutes)}`;
}

// A containment claim — "9 in 10 arrive within this" — so it rounds up,
// never down: rounding 11.4 down would make the sentence false. A train
// whose ninth-in-ten arrival is early still contains at zero.
function containmentMinutes(seconds) {
  return seconds <= 0 ? '+0' : `+${Math.ceil(seconds / 60)}`;
}

// The line under the heading: which window, how far behind it is if it
// has fallen behind, and how many journeys it rests on. Built from
// pieces rather than one sentence per combination, because the window
// varies and the count is not always meaningful.
function metaLine(performance, t) {
  if (performance.state !== 'ok' && performance.state !== 'collecting') return null;
  if (performance.state === 'collecting') {
    return t.performanceCollecting(performance.daysAvailable);
  }
  return [
    t.performanceWindow(performance.windowDays),
    performance.throughLabel ? t.performanceThrough(performance.throughLabel) : null,
    performance.samples > 0 ? t.performanceJourneys(performance.samples) : null,
  ].filter(Boolean).join(' \u00b7 ');
}

// One figure, read as one thing: the label, the number under it and
// the line that says what the number counts. The pair stays a <dt> and
// a <dd> — a term and its description is exactly what this is — and the
// gloss sits inside the description because it qualifies the figure,
// not the heading. A screen reader reads "Typical Delay: +3 min, median
// delay", which is the sentence the three lines draw.
function Metric({ label, value, hint }) {
  return (
    <div className="train-performance__metric">
      <dt className="train-performance__label">{label}</dt>
      <dd className="train-performance__reading">
        <span className="train-performance__value">{value}</span>
        <span className="train-performance__hint">{hint}</span>
      </dd>
    </div>
  );
}

function TrainPerformance({ performance, t, id }) {
  // No result yet means the shard is still in flight. The section is
  // drawn from the moment the panel opens either way, so nothing below
  // it moves when the figures arrive.
  const state = performance?.state ?? 'loading';
  const meta = performance ? metaLine(performance, t) : null;
  // Which sentence stands in for the figures, when there are none.
  // Each says a different thing and they must not be run together:
  // still fetching, no data at all, a window still filling, a window we
  // cannot trust the age of, or a window that simply has not seen this
  // train here often enough.
  const message = state === 'loading' ? t.performanceLoading
    : state === 'none' ? t.performanceNoneYet
      : state === 'stale' ? t.performanceStale
        : state === 'collecting' ? t.performanceNotEnoughYet
          : !performance.enough ? t.performanceNotComparable
            : null;

  return (
    <section className="train-performance" id={id} aria-label={t.performance}>
      <h2 className="train-performance__title">{t.performance}</h2>
      {meta && <p className="train-performance__meta">{meta}</p>}

      {message ? (
        <p className="train-performance__empty" role="status">{message}</p>
      ) : (
        <dl className="train-performance__list">
          <Metric
            label={t.typicalDelay}
            value={`${delayMinutes(performance.medianSec)}\u00a0${t.minutesShort}`}
            hint={t.typicalDelayHint}
          />
          {/* The threshold is a reporting convention, not something the
              reader can infer from "On-Time Rate", so it is printed
              rather than hidden behind a hover. It is this metric's own
              gloss, in the same place as the other two. */}
          <Metric
            label={t.onTimeRate}
            value={`${performance.onTimePct}%`}
            hint={t.onTimeRateHint}
          />
          {/* Absent under twenty observations: a tail needs a sample
              before it means anything. The metric simply is not there. */}
          {performance.p90Sec !== null && (
            <Metric
              label={t.p90Label}
              value={`${containmentMinutes(performance.p90Sec)}\u00a0${t.minutesShort}`}
              hint={t.p90Hint}
            />
          )}
        </dl>
      )}
    </section>
  );
}

export default function TrainDetailsModal({
  departure, route, loading, performance, stationId, layout, viaStops, t, share, onClose,
}) {
  // Which stop the phone has opened. Desktop uses hover instead, so this
  // stays null there; either way only one stop is ever active.
  const [activeStop, setActiveStop] = useState(null);
  // The map is a second view of this same panel, not a second dialog:
  // one overlay, one focus trap, and the details are still behind it.
  const [mapOpen, setMapOpen] = useState(false);
  // The accuracy note, folded behind the info control in the title bar.
  const [infoOpen, setInfoOpen] = useState(false);
  // The historical figures, folded away until asked for. A disclosure,
  // not a view: it adds no layer to the Escape ladder and no second
  // "back" control — the panel still has exactly one way out.
  const [perfOpen, setPerfOpen] = useState(false);
  // What the last Share did: null, 'copied', or 'failed' — the last one
  // shows the link itself to copy by hand.
  const [shareState, setShareState] = useState(null);
  const shareStateRef = useRef(null);
  shareStateRef.current = shareState;
  const manualRef = useRef(null);
  const shareId = useId();
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
  const perfId = useId();
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

  // The figures belong to one train: another one opened in place (a
  // history step, a shared link) starts with the section closed.
  useEffect(() => { setPerfOpen(false); }, [departure?.id]);

  useEffect(() => {
    if (!open) return;
    // Focus goes into the dialog and comes back to the row afterwards.
    openerRef.current = document.activeElement;
    setActiveStop(null);
    // A different train must never inherit the previous one's map,
    // nor the previous one's figures.
    setMapOpen(false);
    setInfoOpen(false);
    setPerfOpen(false);
    setShareState(null);
    const id = requestAnimationFrame(() => closeRef.current?.focus());
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // One layer per press, outermost first: the accuracy note, then
        // the map, then the overlay itself.
        if (shareStateRef.current) setShareState(null);
        else if (infoOpenRef.current) setInfoOpen(false);
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
        // A panel opened from a shared link had no row behind it: the
        // body was focused then, and the fallback below is the safe one.
        if (opener?.isConnected && opener !== document.body) opener.focus?.();
        else document.querySelector('.departure-row.is-openable, .topbar-pick')?.focus?.();
      });
    };
  }, [open, onClose, closeMap]);

  // The copied note goes away by itself; a failure stays until dismissed,
  // since it carries the link to copy.
  useEffect(() => {
    if (shareState !== 'copied') return undefined;
    const id = setTimeout(() => setShareState(null), 2500);
    return () => clearTimeout(id);
  }, [shareState]);

  useEffect(() => {
    if (shareState === 'failed') manualRef.current?.select();
  }, [shareState]);

  // The system share sheet where there is one, the clipboard otherwise,
  // and the link itself, selected, when neither works. Dismissing the
  // share sheet is a choice, not a failure.
  const shareDeparture = useCallback(async () => {
    if (!share) return;
    setInfoOpen(false);
    if (typeof navigator.share === 'function') {
      try {
        // The link alone: with a title or text beside it, the system
        // sheet's Copy puts the description on the clipboard as well.
        await navigator.share({ url: share.url });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(share.url);
      setShareState('copied');
    } catch {
      setShareState('failed');
    }
  }, [share]);

  if (!open) return null;

  // Each footer action is offered only once it leads somewhere, and
  // each waits only for its own data: the figures for their shard, the
  // map for the /vehicle journey.
  const showPerf = hasPerformance(performance);
  const showMap = !loading && Boolean(route);
  const last = route ? route.length - 1 : -1;
  // never a previous journey's reading while this one is still loading
  const occupancy = loading ? null : journeyOccupancy(route, stationId);

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
            {share && (
              <button
                type="button"
                className="topbar-pick train-share"
                onClick={shareDeparture}
                aria-label={t.share}
                aria-controls={shareState ? shareId : undefined}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3.5v11" />
                  <polyline points="7.5,8 12,3.5 16.5,8" />
                  <path d="M8 11H6.5a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H16" />
                </svg>
              </button>
            )}
            {shareState && share && (
              <div className="train-info__panel train-share__panel" id={shareId}>
                {shareState === 'copied' ? (
                  <p className="train-info__text">{t.shareCopied}</p>
                ) : (
                  <>
                    <p className="train-info__text">{t.shareFailed}</p>
                    <input
                      ref={manualRef}
                      className="train-share__url"
                      type="url"
                      readOnly
                      value={share.url}
                      aria-label={t.shareLink}
                      onFocus={(e) => e.target.select()}
                    />
                  </>
                )}
              </div>
            )}
            <p className="sr-only" role="status">
              {shareState === 'copied' ? t.shareCopied : shareState === 'failed' ? t.shareFailed : ''}
            </p>
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
          </>
        )}

        {/* 3. the panel's foot, closed off by the same rule that
            separates the departure row from the route above it.

            It carries the reported passenger load — still secondary,
            still absent entirely when iRail sent no reading, never an
            empty slot and never "unknown" — and, opposite it, the way
            in to the historical figures and the way in to the map.

            It is deliberately outside the `route` branch above. The
            figures are keyed on the train number and this station, not
            on the journey, so a train iRail has no /vehicle route for
            still has a history worth showing. Only the map needs the
            route, so only the map's button waits for one. Occupancy is
            read from the route, so it cannot appear before it either.
            With nothing to carry, the foot is not drawn at all. */}
        {!mapOpen && (occupancy || showPerf || showMap) && (
          <>
            <div className="train-details__footer">
              {occupancy && (
                <p className={`train-occupancy is-${occupancy}`}>
                  <OccupancyIcons level={occupancy} />
                  <span className="train-occupancy__label">{t.occupancy[occupancy]}</span>
                </p>
              )}
              {/* The two ways out of this panel, kept together as one
                  group on the right so they read as a pair at every
                  width and never wrap apart. */}
              <div className="train-details__actions">
                {/* A disclosure, not a view. Offered once the shard has
                    answered with something about this train — figures, a
                    count, a window still filling or one fallen behind —
                    and never for "no data", which would open onto nothing. */}
                {showPerf && (
                  <button
                    type="button"
                    className="train-details__disclose"
                    onClick={() => setPerfOpen((v) => !v)}
                    aria-expanded={perfOpen}
                    aria-controls={perfOpen ? perfId : undefined}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <polyline points="4,15.5 10,9.5 14,13.5 20,7.5" />
                      <polyline points="15.5,7.5 20,7.5 20,12" />
                    </svg>
                    {t.performance}
                  </button>
                )}
                {/* The map is the one thing here that genuinely needs the
                    journey, so it is the one thing gated on it. */}
                {showMap && (
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
                )}
              </div>
            </div>

            {perfOpen && showPerf && (
              <TrainPerformance performance={performance} t={t} id={perfId} />
            )}
          </>
        )}
      </section>
    </div>
  );
}
