/* === DEVELOPMENT-ONLY VISUAL TEST DATA ==========================
   Not part of the running board. `App.jsx` reaches this module only
   behind `import.meta.env.DEV && ?mock=<scenario>`, and that guard is a
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
   language: the mock is a layout instrument, not a translation. Only the
   text iRail itself would translate — the liveboard alert and the network
   disturbances — comes in all four languages.

   Scenarios. `?mock=` picks one named scene, and every call below answers
   from that same scene:

     full         (also `?mock=1`) every row state, every footer case
     notices      a liveboard alert and network disturbances together
     performance  one train per Train Details footer combination
     loading      fixed delays: figures before route, and route before figures
     empty        a board with no trains
     few          a board with three trains
     offline      the liveboard request fails, through App's own error path
     overnight    journeys that run past midnight

   An unknown name falls back to `full`: the smallest safe answer, and
   still development-only.

   Deterministic: every time derives from a fixed reference, never from the
   clock, so screenshots and deep links repeat exactly. No randomness.
   ================================================================= */

import { normalizeDisturbances } from './irail.js';

// Wednesday 23 September 2026, 18:00 in Brussels (CEST, UTC+2).
const REFERENCE = new Date('2026-09-23T16:00:00Z');
// The same evening at 23:40, for the journeys that cross midnight.
const OVERNIGHT_REFERENCE = new Date('2026-09-23T21:40:00Z');

let base = REFERENCE;
const at = (minutes) => new Date(base.getTime() + minutes * 60000);
const secondsAt = (minutes) => String(Math.floor(at(minutes).getTime() / 1000));

// A fixed, abortable pause, so load order can be watched. Zero is no pause.
const pause = (ms) => (ms > 0
  ? new Promise((resolve) => { setTimeout(resolve, ms); })
  : Promise.resolve());

/* One table for both consumers: the `after` list is the board's inline
   "via" text and the tail of the details timeline, `before` is where the
   train has come from. Minutes are offsets from BASE. */
const TRAINS = [
  {
    // already gone: `left` is set, as iRail reports a departed train
    train: 'S7', number: '2981', destination: 'Hal', minutes: -4, platform: '6',
    left: true,
    before: [['Vilvorde', -20], ['Bruxelles-Nord', -8]],
    after: [['Bruxelles-Midi', 0], ['Hal', 14]],
  },
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
    before: [["Braine-l'Alleud", -26], ['Bruxelles-Midi', -10]],
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
    // a long via list under the destination
    train: 'IC', number: '3341', destination: 'Louvain-la-Neuve',
    minutes: 18, platform: '3',
    before: [['Bruxelles-Nord', 0]],
    after: [
      ['Bruxelles-Luxembourg', 22], ['Etterbeek', 25], ['Ottignies', 48],
      ['Louvain-la-Neuve', 60],
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
    // ends its run here: an arrival only, never on the departures board
    train: 'IC', number: '2514', destination: null, arrivalOnly: true,
    minutes: 6, delay: 4, platform: '5',
    before: [
      ['Ostende', -80], ['Bruges', -65], ['Gand-Saint-Pierre', -40],
      ['Bruxelles-Midi', -4],
    ],
    after: [],
  },
  {
    // starts its run here: a departure only, never on the arrivals board
    train: 'S5', number: '5125', destination: 'Grammont', minutes: 11,
    platform: '8',
    before: [],
    after: [['Bruxelles-Midi', 15], ['Denderleeuw', 32], ['Grammont', 50]],
  },
  {
    // footer absent: no journey, so no map and no occupancy, and no
    // history either — the longest destination and label on the board
    train: 'ICE', number: '14', destination: 'Frankfurt (Main) Hbf', minutes: 33,
    platform: '1', journey: false,
  },
  {
    train: 'S1', number: '1873', destination: 'Nivelles', minutes: 36,
    platform: '4',
    before: [['Anvers-Central', -55], ['Bruxelles-Nord', 34]],
    after: [['Bruxelles-Midi', 40], ["Braine-l'Alleud", 55], ['Nivelles', 62]],
  },
];

const vehicleId = (t) => `BE.NMBS.${t.train}${t.number}`;

// The stop shape `normalizeStop()` produces. A mock stop is plain: it
// arrives a minute before it leaves and carries the train's own delay.
// `occupancy` is the train's own reading, stamped on the board's station
// only — the one stop the details overlay reads it from. Leaving it null
// is the "iRail reported nothing" case the overlay must render silently.
function mockStop([name, minutes, cancelled = false, stopDelay], trainDelay, id = '', occupancy = null) {
  const time = at(minutes);
  const delay = stopDelay ?? trainDelay;
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
// An arrival is the same train seen from the other side: it gets in a
// minute before it leaves (as `mockStop` has it), and the station the row
// names is where it came from.
function mockDeparture(t, arrival = false) {
  const id = vehicleId(t);
  const time = at(arrival ? t.minutes - 1 : t.minutes);
  return {
    id: `${id}|${Math.floor(time.getTime() / 1000)}`,
    time,
    destination: arrival ? t.before[0][0] : t.destination,
    arrival,
    train: t.train,
    trainNumber: t.number,
    vehicleId: id,
    platform: t.platform ?? null,
    platformChanged: Boolean(t.platformChanged),
    delay: t.delay ?? 0,
    cancelled: Boolean(t.cancelled),
    left: Boolean(t.left),
    extra: Boolean(t.extra),
    intermediateStops: null,
  };
}


/* --- the other scenes' trains ------------------------------------ */

const pick = (...numbers) => numbers.map((n) => TRAINS.find((t) => t.number === n));

// Train Details footer, one train per combination. Each comment names the
// case; the footer's own rules decide what is drawn.
const PERFORMANCE_TRAINS = [
  // 1. Performance + Map — two figures, no p90 (fourteen journeys)
  { ...pick('1832')[0], occupancy: null },
  // 2. Performance only — no journey, an early (negative) median
  pick('9412')[0],
  // 3. Map only — a route, no history, no occupancy (Performance `none`)
  { ...pick('2134')[0], occupancy: null },
  // 4. neither — no journey, no history: the footer is not drawn
  pick('14')[0],
  // 5. Occupancy + Performance + Map — all three figures
  pick('4287')[0],
  // 6. collecting Performance + Map
  { ...pick('3311')[0], occupancy: null },
  // 7. stale Performance, no Map
  {
    train: 'IC', number: '4521', destination: 'Namur', minutes: 19, platform: '5',
    journey: false, performance: { stale: true },
  },
  // low sample count in a real window, beside a high occupancy and a map
  pick('1852')[0],
];

// Two trains, opposite load orders, fixed delays (ms).
const LOADING_TRAINS = [
  // Performance first: figures after 0.5 s, route after 2 s
  { ...pick('1832')[0], routeDelayMs: 2000, performanceDelayMs: 500 },
  // route first: route after 0.5 s, figures after 2 s
  { ...pick('4287')[0], routeDelayMs: 500, performanceDelayMs: 2000 },
  ...pick('1715', '3540'),
];

// Late evening: the board is at 23:40 and the routes run into the next day.
const OVERNIGHT_TRAINS = [
  {
    train: 'IC', number: '2849', destination: 'Ostende', minutes: 12, platform: '3',
    delay: 6,
    before: [['Louvain', -18], ['Bruxelles-Nord', 9]],
    after: [
      ['Bruxelles-Midi', 16], ['Gand-Saint-Pierre', 45], ['Bruges', 68], ['Ostende', 82],
    ],
    performance: { windowDays: 30, samples: 27, medianSec: 240, onTimePct: 74, p90Sec: 720 },
  },
  {
    train: 'S1', number: '1899', destination: 'Nivelles', minutes: 25, platform: '4',
    before: [['Anvers-Central', -12], ['Malines', 4], ['Bruxelles-Nord', 21]],
    after: [["Braine-l'Alleud", 44], ['Nivelles', 52]],
  },
  {
    // ends here just after midnight: an arrival only
    train: 'IC', number: '2551', destination: null, arrivalOnly: true,
    minutes: 22, platform: '5',
    before: [['Liège-Guillemins', -50], ['Louvain', -12], ['Bruxelles-Nord', 18]],
    after: [],
  },
];

/* --- API-localised text: alert and network disturbances ----------- */

// What a /liveboard `alerts` entry reads as once normalised.
const ALERT = {
  nl: 'Werken tussen Brussel-Noord en Mechelen: reken op 10 minuten extra reistijd.',
  fr: 'Travaux entre Bruxelles-Nord et Malines : prévoyez 10 minutes de trajet en plus.',
  en: 'Works between Brussels-North and Mechelen: allow 10 extra minutes.',
  de: 'Bauarbeiten zwischen Brüssel-Nord und Mechelen: 10 Minuten mehr Fahrzeit einplanen.',
};

const NOTICE = {
  nl: ['Brussel-Zuid - Halle: verstoord treinverkeer', 'Door een defect aan de bovenleiding is het treinverkeer verstoord.\n\nReken op vertragingen.', 'https://www.belgiantrain.be/nl/travel-info'],
  fr: ['Bruxelles-Midi - Hal : trafic perturbé', 'En raison d’un dégât à la caténaire, le trafic ferroviaire est perturbé.\n\nDes retards sont à prévoir.', 'https://www.belgiantrain.be/fr/travel-info'],
  en: ['Brussels-South - Halle: disrupted traffic', 'Due to damage to the overhead lines, rail traffic is disrupted.\n\nDelays are expected.', 'https://www.belgiantrain.be/en/travel-info'],
  de: ['Brüssel-Süd - Halle: gestörter Zugverkehr', 'Aufgrund eines Oberleitungsschadens ist der Zugverkehr gestört.\n\nMit Verspätungen ist zu rechnen.', 'https://www.belgiantrain.be/de/travel-info'],
};

const LONG_NOTICE = {
  nl: ['Antwerpen-Centraal / Antwerpen-Berchem - Mechelen - Brussel-Noord / Brussel-Centraal: sterk verstoord treinverkeer na een incident op het spoor', 'Door een incident op het spoor tussen Mechelen en Vilvoorde kan er op slechts één spoor gereden worden.\n\nEr zijn vertragingen tot 30 minuten mogelijk. Sommige treinen worden afgeschaft.\n\nLuister naar de aankondigingen en raadpleeg de schermen in het station.'],
  fr: ['Anvers-Central / Anvers-Berchem - Malines - Bruxelles-Nord / Bruxelles-Central : trafic fortement perturbé à la suite d’un incident sur les voies', 'En raison d’un incident sur les voies entre Malines et Vilvorde, les trains circulent sur une seule voie.\n\nDes retards jusqu’à 30 minutes sont possibles. Certains trains sont supprimés.\n\nÉcoutez les annonces et consultez les écrans en gare.'],
  en: ['Antwerp-Central / Antwerp-Berchem - Mechelen - Brussels-North / Brussels-Central: heavily disrupted traffic after an incident on the tracks', 'Due to an incident on the tracks between Mechelen and Vilvoorde, trains are running on a single track.\n\nDelays of up to 30 minutes are possible. Some trains are cancelled.\n\nListen to the announcements and check the screens in the station.'],
  de: ['Antwerpen-Zentral / Antwerpen-Berchem - Mechelen - Brüssel-Nord / Brüssel-Zentral: stark gestörter Zugverkehr nach einem Vorfall auf den Gleisen', 'Aufgrund eines Vorfalls auf den Gleisen zwischen Mechelen und Vilvoorde fahren die Züge nur auf einem Gleis.\n\nVerspätungen bis zu 30 Minuten sind möglich. Einige Züge fallen aus.\n\nAchten Sie auf die Durchsagen und die Bildschirme im Bahnhof.'],
};

// Raw /disturbances items, in iRail's own string shape, so the production
// normaliser does the filtering. `lang` picks the translated text.
const raw = (fields) => ({
  id: '0', title: '', description: '', type: 'disturbance', link: '',
  timestamp: secondsAt(-20), richtext: '', descriptionLinks: { number: '0', descriptionLink: [] },
  ...fields,
});
const normalItem = (lang) => {
  const [title, description, link] = NOTICE[lang] ?? NOTICE.en;
  return raw({ title, description, link, timestamp: secondsAt(-12) });
};
const longItem = (lang) => {
  const [title, description] = LONG_NOTICE[lang] ?? LONG_NOTICE.en;
  return raw({ title, description, link: 'http://www.belgianrail.be/jp/nmbs-realtime/help.exe/en?messageID=1', timestamp: secondsAt(-47) });
};
const plannedItem = () => raw({
  type: 'planned', title: 'Herentals - Turnhout/Mol', description: 'Weekend works.',
  link: 'https://www.belgiantrain.be/nl/news/works', timestamp: secondsAt(-3000),
});

// Every edge case the strip and panel must survive, as raw responses.
// Not reachable by URL: tests and manual QA pass one to the normaliser.
export const DISTURBANCE_FIXTURES = {
  none: () => [],
  one: (lang = 'en') => [normalItem(lang)],
  many: (lang = 'en') => [normalItem(lang), longItem(lang)],
  plannedOnly: () => [plannedItem()],
  mixed: (lang = 'en') => [plannedItem(), normalItem(lang), longItem(lang)],
  edges: () => [
    raw({ title: 'No time given', description: 'Timestamp missing.', timestamp: '', link: 'https://www.belgiantrain.be/' }),
    raw({ title: 'Bad time', description: 'Timestamp invalid.', timestamp: 'soon', link: 'http://www.belgianrail.be/' }),
    raw({ title: 'Bad link', description: 'Link not a web address.', link: 'javascript:alert(1)' }),
    raw({ title: '', description: 'No title: dropped.' }),
  ],
};

export const disturbanceResponse = (items) => ({
  version: '1.4', timestamp: secondsAt(0), disturbance: items,
});

/* --- scenarios ------------------------------------------------------ */

const SCENARIOS = {
  full: { base: REFERENCE, trains: TRAINS },
  notices: {
    base: REFERENCE,
    trains: TRAINS.slice(0, 9),
    alert: ALERT,
    disturbances: DISTURBANCE_FIXTURES.mixed,
  },
  performance: { base: REFERENCE, trains: PERFORMANCE_TRAINS },
  loading: { base: REFERENCE, trains: LOADING_TRAINS },
  empty: { base: REFERENCE, trains: [] },
  few: { base: REFERENCE, trains: TRAINS.slice(1, 4) },
  offline: { base: REFERENCE, trains: TRAINS, offline: true },
  overnight: { base: OVERNIGHT_REFERENCE, trains: OVERNIGHT_TRAINS },
};

export const MOCK_SCENARIOS = Object.keys(SCENARIOS);

// `1` is the original switch and means the full board; anything unknown
// falls back to it too.
export function resolveScenario(value) {
  if (value === '1') return 'full';
  return Object.hasOwn(SCENARIOS, value) ? value : 'full';
}

let scenarioName = 'full';
let scenario = SCENARIOS.full;

// Called by App with the `mock` value. Idempotent; a new scene drops the
// stop caches of the previous one.
export function selectMockScenario(value) {
  const name = resolveScenario(value);
  if (name !== scenarioName) {
    scenarioName = name;
    scenario = SCENARIOS[name];
    base = scenario.base;
    stopsCache.clear();
    routeCache.clear();
  }
  return scenarioName;
}

// The scene's fixed "now", for the title-bar clock and "last updated".
export const mockNow = () => base;

const byVehicle = (id) => scenario.trains.find((t) => vehicleId(t) === id);
const byNumber = (number) => scenario.trains.find((t) => t.number === String(number));

/* --- the calls App.jsx makes ---------------------------------------- */

// Both stop views are memoised for the same reason the real service
// memoises them: the board compares stop lists by identity on every 30 s
// refresh, and a fresh array each time would re-render for nothing.
const stopsCache = new Map();
const routeCache = new Map();

const boardStation = (station) => station?.name || 'Bruxelles-Central';

// Stands in for getLiveboard(): the station keeps its real name, so
// ?mock= and ?station= describe the same board together.
// Arrivals list every train that came from somewhere; departures every
// train that goes on. `offline` fails the way a network error does, so
// App's own failure path draws the notice.
export async function getMockLiveboard(station, mode = 'departures', lang = 'en') {
  if (scenario.offline) throw new TypeError('Failed to fetch (mock offline)');
  const arrival = mode === 'arrivals';
  const trains = arrival
    ? scenario.trains.filter((t) => t.before?.length)
    : scenario.trains.filter((t) => !t.arrivalOnly);
  return {
    station: boardStation(station),
    alerts: scenario.alert ? [scenario.alert[lang] ?? scenario.alert.en] : [],
    departures: trains.map((t) => mockDeparture(t, arrival)).sort((a, b) => a.time - b.time),
  };
}

// Stands in for getStops(): the inline "via" list, this station onwards,
// or — `direction` 'before' — origin up to this station.
export function getMockStops(id, afterTime, direction = 'after') {
  const t = byVehicle(id);
  if (!t || t.journey === false) return null;
  const before = direction === 'before';
  const key = `${id}|${afterTime.getTime()}|${direction}`;
  if (!stopsCache.has(key)) {
    const stops = (before ? t.before : t.after).map((s) => mockStop(s, t.delay ?? 0));
    stopsCache.set(key, stops.filter((s) => (before ? s.time < afterTime : s.time > afterTime)));
  }
  return stopsCache.get(key);
}

// Stands in for getRoute(): the whole journey, origin to terminus, with
// the board's own station stamped so the timeline can mark it.
export async function getMockRoute(id, station) {
  const t = byVehicle(id);
  await pause(t?.routeDelayMs);
  if (!t || t.journey === false) return null;
  const key = `${id}|${station?.id || ''}`;
  if (!routeCache.has(key)) {
    const delay = t.delay ?? 0;
    routeCache.set(key, [
      ...(t.before ?? []).map((s) => mockStop(s, delay)),
      mockStop([boardStation(station), t.minutes], delay, station?.id || '', t.occupancy ?? null),
      ...t.after.map((s) => mockStop(s, delay)),
    ]);
  }
  return routeCache.get(key);
}

// Stands in for getDisturbances(): the scene's raw items, through the
// production normaliser, so only `type: "disturbance"` survives.
export async function getMockDisturbances(lang = 'en') {
  return normalizeDisturbances(disturbanceResponse(scenario.disturbances?.(lang) ?? []));
}

/* --- historical performance ---------------------------------------
   Stands in for getPerformance(): the same states, the same field
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

const NONE = { state: 'none' };

export async function getMockPerformance(trainNumber) {
  const t = byNumber(trainNumber);
  await pause(t?.performanceDelayMs);
  const spec = t?.performance;
  if (!spec) return NONE;

  if (spec.stale) return { state: 'stale' };

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
