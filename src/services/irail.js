/* ------------------------------------------------------------------
   iRail API layer — https://docs.irail.be/

   Three calls are used:
     /stations   the station list, for the picker and the URL slugs
     /liveboard  departures, delays, platforms, cancellations, alerts
     /vehicle    the intermediate stations of one train

   The raw responses are strings all the way down, so everything is
   normalised here into the small internal shape the board renders.

   Every one of those calls leaves through the one scheduler below, so
   the whole application has a single iRail request budget rather than
   one per endpoint.
   ------------------------------------------------------------------ */

const API = 'https://api.irail.be/v1';

class IRailHttpError extends Error {
  constructor(res) {
    super(`iRail ${res.status} ${res.statusText}`);
    this.name = 'IRailHttpError';
    this.status = res.status;
  }
}

async function apiGet(path, params, signal) {
  const url = new URL(API + path);
  Object.entries({ format: 'json', ...params })
    .forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new IRailHttpError(res);
  return res.json();
}

/* --- the global request scheduler -------------------------------- */

// iRail allows 3 requests per second per IP and answers 429 above that
// (docs.irail.be, "Request limits"). That budget belongs to the whole
// application, not to one endpoint, so every genuine iRail HTTP request
// is dispatched from here and nothing else calls `apiGet` directly. Two
// independent limiters would each look polite and still add up to a 429.
//
// The rule is a minimum gap between *dispatches*, not between responses:
// a slow train lookup must not stall the board's own refresh.
const MIN_DISPATCH_GAP = 400;

// A 429 means the pacing was not enough after all — most likely because
// something else on this IP is also talking to iRail. Push the next slot
// out once rather than retrying: the failed request is handled by its
// caller's own (transient, non-looping) semantics.
const RATE_LIMIT_PAUSE = 2_000;

// Long enough for iRail's slowest healthy answer, short enough that one
// hung request cannot hold the serialized journey lane forever. It is
// measured from dispatch, never from the moment a job was queued.
const REQUEST_TIMEOUT = 15_000;

// High priority is tiny and rare — a board load, a board refresh, the
// station list. It still must not be able to hold off journey work
// indefinitely, so it yields a slot after this many dispatches in a row.
const MAX_CONSECUTIVE_HIGH = 4;

const queues = { high: [], normal: [] };
let nextDispatchAt = 0;
let pumping = false;
// Journey lookups keep the serialized, one-at-a-time behaviour they have
// always had; board requests are free to overlap them.
let serialBusy = false;
let consecutiveHigh = 0;

function abortError() {
  const err = new Error('Request aborted');
  err.name = 'AbortError';
  return err;
}

// A request that never came back. Deliberately not an AbortError: the
// caller cancelled nothing, so this is a real (and retryable) failure.
class IRailTimeoutError extends Error {
  constructor(path) {
    super(`iRail ${path} timed out`);
    this.name = 'IRailTimeoutError';
  }
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A job can run when it is not a serialized one waiting on another.
const runnable = (job) => !job.serial || !serialBusy;
const hasRunnable = () => queues.high.some(runnable) || queues.normal.some(runnable);

// Chosen at the moment a slot opens, not when the job was queued, so a
// board refresh that arrives mid-scan takes the very next slot.
function takeJob() {
  const order = consecutiveHigh >= MAX_CONSECUTIVE_HIGH
    ? ['normal', 'high']
    : ['high', 'normal'];
  for (const name of order) {
    const index = queues[name].findIndex(runnable);
    if (index === -1) continue;
    const [job] = queues[name].splice(index, 1);
    consecutiveHigh = name === 'high' ? consecutiveHigh + 1 : 0;
    return job;
  }
  return null;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      if (!hasRunnable()) return;
      const wait = nextDispatchAt - Date.now();
      if (wait > 0) await delay(wait);
      const job = takeJob();
      if (!job) return;
      // Superseded while it waited its turn: fail it as the abort it is
      // and spend the slot on something that still matters.
      if (job.signal?.aborted) { job.reject(abortError()); continue; }
      nextDispatchAt = Date.now() + MIN_DISPATCH_GAP;
      if (job.serial) serialBusy = true;
      // Not awaited: the gap paces dispatches, and one job's failure or
      // slowness must never stall or poison the ones behind it.
      dispatch(job);
    }
  } finally {
    pumping = false;
  }
}

function dispatch(job) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, job.timeout);
  job.signal?.addEventListener('abort', abort);
  apiGet(job.path, job.params, controller.signal)
    .then(job.resolve, (err) => {
      if (err instanceof IRailHttpError && err.status === 429) {
        nextDispatchAt = Math.max(nextDispatchAt, Date.now() + RATE_LIMIT_PAUSE);
      }
      job.reject(timedOut ? new IRailTimeoutError(job.path) : err);
    })
    .finally(() => {
      clearTimeout(timer);
      job.signal?.removeEventListener('abort', abort);
      if (job.serial) serialBusy = false;
      pump();
    });
}

// The only way to reach iRail. `priority: 'high'` is for the small
// requests that decide what is on screen right now; `serial: true` keeps
// a lane one-at-a-time within the shared budget.
function request(path, params, {
  priority = 'normal', serial = false, signal = null, timeout = REQUEST_TIMEOUT,
} = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    queues[priority].push({ path, params, serial, signal, timeout, resolve, reject });
    pump();
  });
}

/* --- normalisation ---------------------------------------------- */

// Bilingual station names arrive as "Brussel-Noord/Bruxelles-Nord".
// The screens print one language, so keep the side matching `lang`.
function oneLanguage(name, lang) {
  if (!name || !name.includes('/')) return name || '';
  const parts = name.split('/');
  return (lang === 'fr' ? parts[1] : parts[0]).trim() || name;
}

// `stationinfo.name` is the only field iRail translates; `standardname`
// is the fixed canonical one (Mons stays "Mons" even in Dutch). Prefer
// the translated name, then reduce it if it still carries two languages.
function stationName(info, fallback, lang) {
  return oneLanguage(info?.name || info?.standardname || fallback || '', lang);
}

const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const bool = (v) => v === '1' || v === 1 || v === true;

// Reported passenger load, as iRail sends it on a stop: an object whose
// `name` is one of low / medium / high / unknown. Only a real reading is
// kept — "unknown", a missing object and anything unrecognised all become
// null, so nothing downstream has to invent or infer a load.
const OCCUPANCY_LEVELS = new Set(['low', 'medium', 'high']);

function occupancyLevel(value) {
  const name = (value?.name || '').toLowerCase();
  return OCCUPANCY_LEVELS.has(name) ? name : null;
}

function parseUnixSeconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed * 1000) : null;
}

// iRail publishes a station's position as `locationX` (longitude) and
// `locationY` (latitude). The raw names say nothing about which is which,
// so they are read once, here, and travel as a named pair; nothing
// downstream handles an X or a Y.
//
// Only a usable position survives: a missing, non-numeric or
// out-of-range value becomes null rather than 0, because 0,0 is a real
// point in the Atlantic and would be drawn as one. iRail also reports
// exactly 0,0 for a vehicle it has no position for, which is why that
// pair is treated as absent rather than as the Gulf of Guinea.
function coordinates(info) {
  const longitude = Number(info?.locationX);
  const latitude = Number(info?.locationY);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude === 0 && latitude === 0) return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  return { longitude, latitude };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

// The board prints the service label on its own ("IC", "S7", "EUR", "L"),
// so the category has to be separated from the train number.
//
// `shortname` is the only human-readable label iRail documents: the
// /vehicle schema lists it as required, while `type` and `number` appear
// in neither schema nor example and are therefore treated as a bonus, not
// as contract. Live responses currently space it ("IC 721", "S43 18921"),
// but the documented example does not ("IC3033"), so both are handled:
//   spaced    → split on the space, which is unambiguous
//   unspaced  → "S86592" could be S8/6592 or S86/592, so defer to
//               type/number when present, and otherwise fall back to a
//               plain letters/digits split rather than guess.
function vehicleLabel(info) {
  const shortname = (info?.shortname || '').trim();
  const spaced = /^(\S+)\s+(\d+)$/.exec(shortname);
  if (spaced) return { train: spaced[1], trainNumber: spaced[2] };
  if (info?.type) return { train: info.type, trainNumber: info.number || '' };
  const run = /^([A-Za-z]+)(\d*)$/.exec(shortname);
  if (run) return { train: run[1], trainNumber: run[2] };
  // Nothing usable: show whatever label there is, or nothing at all.
  return { train: shortname, trainNumber: info?.number || '' };
}

// One row of either board. On a departures board `stationinfo` is where
// the train is going and `time` is its scheduled departure; on an arrivals
// board the same fields are where it came from and its scheduled arrival.
// The row keeps one shape — `destination` is simply the station the row is
// about — and `arrival` says which reading applies.
function normalizeDeparture(d, lang, index, arrival = false) {
  const platform = d.platforminfo?.name ?? d.platform ?? null;
  const vehicleId = d.vehicleinfo?.name || d.vehicle || '';
  const time = parseUnixSeconds(d.time);
  if (!time) return null;
  const label = vehicleLabel(d.vehicleinfo);
  const destination = stationName(d.stationinfo, d.station, lang);
  const id = vehicleId
    ? `${vehicleId}|${Number(d.time)}`
    : `malformed|${destination}|${label.train}|${platform || ''}|${index}`;
  return {
    id,
    time,                                  // scheduled departure, or arrival
    destination,                           // the origin on an arrivals board
    arrival,
    ...label,
    vehicleId,
    platform: platform && platform !== '?' ? platform : null,
    platformChanged: d.platforminfo ? !bool(d.platforminfo.normal) : false,
    delay: Math.round(num(d.delay) / 60),          // minutes
    cancelled: bool(d.canceled),
    // `left` on a departures board, `arrived` on an arrivals board: either
    // way the train is no longer coming and drops off the board.
    left: bool(arrival ? d.arrived : d.left),
    extra: bool(d.isExtra),
    intermediateStops: null,                       // filled in by getStops()
  };
}

function extractAlerts(json) {
  const a = json?.alerts?.alert ?? json?.alert ?? [];
  return asArray(a)
    .filter(Boolean)
    .map((x) => [x.header, x.description].filter(Boolean).join(' — '))
    .filter(Boolean);
}

/* --- public API -------------------------------------------------- */

// iRail station ids look like "BE.NMBS.008813003". /liveboard takes either
// `station` (a name) or `id` (an iRail id) and the docs are explicit that the
// two must not be sent together, so pick the right one for what we were given.
const isStationId = (v) => /^BE\.NMBS\.\d+$/.test(v);

// High priority: this is the request that decides what is on screen, so
// it takes the next free slot rather than queueing behind a route scan.
// `mode` is 'departures' (the default) or 'arrivals': the same request,
// asked with the other `arrdep`, answered under the other key.
export async function getLiveboard(station, lang = 'nl', signal, mode = 'departures') {
  const arrival = mode === 'arrivals';
  const json = await request('/liveboard', {
    ...(isStationId(station) ? { id: station } : { station }),
    arrdep: arrival ? 'arrival' : 'departure', alerts: 'true', lang,
  }, { priority: 'high', signal });
  const raw = asArray(arrival ? json?.arrivals?.arrival : json?.departures?.departure);
  return {
    station: stationName(json?.stationinfo, json?.station, lang) || station,
    alerts: extractAlerts(json),
    departures: raw
      .map((d, index) => normalizeDeparture(d, lang, index, arrival))
      .filter(Boolean)
      .filter((t) => !t.left)
      .sort((a, b) => a.time - b.time),
  };
}

// One train's journey, from /vehicle. Cached per train, per day and per
// language, and dispatched through the shared scheduler on the serialized
// lane, so a board full of rows never breaks the 3 req/s limit. The entry
// is cached the moment it is asked for, not when the network answers, so
// callers that arrive while it is still queued share the same promise
// rather than queueing a second identical request. All three consumers
// read this one entry: the board's inline "via" list, the From -> To
// filter and the details overlay's route timeline.
//
// A genuine missing journey resolves to null so an unavailable train
// (Eurostar, for instance) never breaks the board. Transient failures are
// evicted so a later queued call can retry them.
const stopsCache = new Map();
const stopsMeta = new Map();
const sliceCache = new Map();
const sliceMeta = new Map();
const MAX_JOURNEYS = 256;
const MAX_SLICES = 512;
let cacheOrder = 0;

const serviceDayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit',
});

function serviceDay(date) {
  const parts = Object.fromEntries(
    serviceDayFormat.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]));
  const key = `${parts.year}-${parts.month}-${parts.day}`;
  const requestDate = `${parts.day}${parts.month}${parts.year.slice(-2)}`;
  const number = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000;
  return { key, requestDate, number };
}

function pruneCompleted(cache, meta, max) {
  // Keep yesterday as well as today: Belgian services around midnight may
  // legitimately span both dates. Future-dated departures are also retained.
  const oldestDay = serviceDay(new Date()).number - 1;
  for (const [key, entry] of meta) {
    if (entry.completed && entry.day < oldestDay) {
      cache.delete(key);
      meta.delete(key);
    }
  }
  if (cache.size <= max) return;
  const completed = [...meta.entries()]
    .filter(([, entry]) => entry.completed)
    .sort((a, b) => a[1].order - b[1].order);
  for (const [key] of completed) {
    if (cache.size <= max) break;
    cache.delete(key);
    meta.delete(key);
  }
}

function cachePromise(cache, meta, key, promise, day, max) {
  cache.set(key, promise);
  meta.set(key, { promise, day, order: cacheOrder += 1, completed: false });
  const settled = () => {
    const entry = meta.get(key);
    if (!entry || entry.promise !== promise) return;
    entry.completed = true;
    pruneCompleted(cache, meta, max);
  };
  promise.then(settled, settled);
  pruneCompleted(cache, meta, max);
  return promise;
}

function evictPromise(cache, meta, key, promise) {
  if (cache.get(key) !== promise) return;
  cache.delete(key);
  meta.delete(key);
}

// The documented /vehicle stop fields, kept whole: the board only needs
// name/time/cancelled, but the details overlay needs the arrival and
// departure sides separately, the platform and the per-stop flags.
function normalizeStop(s, lang) {
  const platform = s.platforminfo?.name ?? s.platform ?? null;
  const arrival = parseUnixSeconds(s.scheduledArrivalTime);
  const departure = parseUnixSeconds(s.scheduledDepartureTime);
  return {
    // Station identity, used to mark the board's own station on the
    // timeline. Never displayed.
    id: s.stationinfo?.id || '',
    name: stationName(s.stationinfo, s.station, lang),
    // The canonical name, identical in all four languages. The route map
    // matches stops against Infrabel by name, so it needs the untranslated
    // one as well as the displayed one.
    standardname: s.stationinfo?.standardname || '',
    // Where the station is, for the optional route map's markers. Null
    // when iRail sent nothing usable; never a zero pair.
    coordinates: coordinates(s.stationinfo),
    // The stop's primary time, as the board has always used it.
    time: parseUnixSeconds(s.time) ?? departure ?? arrival,
    arrival,
    departure,
    arrivalDelay: Math.round(num(s.arrivalDelay) / 60),        // minutes
    departureDelay: Math.round(num(s.departureDelay) / 60),    // minutes
    arrivalCancelled: bool(s.arrivalCanceled),
    departureCancelled: bool(s.departureCanceled),
    cancelled: bool(s.departureCanceled ?? s.canceled) || bool(s.arrivalCanceled),
    platform: platform && platform !== '?' ? platform : null,
    platformChanged: s.platforminfo ? !bool(s.platforminfo.normal) : false,
    extra: bool(s.isExtraStop ?? s.isExtra),
    // Passenger load reported for this stop, or null when iRail has none.
    occupancy: occupancyLevel(s.occupancy),
  };
}

function getJourney(vehicleId, day, lang) {
  const service = serviceDay(day);
  const key = `${vehicleId}|${service.key}|${lang}`;
  if (!stopsCache.has(key)) {
    let journey;
    journey = request('/vehicle', {
      id: vehicleId, date: service.requestDate, alerts: 'true', lang,
    }, { priority: 'normal', serial: true })
      .then((json) => asArray(json?.stops?.stop)
        .map((s) => normalizeStop(s, lang))
        .filter((s) => s.name))
      .catch((err) => {
        if (err instanceof IRailHttpError && err.status === 404) return null;
        evictPromise(stopsCache, stopsMeta, key, journey);
        throw err;
      });
    cachePromise(stopsCache, stopsMeta, key, journey, service.number, MAX_JOURNEYS);
  }
  return stopsCache.get(key);
}

// What the board and the route filter learn about one train, as three
// genuinely different answers rather than a list-or-nothing:
//
//   ok           the journey is known; `stops` is it, sliced to the part
//                after this departure — the only thing that can prove or
//                disprove that a train serves a destination
//   unavailable  iRail has no journey for this train (a Eurostar, say).
//                Not evidence of anything: the train may well call at the
//                destination, we simply cannot see its stops
//   failed       a timeout, a 429, a temporary network fault. Also not
//                evidence, and deliberately not cached, so the next poll
//                asks again
//
// Only `ok` is ever a definitive answer. Collapsing the other two into
// "no stops" is what would let the board claim there is no direct train
// when the truth is that it could not look.
const UNAVAILABLE = { status: 'unavailable', stops: null };
const FAILED = { status: 'failed', stops: null };

// Intermediate stations of one train, from this station up to the
// terminus — what the board prints inline. An arrivals board asks for the
// other side (`direction` 'before'): origin up to, not including, this
// station, still in travel order. Both are slices of the one journey. The slice is memoised as well
// as the journey: the board compares stop lists by identity on every
// 30 s refresh, and a fresh array each time would re-render for nothing.
// The two constants above are shared for the same reason.
export function getStops(vehicleId, afterTime, lang = 'nl', direction = 'after') {
  if (!vehicleId) return Promise.resolve(UNAVAILABLE);
  const service = serviceDay(afterTime);
  const before = direction === 'before';
  const key = `${vehicleId}|${afterTime.getTime()}|${lang}${before ? '|before' : ''}`;
  if (!sliceCache.has(key)) {
    let slice;
    slice = getJourney(vehicleId, afterTime, lang)
      .then((stops) => (stops
        ? {
          status: 'ok',
          stops: stops.filter((s) => (before
            ? s.time && s.time < afterTime
            : s.time > afterTime)),
        }
        : UNAVAILABLE))
      .catch(() => {
        // Transient: drop the entry so a later call retries it. No retry
        // is scheduled here — the next liveboard poll is the retry.
        evictPromise(sliceCache, sliceMeta, key, slice);
        return FAILED;
      });
    cachePromise(sliceCache, sliceMeta, key, slice, service.number, MAX_SLICES);
  }
  return sliceCache.get(key);
}

// The complete journey, first stop to terminus, for the details overlay.
// Same cache entry and same queue as getStops: opening the overlay on a
// train the board has already listed costs no request at all.
export function getRoute(vehicleId, dayTime, lang = 'nl') {
  if (!vehicleId) return Promise.resolve(null);
  return getJourney(vehicleId, dayTime, lang)
    .then((stops) => (stops?.length ? stops : null))
    .catch(() => null);
}

/* --- station list ------------------------------------------------ */

// Every Belgian station, fetched once per language and kept for the
// session: a few hundred entries that never change while the board is
// open. Keyed by language, since the names come back translated.
const stationsByLang = new Map();

// iRail lists the foreign stations its trains reach as well — Paris Nord,
// Sète, Saverne. The UIC id carries the country (88 Belgium, 87 France,
// 84 Netherlands, 80 Germany), so the board's picker keeps only 88.
const isBelgian = (id) => /^BE\.NMBS\.0088/.test(id);

export function getStations(lang = 'nl') {
  if (!stationsByLang.has(lang)) {
    stationsByLang.set(lang, request('/stations', { lang }, { priority: 'high' })
      .then((json) => asArray(json?.station)
        .filter((s) => s.id && isBelgian(s.id))
        .map((s) => {
          // `standardname` is the same in all four languages and is present
          // on every station, which is what makes it the slug source.
          const standardname = s.standardname || s.name || '';
          return {
            id: s.id,
            // What the list shows: the name in the chosen language.
            name: s.name || standardname,
            // Also searched, so "Mons" still finds Bergen and vice versa.
            standardname,
            slug: stationToSlug({ standardname }),
            // Every language half of both names, so a slug typed in the
            // other language still resolves: "bruxelles-midi" as well as
            // "brussel-zuid".
            slugs: slugAliases(s),
            // Only for "nearest station"; null when iRail gives no usable pair.
            location: coordinates(s),
          };
        })
        .filter((s) => s.name))
      .catch((err) => { stationsByLang.delete(lang); throw err; }));
  }
  return stationsByLang.get(lang);
}

/* --- readable slugs ---------------------------------------------- */

// The visible URL carries a readable slug, never an iRail id. The slug is
// only a way of naming a station in the address bar: it is resolved back to
// a real station object from /stations, and it is that object's canonical
// `id` that every API request uses. A slug is never turned into an id by
// string manipulation.
//
// Derived from `standardname`, which the API returns identically in nl, fr,
// en and de and populates for every station, so a shared URL does not change
// meaning when the reader's board is in another language. `name` is only a
// fallback, and it is translated.
export function stationToSlug(station) {
  const source = station?.standardname || station?.name || '';
  // Bilingual names ("Brussel-Zuid/Bruxelles-Midi") would otherwise slug to
  // both halves at once; the first half is the deterministic choice.
  return slugify(source.split('/')[0] || source);
}

function slugify(value) {
  return (value || '')
    .normalize('NFD')              // strip accents: Liège -> Liege
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')   // spaces, apostrophes, dots, slashes
    .replace(/^-+|-+$/g, '');
}

// Both halves of both names, so either language resolves the same station.
function slugAliases(raw) {
  const parts = [raw.standardname, raw.name]
    .filter(Boolean)
    .flatMap((n) => [n, ...n.split('/')]);
  return [...new Set(parts.map(slugify).filter(Boolean))];
}

// Slugs are unique across the Belgian station list today, canonical and
// alias alike. Should a future list collide, a canonical slug wins over an
// alias and the lowest id breaks the remaining tie, so the result stays
// deterministic instead of depending on array order.
export function findStationBySlug(stations, slug) {
  const wanted = slugify(slug);
  if (!wanted || !stations?.length) return null;
  const matches = stations.filter(
    (s) => s.slug === wanted || s.slugs.includes(wanted));
  if (matches.length < 2) return matches[0] || null;
  const canonical = matches.filter((s) => s.slug === wanted);
  return (canonical.length ? canonical : matches)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}

/* --- station search ---------------------------------------------- */

// Accents and punctuation differ between the two language halves of a
// name ("Liège-Guillemins" / "Luik-Guillemins"), so fold both sides.
const fold = (s) => s
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// iRail has no measure of how busy a station is, so a short list of the
// ones people actually board at carries that weight. A single typed letter
// should offer Sint-Niklaas before the halt at Sy.
// Roughly in order of how busy they are, and that order is the tiebreak:
// "gent" should offer Gent-Sint-Pieters before Gent-Dampoort.
const MAJOR_ORDER = [
  'brussel zuid', 'bruxelles midi', 'brussel centraal', 'bruxelles central',
  'brussel noord', 'bruxelles nord', 'brussel luxemburg', 'bruxelles luxembourg',
  'brussels airport zaventem', 'antwerpen centraal', 'antwerpen berchem',
  'gent sint pieters', 'gent dampoort', 'brugge', 'bruges', 'oostende', 'ostende',
  'leuven', 'louvain', 'mechelen', 'malines', 'hasselt', 'genk', 'turnhout',
  'sint niklaas', 'aalst', 'alost', 'dendermonde', 'termonde', 'kortrijk',
  'courtrai', 'roeselare', 'roulers', 'lier', 'lierre', 'sint truiden',
  'liege guillemins', 'luik guillemins', 'namur', 'namen', 'charleroi central',
  'mons', 'bergen', 'tournai', 'doornik', 'verviers central', 'arlon', 'aarlen',
  'libramont', 'ottignies', 'louvain la neuve', 'wavre', 'waver', 'nivelles',
  'braine le comte', 'la louviere sud', 'welkenraedt', 'eupen', 'ciney', 'dinant',
  'marche en famenne', 'virton', 'ieper', 'ypres', 'veurne', 'knokke', 'blankenberge',
  'de panne', 'poperinge', 'geraardsbergen', 'zottegem', 'oudenaarde', 'ronse',
  'renaix', 'denderleeuw', 'halle', 'vilvoorde', 'mol', 'herentals', 'geel',
  'diest', 'aarschot', 'tienen', 'tirlemont', 'landen', 'waremme', 'huy', 'hoei',
];
const MAJOR = new Map(MAJOR_ORDER.map((name, i) => [name, i]));
const majorRank = (halves) => Math.min(
  ...halves.map((h) => (MAJOR.has(h) ? MAJOR.get(h) : Infinity)));

// Case-insensitive, accent-insensitive, partial, and matched against every
// language variant of the name. Ordered: an exact name, then names starting
// with the query, then a later word, then anything containing it — and
// inside each of those, the bigger stations first, then alphabetically.
// The station closest to a point, by great-circle distance. Stations
// without a usable position are skipped; null when none has one.
export function nearestStation(stations, latitude, longitude) {
  const rad = Math.PI / 180;
  let best = null;
  let bestD = Infinity;
  for (const s of stations) {
    if (!s.location) continue;
    const dLat = (s.location.latitude - latitude) * rad;
    const dLon = (s.location.longitude - longitude) * rad;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(latitude * rad) * Math.cos(s.location.latitude * rad) * Math.sin(dLon / 2) ** 2;
    if (a < bestD) { bestD = a; best = s; }
  }
  return best;
}

export function searchStations(stations, query, limit = 7) {
  const q = fold(query);
  if (!q) return [];
  const rankOf = (part) => {
    if (part === q) return 0;
    if (part.startsWith(q)) return 1;
    if (part.split(' ').some((w) => w.startsWith(q))) return 2;
    if (part.includes(q)) return 3;
    return -1;
  };
  const best = (halves) => halves.reduce((r, h) => {
    const v = rankOf(h);
    return v !== -1 && (r === -1 || v < r) ? v : r;
  }, -1);

  const scored = [];
  for (const station of stations) {
    // "Brussel-Zuid/Bruxelles-Midi" matches on either half.
    const nameHalves = station.name.split('/').map(fold);
    // The canonical name, which can be an entirely different word:
    // Braine-le-Comte is 's-Gravenbrakel in Dutch, Liège is Luik.
    const altHalves = station.standardname.split('/').map(fold);
    const nameRank = best(nameHalves);
    const altRank = best(altHalves);
    if (nameRank === -1 && altRank === -1) continue;
    const rank = nameRank === -1 ? altRank
      : altRank === -1 ? nameRank
        : Math.min(nameRank, altRank);
    scored.push({
      station,
      rank,
      // A match on the name actually printed in the list beats one that is
      // only visible in the other language.
      inName: nameRank !== -1 && nameRank <= rank,
      major: majorRank([...nameHalves, ...altHalves]),
    });
  }
  scored.sort((a, b) =>
    a.rank - b.rank
    || (b.inName ? 1 : 0) - (a.inName ? 1 : 0)
    || a.major - b.major
    || a.station.name.localeCompare(b.station.name));
  return scored.slice(0, limit).map((s) => s.station);
}
