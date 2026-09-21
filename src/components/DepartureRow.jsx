import { Fragment } from 'react';

// The board's one time formatter — Brussels, never the machine's zone.
// Exported so the details overlay prints its route times identically.
export const hhmm = new Intl.DateTimeFormat('nl-BE', {
  timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function formatTime(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? hhmm.format(value) : '–';
}

// A stop list printed inline: cancelled stops are struck through in red.
function stopList(stops) {
  return stops.map((s, i) => (
    <Fragment key={`${s.name}-${i}`}>
      {i > 0 && ', '}
      {s.cancelled ? <span className="stop-dropped">{s.name}</span> : s.name}
    </Fragment>
  ));
}

// `labelled` adds the word "Spoor"/"Voie", which only the stacked
// phone layout prints; CSS hides it at every other size.
function Platform({ departure, t, labelled = false }) {
  if (departure.cancelled || !departure.platform) return <span className="no-value">–</span>;
  return (
    <>
      {labelled && <span className="plat-label">{t.platform}</span>}
      {departure.platformChanged
        ? <span className="is-changed">{departure.platform}</span>
        : departure.platform}
    </>
  );
}

/* --- concourse overview: one line per train ---------------------- */

// Status column: a solid red block, or the delay arrow followed by the
// real departure time in a white box, exactly as on the screen.
function Badge({ departure, t }) {
  if (departure.cancelled) {
    return <span className="badge"><span className="badge__alert">{t.cancelled}</span></span>;
  }
  if (departure.shortened && departure.shortenedAt) {
    return <span className="badge"><span className="badge__alert">{t.limited}</span></span>;
  }
  if (departure.delay > 0) {
    const real = new Date(departure.time.getTime() + departure.delay * 60000);
    return (
      <span className="badge badge--split">
        <span className="badge__alert">+{departure.delay}&#39;</span>
        <span className="badge__time">{formatTime(real)}</span>
      </span>
    );
  }
  return null;
}

// Destination in yellow, followed inline by "via A, B, C" in white.
function MainLine({ departure, viaStops, t }) {
  const dest = <span className="departure-row__destination">{departure.destination}</span>;

  if (departure.cancelled) {
    return <>{dest} <span className="departure-row__via">{t.cancelledLong}.</span></>;
  }
  if (departure.shortened && departure.shortenedAt) {
    return <>{dest} <span className="departure-row__via">{t.limitedTo(departure.shortenedAt)}</span></>;
  }
  // The overview prints a few intermediate stations, never the terminus.
  const via = (departure.intermediateStops ?? []).slice(0, -1);
  if (!via.length) return dest;
  return (
    <>
      {dest}{' '}
      <span className="departure-row__via">
        {t.via} {stopList(via.slice(0, viaStops))}
        {via.length > viaStops ? ',…' : ''}
      </span>
    </>
  );
}

function CompactRow({ departure, viaStops, t, open }) {
  return (
    <div className={rowClass(departure, open)} {...openProps(departure, t, open)}>
      <div className="departure-row__time">{formatTime(departure.time)}</div>
      <div className="departure-row__status"><Badge departure={departure} t={t} /></div>
      <div className="departure-row__main"><MainLine departure={departure} viaStops={viaStops} t={t} /></div>
      <div className="departure-row__train">{departure.train}</div>
      <div className="departure-row__platform"><Platform departure={departure} t={t} labelled /></div>
    </div>
  );
}

/* --- platform detail: one tall band per train -------------------- */

// Second line of the destination column: the stop list, or a disruption band.
function SecondLine({ departure, t }) {
  if (departure.cancelled) {
    return <div className="band band--alert">{t.cancelledLong}</div>;
  }
  if (departure.shortened && departure.shortenedAt) {
    return <div className="band band--notice">{t.limitedTo(departure.shortenedAt)}</div>;
  }
  if (departure.extra) {
    return <div className="band band--notice">{t.extra}</div>;
  }
  const stops = departure.intermediateStops;
  if (!stops?.length) return null;
  return <div className="departure-row__stops">{t.stops} {stopList(stops)}.</div>;
}

function PlatformRow({ departure, t, open }) {
  return (
    <div className={rowClass(departure, open)} {...openProps(departure, t, open)}>
      <div className="departure-row__time">
        <div className="departure-row__clock">{formatTime(departure.time)}</div>
        {/* Cancellations are announced by the full-width band instead. */}
        {!departure.cancelled && departure.delay > 0 && (
          <div className="delay-flag">+ {departure.delay} &#39;</div>
        )}
      </div>
      <div className="departure-row__main">
        <div className="departure-row__destination">{departure.destination}</div>
        <SecondLine departure={departure} t={t} />
      </div>
      <div className="departure-row__train">{departure.train}</div>
      <div className="departure-row__platform"><Platform departure={departure} t={t} /></div>
    </div>
  );
}

/* --- opening the details overlay --------------------------------- */

// A row is only interactive on the board. The same component also draws
// the summary at the top of the details overlay, and there `onOpen` is
// absent: no cursor, no hover, no tab stop, identical pixels.
function rowClass(departure, open) {
  return 'departure-row'
    + (departure.cancelled ? ' is-cancelled' : '')
    + (open ? ' is-openable' : '');
}

// The neutral row container borrows button semantics only when it opens
// details. Enter fires on keydown, Space on keyup, as buttons do.
function openProps(departure, t, open) {
  if (!open) return {};
  const via = (departure.intermediateStops ?? []).slice(0, -1);
  const parts = [formatTime(departure.time), departure.destination].filter(Boolean);
  if (via.length) {
    const shown = via.slice(0, 3).map((stop) => stop.name).join(', ');
    parts.push(`${t.via} ${shown}${via.length > 3 ? ', …' : ''}`);
  }
  if (departure.train) parts.push(departure.train);
  if (!departure.cancelled && departure.platform) {
    parts.push(departure.platformChanged
      ? `${t.platformChange}: ${departure.platform}`
      : `${t.platform} ${departure.platform}`);
  }
  if (departure.cancelled) parts.push(t.cancelled);
  else {
    if (departure.shortened && departure.shortenedAt) parts.push(t.limitedTo(departure.shortenedAt));
    if (departure.extra) parts.push(t.extra);
    if (departure.delay > 0) parts.push(t.delayedBy(departure.delay));
  }
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': parts.join(', '),
    onClick: () => open(departure),
    onKeyDown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); open(departure); }
      // stop the page scrolling while the key is held
      if (e.key === ' ') e.preventDefault();
    },
    onKeyUp: (e) => { if (e.key === ' ') { e.preventDefault(); open(departure); } },
  };
}

export default function DepartureRow({ departure, layout, viaStops, t, onOpen }) {
  return layout === 'platform'
    ? <PlatformRow departure={departure} t={t} open={onOpen} />
    : <CompactRow departure={departure} viaStops={viaStops} t={t} open={onOpen} />;
}
