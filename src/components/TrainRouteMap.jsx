import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getRailRoute } from '../services/railRoute.js';
import { formatTime } from './DepartureRow.jsx';

/* ------------------------------------------------------------------
   Train route map — the optional second view of the details overlay.

   This whole module, Leaflet and Leaflet's stylesheet included, is
   reached only through a dynamic import in TrainDetailsModal, and the
   rail graph it needs is fetched the first time it renders. Nothing
   here is part of the board's initial load: a reader who never opens a
   map never pays for one.

   Four sources, deliberately kept apart:
     iRail          which stations this train calls at, and in what
                    order — passed in, never refetched here
     Infrabel       the shape of the railway between those stations,
                    preprocessed into a static graph
     OpenStreetMap  the background tiles, and nothing else: the route
                    line is NOT derived from them
     Leaflet        rendering

   The line follows real railway infrastructure. Which of several
   possible paths through that infrastructure the train actually took is
   not knowable from static data, so the panel's info control says
   "approximate route" and nothing here ever claims otherwise.

   This component is only the map. The way back and the accuracy note
   are controls of the details panel's own title bar, owned by
   TrainDetailsModal, so the map has no chrome of its own.
   ------------------------------------------------------------------ */

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Leaflet takes [latitude, longitude]; everything upstream of this file
// — GeoJSON, the Infrabel graph, iRail's own fields — is
// [longitude, latitude]. The order is flipped here and nowhere else.
const toLatLng = ([longitude, latitude]) => [latitude, longitude];

// A stop only reaches the map if iRail gave it a real position.
const stopLatLng = (stop) => (stop?.coordinates
  ? [stop.coordinates.latitude, stop.coordinates.longitude]
  : null);

/* The map's colours are the board's colours. Leaflet paints the line and
   the markers onto a canvas rather than into the DOM, so they cannot be
   styled from the stylesheet — they are read out of it instead, from the
   same `:root` tokens every other surface uses, so the palette stays in
   one place. */
function paletteOf(element) {
  const read = getComputedStyle(element);
  const token = (name, fallback) => (read.getPropertyValue(name).trim() || fallback);
  return {
    board:       token('--color-board-bg', '#0f3054'),
    text:        token('--color-board-text', '#ffffff'),
    destination: token('--color-destination', '#ffcc05'),
  };
}

/* Stop marker weights — three steps and no more. An intermediate call is
   a small neutral dot, the two termini are the same dot drawn a little
   stronger, and the station the board is showing keeps the timeline's
   yellow. Nothing here is an icon. */
function markerStyle(role, palette) {
  if (role === 'here') {
    return { radius: 6.5, weight: 3, color: palette.board, fillColor: palette.destination };
  }
  if (role === 'terminus') {
    return { radius: 5, weight: 2.5, color: palette.board, fillColor: palette.text };
  }
  return { radius: 3.5, weight: 1.5, color: palette.board, fillColor: palette.text };
}

/* The popup is the timeline's stop tooltip, rebuilt as the markup
   Leaflet accepts. Same classes, same rows, same order as StopDetail in
   TrainDetailsModal — the surface theming comes from the stylesheet, so
   the two read as one component in two places. */
function stopPopupHtml(stop, here, t) {
  const time = (value, delay) => (
    `${escapeHtml(formatTime(value))}`
    + (delay > 0 ? `<span class="train-tip__delay"> +${escapeHtml(delay)}&#39;</span>` : '')
  );

  const rows = [];
  if (stop.arrival) rows.push([t.arrival, time(stop.arrival, stop.arrivalDelay)]);
  if (stop.departure) rows.push([t.departureAt, time(stop.departure, stop.departureDelay)]);
  if (!stop.arrival && !stop.departure && stop.time) rows.push([t.departureAt, time(stop.time, 0)]);
  if (stop.platform) {
    rows.push([t.platform, stop.platformChanged
      ? `<span class="train-tip__changed">${escapeHtml(stop.platform)}</span>`
      : escapeHtml(stop.platform)]);
  }

  const flags = [];
  if (stop.cancelled) flags.push(['alert', t.cancelled]);
  if (!stop.cancelled && stop.extra) flags.push(['notice', t.extraStop]);
  if (!stop.cancelled && stop.platformChanged) flags.push(['notice', t.platformChange]);
  if (here) flags.push(['notice', t.currentStation]);

  return `<div class="train-tip__name">${escapeHtml(stop.name)}</div>`
    + `<dl class="train-tip__list">${rows.map(([label, value]) => (
      `<div class="train-tip__row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`
    )).join('')}</dl>`
    + flags.map(([kind, label]) => (
      `<div class="train-tip__flag train-tip__flag--${kind}">${escapeHtml(label)}</div>`
    )).join('');
}

/* Framing. The route should fill the map, not float in the middle of
   Belgium, so the padding is a share of the container rather than a
   fixed inset — small enough on a phone that the line still reads, large
   enough on a desktop panel that a terminus marker and the popup that
   opens above it are never cropped. The extra room at the top is the
   popup's; the extra at the left is the zoom control's, and the extra at
   the bottom the attribution's. */
function framePadding(map) {
  const { x, y } = map.getSize();
  const side = Math.round(Math.min(Math.max(x * 0.05, 16), 56));
  const vertical = Math.round(Math.min(Math.max(y * 0.06, 14), 48));
  return {
    paddingTopLeft: L.point(side + 34, vertical),
    paddingBottomRight: L.point(side, vertical + 18),
  };
}

export default function TrainRouteMap({ departure, route, stationId, t }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [state, setState] = useState({ status: 'loading' });

  // The journey this map is for. Recomputed only when the train or its
  // stop list changes, so re-rendering never rebuilds the route.
  //
  // Keyed on the scheduled time's *value*, never on the Date object: the
  // board hands down a freshly normalised departure every 30 s refresh,
  // and depending on that new Date would rebuild the whole map — losing
  // the reader's pan, zoom and open popup — on every poll.
  const departureAt = departure?.time ? departure.time.getTime() : 0;
  const journey = useMemo(() => ({
    vehicleId: departure?.vehicleId ?? '',
    day: departureAt ? new Date(departureAt).toISOString().slice(0, 10) : '',
    stops: route ?? [],
  }), [departure?.vehicleId, departureAt, route]);

  // Route geometry. Aborted by `cancelled` rather than by an
  // AbortController: the work is a graph search plus one cached fetch,
  // and the only thing that must not happen is a late setState.
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    getRailRoute(journey.vehicleId, journey.day, journey.stops)
      .then((result) => {
        if (cancelled) return;
        setState(result.ok
          ? { status: 'ready', line: result.line }
          : { status: 'unavailable', reason: result.reason });
      })
      .catch(() => { if (!cancelled) setState({ status: 'failed' }); });
    return () => { cancelled = true; };
  }, [journey]);

  // Leaflet itself. Created only once the geometry exists, and torn down
  // completely on the way out so reopening never hits "Map container is
  // already initialized" or inherits a previous train's layers.
  useEffect(() => {
    if (state.status !== 'ready' || !containerRef.current) return undefined;

    const container = containerRef.current;
    const palette = paletteOf(container);

    // The map is read the way a map is read: wheel and trackpad zoom on
    // a desktop, two-finger pinch on touch, drag to pan everywhere. All
    // of it is Leaflet's own handling — there is no gesture code in this
    // project and there is not to be any. Only `scrollWheelZoom` was
    // ever off; the rest are Leaflet's defaults, named here because this
    // map's interaction is a deliberate choice rather than an omission.
    const map = L.map(container, {
      scrollWheelZoom: true,   // wheel, and trackpad two-finger scroll
      touchZoom: true,         // pinch; ctrl+wheel trackpad pinch lands here too
      dragging: true,
      doubleClickZoom: true,
      keyboard: true,
      // The map fills a panel rather than a page, so the wheel should
      // reach a useful zoom in a turn or two instead of crawling; these
      // are Leaflet's own wheel tuning values, only made less coarse.
      wheelPxPerZoomLevel: 90,
      zoomControl: true,
      attributionControl: true,
    });
    mapRef.current = map;

    L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 18,
      // Tiles are fetched for the viewport as it is looked at; nothing
      // is prefetched, and nothing is requested before this point.
    }).addTo(map);

    // The railway line: Infrabel geometry, drawn under the markers. A
    // casing beneath the coloured line keeps it legible over both the
    // pale and the busy parts of the base map.
    const latlngs = state.line.map(toLatLng);
    L.polyline(latlngs, {
      color: palette.board, weight: 7, opacity: 0.55, lineJoin: 'round', interactive: false,
    }).addTo(map);
    const line = L.polyline(latlngs, {
      color: palette.destination, weight: 3.5, opacity: 1, lineJoin: 'round', interactive: false,
    }).addTo(map);

    // Stops, from iRail's coordinates — never from the graph, which
    // knows operational points rather than the journey.
    const last = journey.stops.length - 1;
    journey.stops.forEach((stop, i) => {
      const at = stopLatLng(stop);
      if (!at) return;
      const here = Boolean(stationId) && stop.id === stationId;
      const role = here ? 'here' : (i === 0 || i === last) ? 'terminus' : 'intermediate';
      const marker = L.circleMarker(at, {
        ...markerStyle(role, palette),
        fillOpacity: 1,
        // Cancelled calls are drawn, but muted: the timeline carries the
        // detail, the map only has to not contradict it.
        opacity: stop.cancelled ? 0.45 : 1,
      }).addTo(map);

      marker.bindPopup(stopPopupHtml(stop, here, t), {
        className: 'train-map__popup',
        closeButton: true,
        minWidth: 168,
        maxWidth: 260,
        autoPanPadding: L.point(16, 16),
      });
    });

    // Frame the whole journey. The route's own bounds already contain
    // every matched stop, and the padding keeps the terminus markers,
    // the controls and an opened popup clear of the panel edges. maxZoom
    // stops a two-stop hop filling the screen with one street.
    const bounds = line.getBounds();
    // Framing moves the map itself, so it raises the same events a
    // reader's own zoom does; the flag tells the two apart.
    let framing = false;
    const frame = () => {
      framing = true;
      map.fitBounds(bounds, { ...framePadding(map), maxZoom: 14 });
      framing = false;
    };
    frame();

    // Once the reader has zoomed or panned, the view is theirs: a later
    // resize is corrected for, never re-framed over the top of it.
    let touched = false;
    const claim = () => { if (!framing) touched = true; };
    map.on('zoomstart dragstart', claim);
    const refit = () => { map.invalidateSize(); if (!touched) frame(); };

    // The panel animates in, so the container can still be settling when
    // Leaflet measures it — and a rotation or a resized window changes
    // how much of the route fits. Both are the same correction.
    const settle = requestAnimationFrame(refit);
    const observer = new ResizeObserver(refit);
    observer.observe(container);

    return () => {
      cancelAnimationFrame(settle);
      observer.disconnect();
      map.off('zoomstart dragstart', claim);
      map.remove();              // removes layers, listeners and the container's Leaflet id
      mapRef.current = null;
    };
  }, [state, journey, stationId, t]);

  const summary = useMemo(() => {
    const stops = journey.stops;
    if (!stops.length) return '';
    const parts = [t.mapSummary(stops[0]?.name ?? '', stops.at(-1)?.name ?? ''), t.approximateRoute];
    const here = stops.find((s) => s.id === stationId);
    if (here) parts.push(`${t.currentStation}: ${here.name}`);
    return parts.join('. ') + '.';
  }, [journey, stationId, t]);

  return (
    <div className="train-map">
      {state.status === 'loading' && (
        <p className="train-details__message" role="status" aria-live="polite">{t.loadingMap}</p>
      )}

      {(state.status === 'unavailable' || state.status === 'failed') && (
        <p className="train-details__message" role="status" aria-live="polite">
          {state.status === 'failed' ? t.mapUnavailable : t.railRouteUnavailable}
        </p>
      )}

      {state.status === 'ready' && (
        <>
          <p className="sr-only">{summary}</p>
          <div
            className="train-map__canvas"
            ref={containerRef}
            role="group"
            aria-label={t.routeMap}
          />
        </>
      )}
    </div>
  );
}

// Stop names and platforms come from iRail and are written into a
// Leaflet popup, which takes HTML. They are escaped rather than trusted.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
