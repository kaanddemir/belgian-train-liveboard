/* === DEVELOPMENT-ONLY VISUAL TEST DATA ==========================
   Not part of the running board. `App.jsx` reaches this module only
   behind `import.meta.env.DEV && ?mock=1`, and that guard is a
   compile-time constant, so a production build drops the branch and
   this file with it — `npm run build` ships no mock data.

   Why it exists: iRail is the only source of railway data, and late in
   the evening a real liveboard carries six or seven trains. That is not
   enough to see a full board, let alone a delayed, cancelled,
   platform-changed or shortened row next to each other. This fixture is
   a fixed board that exercises every row state at once.

   It produces the same normalised shapes `src/services/irail.js`
   returns — the board, its departures and their stops — so nothing
   downstream knows the difference. The names are written once, not per
   language: the mock is a layout instrument, not a translation.
   ================================================================= */

// The board is anchored to the minute the dev server first loaded this
// module, not to `Date.now()` at call time: a departure's identity is its
// vehicle plus its scheduled time, so a moving base would hand every 30 s
// refresh a new set of ids, remounting every row and closing an open
// overlay. Rounded to the quarter hour so a deep link copied from the mock
// board still names the same departure after a reload.
const QUARTER = 15 * 60000;
const BASE = new Date(Math.floor(Date.now() / QUARTER) * QUARTER);

const at = (minutes) => new Date(BASE.getTime() + minutes * 60000);

/* One table for both consumers: the `after` list is the board's inline
   "via" text and the tail of the details timeline, `before` is where the
   train has come from. Minutes are offsets from BASE. */
const TRAINS = [
  {
    train: 'IC', number: '1832', destination: 'Bruxelles-Midi', minutes: -3,
    delay: 10, platform: '4',
    // two figures and no p90: fourteen journeys is enough for a median
    // and a percentage, not for a tail
    performance: { windowDays: 15, samples: 14, medianSec: 170, onTimePct: 86, p90Sec: 640 },
    before: [['Anvers-Central', -25], ['Malines', -14], ['Bruxelles-Nord', -6]],
    after: [['Bruxelles-Midi', 4]],
  },
  {
    train: 'IC', number: '2134', destination: 'Brussels Airport - Zaventem',
    minutes: 2, platform: '1',
    before: [['Bruxelles-Midi', -4]],
    after: [['Bruxelles-Nord', 5], ['Brussels Airport - Zaventem', 15]],
  },
  {
    train: 'S3', number: '3765', destination: 'Bruxelles-Nord', minutes: 4,
    delay: 1, platform: '1',
    before: [['Zottegem', -38], ['Denderleeuw', -26], ['Bruxelles-Midi', -6]],
    after: [['Bruxelles-Nord', 8]],
  },
  {
    // long via list: the inline text truncates after CONFIG.viaStops
    train: 'IC', number: '1715', destination: 'Mons', minutes: 5, platform: '2',
    before: [['Louvain', -22], ['Bruxelles-Nord', -5]],
    after: [
      ['Bruxelles-Midi', 9], ['Braine-le-Comte', 27], ['Soignies', 36],
      ['Jurbise', 45], ['Mons', 53],
    ],
  },
  {
    train: 'S10', number: '4287', destination: 'Jette', minutes: 7,
    occupancy: 'low',
    // the full section: all three figures, beside an occupancy reading,
    // which is the footer's own layout case
    performance: { windowDays: 30, samples: 26, medianSec: 180, onTimePct: 81, p90Sec: 660 },
    delay: 1, platform: '2',
    before: [['Alost', -30], ['Bruxelles-Midi', -8]],
    after: [['Bruxelles-Nord', 11], ['Jette', 18]],
  },
  {
    // no platform published yet: the cell renders the em dash
    train: 'S8', number: '3311', destination: 'Bruxelles-Luxembourg', minutes: 8,
    occupancy: 'medium',
    // a dataset too young to name a window at all
    performance: { collectingDays: 6 },
    platform: null,
    before: [['Braine-l-Alleud', -26], ['Bruxelles-Midi', -10]],
    after: [['Bruxelles-Luxembourg', 12]],
  },
  {
    // long via list on a long-ish destination
    train: 'S1', number: '1852', destination: 'Anvers-Berchem', minutes: 9,
    occupancy: 'high',
    // a real window this train has simply not been seen in often enough
    performance: { windowDays: 30, samples: 4 },
    platform: '5',
    before: [['Nivelles', -34], ['Bruxelles-Midi', -11]],
    after: [
      ['Bruxelles-Nord', 13], ['Schaerbeek', 17], ['Vilvorde', 23],
      ['Malines', 35], ['Anvers-Berchem', 52],
    ],
  },
  {
    // a shortened route: the run of cancelled stops at the end makes the
    // board print "limited to Bruges"
    train: 'IC', number: '2237', destination: 'Ostende', minutes: 12, platform: '2',
    occupancy: null,   // iRail reported nothing: no section at all
    before: [['Louvain', -20], ['Bruxelles-Nord', -2]],
    after: [
      ['Bruxelles-Midi', 16], ['Gand-Saint-Pierre', 45], ['Bruges', 70],
      ['Ostende', 85, true],
    ],
  },
  {
    train: 'S2', number: '3540', destination: 'Braine-le-Comte', minutes: 13,
    delay: 1, platform: '4',
    before: [['Louvain', -18]],
    after: [
      ['Bruxelles-Midi', 17], ['Forest-Midi', 21], ['Ruisbroek', 26],
      ['Hal', 33], ['Braine-le-Comte', 47],
    ],
  },
  {
    // platform change: the digit sits in the inverted box
    train: 'S4', number: '4412', destination: 'Alost', minutes: 15,
    delay: 3, platform: '6', platformChanged: true,
    before: [['Vilvorde', -12], ['Bruxelles-Nord', -3]],
    after: [['Bruxelles-Midi', 19], ['Denderleeuw', 38], ['Alost', 47]],
  },
  {
    // cancelled: struck through, never inferred from anything else
    train: 'IC', number: '2842', destination: 'Knokke', minutes: 16,
    platform: null, cancelled: true,
    before: [['Bruxelles-Nord', -1]],
    after: [
      ['Bruxelles-Midi', 20, true], ['Gand-Saint-Pierre', 48, true],
      ['Bruges', 72, true], ['Knokke', 95, true],
    ],
  },
  {
    // the longest destination on the board, with a long via list under it
    train: 'IC', number: '3341', destination: 'Louvain-la-Neuve-Université',
    minutes: 18, platform: '3',
    before: [['Bruxelles-Nord', 0]],
    after: [
      ['Bruxelles-Luxembourg', 22], ['Etterbeek', 25], ['Ottignies', 48],
      ['Louvain-la-Neuve-Université', 60],
    ],
  },
  {
    train: 'IC', number: '1229', destination: 'Liège-Guillemins', minutes: 20,
    delay: 12, platform: '7',
    before: [['Ostende', -95], ['Gand-Saint-Pierre', -50], ['Bruxelles-Midi', -4]],
    after: [
      ['Bruxelles-Nord', 24], ['Louvain', 38], ['Liège-Guillemins', 75],
    ],
  },
  {
    train: 'IC', number: '1936', destination: 'Bruxelles-Midi', minutes: 22,
    platform: '6',
    before: [['Malines', -18], ['Bruxelles-Nord', -2]],
    after: [['Bruxelles-Midi', 26]],
  },
  {
    // an extra train, and a very long via list: Welkenraedt via four stops
    train: 'IC', number: '3143', destination: 'Welkenraedt', minutes: 24,
    platform: '3', extra: true,
    before: [['Bruxelles-Midi', -2]],
    after: [
      ['Bruxelles-Nord', 28], ['Louvain', 42], ['Liège-Guillemins', 78],
      ['Verviers-Central', 96], ['Welkenraedt', 108],
    ],
  },
  {
    train: 'L', number: '5382', destination: 'Ottignies', minutes: 27,
    platform: '3',
    before: [['Bruxelles-Nord', 25]],
    after: [
      ['Bruxelles-Luxembourg', 31], ['Etterbeek', 34], ['Watermael', 38],
      ['Rixensart', 50], ['Ottignies', 58],
    ],
  },
  {
    // a train iRail serves no /vehicle journey for (Eurostar and friends):
    // no via list at all, and the details overlay says so
    train: 'EST', number: '9412', destination: 'Amsterdam Centraal',
    minutes: 29, platform: '2', journey: false,
    // no /vehicle journey, and a history all the same: the figures are
    // keyed on the train number and this station, never on the route,
    // so this row shows Performance with no map button beside it
    performance: { windowDays: 30, samples: 22, medianSec: -70, onTimePct: 94, p90Sec: 500 },
  },
  {
    train: 'S2', number: '3641', destination: 'Louvain', minutes: 31,
    delay: 2, platform: '3',
    before: [['Braine-le-Comte', -40], ['Hal', -22], ['Bruxelles-Midi', -6]],
    after: [
      ['Bruxelles-Nord', 35], ['Schaerbeek', 39], ['Haren-Sud', 43],
      ['Vilvorde', 48], ['Louvain', 62],
    ],
  },
  {
    train: 'IC', number: '2612', destination: 'Quévy', minutes: 34,
    platform: '5', cancelled: true,
    before: [['Bruxelles-Nord', 32]],
    after: [
      ['Bruxelles-Midi', 38, true], ['Braine-le-Comte', 56, true],
      ['Mons', 78, true], ['Quévy', 90, true],
    ],
  },
  {
    train: 'S1', number: '1873', destination: 'Nivelles', minutes: 36,
    platform: '4',
    before: [['Anvers-Central', -55], ['Bruxelles-Nord', 34]],
    after: [['Bruxelles-Midi', 40], ['Braine-l-Alleud', 55], ['Nivelles', 62]],
  },
];

const vehicleId = (t) => `BE.NMBS.${t.train}${t.number}`;

// The stop shape `normalizeStop()` produces. A mock stop is plain: it
// arrives a minute before it leaves and carries the train's own delay.
// `occupancy` is the train's own reading, stamped on the board's station
// only — the one stop the details overlay reads it from. Leaving it null
// is the "iRail reported nothing" case the overlay must render silently.
function mockStop([name, minutes, cancelled = false], delay, id = '', occupancy = null) {
  const time = at(minutes);
  return {
    id,
    name,
    time,
    arrival: at(minutes - 1),
    departure: time,
    arrivalDelay: delay,
    departureDelay: delay,
    arrivalCancelled: cancelled,
    departureCancelled: cancelled,
    cancelled,
    platform: null,
    platformChanged: false,
    extra: false,
    occupancy,
  };
}

// The shape `normalizeDeparture()` produces, in `getLiveboard()` order.
function mockDeparture(t) {
  const id = vehicleId(t);
  const time = at(t.minutes);
  return {
    id: `${id}|${Math.floor(time.getTime() / 1000)}`,
    time,
    destination: t.destination,
    train: t.train,
    trainNumber: t.number,
    vehicleId: id,
    platform: t.platform ?? null,
    platformChanged: Boolean(t.platformChanged),
    delay: t.delay ?? 0,
    cancelled: Boolean(t.cancelled),
    left: false,
    extra: Boolean(t.extra),
    intermediateStops: null,
  };
}

const byVehicle = new Map(TRAINS.map((t) => [vehicleId(t), t]));

/* --- the three calls App.jsx makes -------------------------------- */

// Both stop views are memoised for the same reason the real service
// memoises them: the board compares stop lists by identity on every 30 s
// refresh, and a fresh array each time would re-render for nothing.
const stopsCache = new Map();
const routeCache = new Map();

// Stands in for getLiveboard(): the station keeps its real name, so
// ?mock=1 and ?station= describe the same board together.
export function getMockLiveboard(station) {
  return {
    station: station?.name || 'Bruxelles-Central',
    alerts: [],
    departures: TRAINS.map(mockDeparture).sort((a, b) => a.time - b.time),
  };
}

// Stands in for getStops(): the inline "via" list, this station onwards.
export function getMockStops(id, afterTime) {
  const t = byVehicle.get(id);
  if (!t || t.journey === false) return null;
  const key = `${id}|${afterTime.getTime()}`;
  if (!stopsCache.has(key)) {
    const stops = t.after.map((s) => mockStop(s, t.delay ?? 0));
    stopsCache.set(key, stops.filter((s) => s.time > afterTime));
  }
  return stopsCache.get(key);
}

// Stands in for getRoute(): the whole journey, origin to terminus, with
// the board's own station stamped so the timeline can mark it.
export function getMockRoute(id, station) {
  const t = byVehicle.get(id);
  if (!t || t.journey === false) return null;
  const key = `${id}|${station?.id || ''}`;
  if (!routeCache.has(key)) {
    const delay = t.delay ?? 0;
    routeCache.set(key, [
      ...(t.before ?? []).map((s) => mockStop(s, delay)),
      mockStop([getMockLiveboard(station).station, t.minutes], delay, station?.id || '', t.occupancy ?? null),
      ...t.after.map((s) => mockStop(s, delay)),
    ]);
  }
  return routeCache.get(key);
}

/* --- historical performance ---------------------------------------
   Stands in for getPerformance(): the same four states, the same field
   names, the same contract. It exists because the real figures come
   from a static aggregate that is built by a scheduled workflow and
   published on a separate branch, so on a dev machine there is nothing
   to fetch and every train would answer `none` — which is exactly the
   one state that shows none of the layout.

   Nothing here computes a statistic either: the numbers are written
   down, like every other value in this file. The publication
   thresholds are applied rather than assumed, so a fixture can never
   describe a cell the real build script could not have written — a
   median under ten observations, or a p90 under twenty, is dropped
   here the same way it would have been dropped there. */

const MIN_SAMPLES = 10;
const MIN_SAMPLES_P90 = 20;

const byNumber = new Map(TRAINS.map((t) => [t.number, t]));

const NONE = { state: 'none' };

export function getMockPerformance(trainNumber) {
  const spec = byNumber.get(String(trainNumber))?.performance;
  if (!spec) return NONE;

  if (spec.collectingDays) {
    return { state: 'collecting', daysAvailable: spec.collectingDays, throughDay: null };
  }

  const enough = spec.samples >= MIN_SAMPLES && Number.isFinite(spec.medianSec);
  return {
    state: 'ok',
    windowDays: spec.windowDays,
    // Always fresh here: the date is only ever printed once the window
    // has fallen behind, and a fixture that is behind says nothing
    // useful about the layout.
    throughDay: null,
    samples: spec.samples,
    enough,
    medianSec: enough ? spec.medianSec : null,
    onTimePct: enough ? spec.onTimePct : null,
    p90Sec: enough && spec.samples >= MIN_SAMPLES_P90 && Number.isFinite(spec.p90Sec)
      ? spec.p90Sec
      : null,
  };
}
