/* ------------------------------------------------------------------
   Historical performance — the Performance section's data layer.

   Responsibilities, kept strictly apart:
     iRail       which train this is and which station the board shows.
                 Nothing here touches iRail, its queue or its caches.
     Infrabel    how that train has actually run at that station over
                 the last 30 service days, preprocessed into
                 generated/performance/<shard>.json by
                 scripts/data/build-punctuality.mjs.

   The browser never talks to Infrabel and never computes a statistic:
   the median, the percentage and the p90 are all decided by the build
   script, and this module only picks the right cell out of the right
   file. One shard covers a hundred train numbers, and which shard to
   ask for follows from departure.trainNumber alone — no index request
   comes first.

   Nothing is loaded until a reader opens a train's details. The board
   itself fetches none of this.

   Every failure resolves to null. A 404, a broken file, a train we
   have no history for and a station this train does not call at are
   all the same answer to the panel — render nothing — and none of them
   may ever surface as an error in the details overlay.
   ------------------------------------------------------------------ */

// Below these the figure is not published, and the build script has
// already applied them: a cell is absent under ten observations, and
// `p90` is absent under twenty. They are repeated here only so the UI
// can say *why* it is showing less, never to re-filter what arrived.
const MIN_SAMPLES = 10;

// How far out of date the published window may be before the section
// stops rendering. Up to two days is ordinary — the daily ingest reads
// D-1, so "yesterday" is the best it can ever be. Beyond a week the
// figures are no longer about the service as it runs now.
const FRESH_DAYS = 2;
const MAX_STALE_DAYS = 7;

/* --- adaptive windows ---------------------------------------------
   The published figures cover the largest trailing window the dataset
   genuinely holds, and the build says which one in `w`. These are here
   so the browser can re-derive that choice from the real dates in `a`
   and refuse a file whose header does not match its own availability —
   a count alone could never tell ten recent days from ten scattered
   ones, which is the whole reason `a` exists.

   Kept in step with WINDOWS in scripts/data/build-punctuality.mjs. */
const WINDOWS = [
  { days: 30, minDays: 27 },
  { days: 15, minDays: 14 },
  { days: 10, minDays: 10 },
];

const SHORTEST_WINDOW = WINDOWS.at(-1).days;

// `a` is one character per trailing day, newest first, so the trailing
// coverage of any window is a prefix of it.
const countAvailable = (availability, days) =>
  [...availability.slice(0, days)].reduce((n, c) => n + (c === '1' ? 1 : 0), 0);

function selectWindow(availability) {
  for (const window of WINDOWS) {
    if (countAvailable(availability, window.days) >= window.minDays) return window.days;
  }
  return 0;
}

const shardUrl = (shard) => `${import.meta.env.BASE_URL}generated/performance/${shard}.json`;

// The shard a train number lives in. Deliberately total: anything that
// is not a plain non-negative number has no shard rather than shard 0.
// The empty string is the one that matters — Number('') is 0, so
// without this a train iRail gave no number for would quietly ask for
// shard 0 and read somebody else's figures out of it.
export function shardFor(trainNumber) {
  const raw = String(trainNumber ?? '').trim();
  if (!raw) return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number / 100);
}

/* --- the shards --------------------------------------------------
   One fetch per shard per session. The promise itself is the cache, so
   opening three trains in the same hundred while the first is still in
   flight shares one request. A shard that failed is remembered as
   missing rather than retried on every open: the file is static, and a
   404 today is a 404 in a minute. */

const shards = new Map();

// What each of those promises settled to, readable without awaiting.
// The panel is shown the moment the overlay opens, and a shard already
// in hand must not make it blink through a loading state on the way to
// an answer it already has. Same entries, same single request — this
// is only a synchronous view of them.
const settled = new Map();

function loadShard(shard) {
  if (!shards.has(shard)) {
    shards.set(shard, fetch(shardUrl(shard), { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((raw) => (isShard(raw) ? raw : null))
      .catch(() => null)
      .then((raw) => { settled.set(shard, raw); return raw; }));
  }
  return shards.get(shard);
}

// A shard is only usable if it is the shape the build script writes.
// A half-deployed file, an HTML error page served as JSON or a future
// format change all land here and become "no history".
function isShard(raw) {
  return Boolean(raw)
    && typeof raw === 'object'
    && typeof raw.g === 'string'
    // 0 is a real value: the dataset covers no window yet.
    && Number.isInteger(raw.w) && raw.w >= 0
    // Without the real dates the window cannot be checked, so the file
    // is not used. There is deliberately no permissive fallback:
    // assuming full coverage is the one assumption that would put a
    // biased figure on screen.
    && typeof raw.a === 'string'
    && /^[01]+$/.test(raw.a)
    && Boolean(raw.t)
    && typeof raw.t === 'object';
}

// A cell always carries its sample count; the figures are there only
// once the sample was large enough for the build script to publish
// them. A thin cell is still a cell — it is how the panel can say "we
// know this train calls here, we have just not seen it often enough".
function isCell(cell) {
  return Boolean(cell)
    && typeof cell === 'object'
    && Number.isInteger(cell.n) && cell.n > 0;
}

const hasFigures = (cell) => Number.isFinite(cell.med) && Number.isFinite(cell.ot);

/* --- staleness ----------------------------------------------------
   Measured in Brussels service days, because that is what the window
   is counted in: comparing against the reader's own midnight would
   make the same file look a day older in Auckland than in Ghent. */

const brusselsDay = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

function daysSince(day) {
  const then = Date.parse(`${day}T00:00:00Z`);
  const now = Date.parse(`${brusselsDay()}T00:00:00Z`);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return Math.round((now - then) / 86_400_000);
}

/* --- public API ---------------------------------------------------

   How this train has run at this station, as one of four answers. The
   section always renders, so this never returns null for "nothing to
   say" — it says which nothing it is:

     none        no usable dataset for this train at all: no shard, a
                 broken file, or a header its own dates contradict
     stale       there is a dataset, but the newest day in it is too old
                 to describe the service as it runs now
     collecting  the dataset is fresh but covers no window yet; it says
                 how many of the last ten days it holds
     ok          a window qualified. `windowDays` is which one, and the
                 figures — when the train has enough journeys in it —
                 were computed from that window's days and no others

   A fifth state, `loading`, belongs to the panel rather than here: it
   is what there is to show before either of the two calls below has an
   answer, and it is deliberately not one of these.

   `trainNumber` is the board's own normalised label half, already on
   the departure. `stationKey` is the board station's performance key —
   App derives it with stationPerformanceKey(), the same function the
   build script labelled every observation with.

   Nothing here filters, rounds a percentile or recomputes a statistic;
   the panel only formats what it is given. */
const NONE = { state: 'none' };

// One shard, one train, one station, once the file is in hand. Shared
// by the awaited path and the synchronous one so the two can never
// disagree about what a given shard means.
function evaluate(raw, trainNumber, stationKey) {
  if (!raw) return NONE;

  // The header must agree with its own availability string. A file
  // claiming a window its dates do not cover is not trusted at all —
  // that mismatch is the one failure that would put a figure from the
  // wrong fortnight under the wrong label.
  const selected = selectWindow(raw.a);
  if (selected !== raw.w) return NONE;

  // Separate from coverage, and checked first: figures from a window
  // that ended weeks ago are not "the last 10 days" whatever their
  // coverage was at the time.
  const stale = daysSince(raw.g);
  if (stale == null || stale < 0) return NONE;
  if (stale > MAX_STALE_DAYS) return { state: 'stale' };

  // Only surfaced once the window has fallen behind; while it is
  // current the panel names the window and nothing more.
  const throughDay = stale > FRESH_DAYS ? raw.g : null;

  if (!selected) {
    const daysAvailable = countAvailable(raw.a, SHORTEST_WINDOW);
    // The newest day is always present in a file this build writes, so
    // this cannot normally happen; a file where it does is not one we
    // can describe as collecting anything.
    if (!daysAvailable) return NONE;
    return { state: 'collecting', daysAvailable, throughDay };
  }

  // A train with no cell here has simply not been seen at this station
  // inside the window. That is a real answer under a real window, not
  // an absence of data, so it keeps the window label.
  const cell = raw.t?.[String(trainNumber)]?.[stationKey];
  const samples = isCell(cell) ? cell.n : 0;
  const enough = samples >= MIN_SAMPLES && hasFigures(cell);

  return {
    state: 'ok',
    windowDays: selected,
    throughDay,
    samples,
    enough,
    medianSec: enough ? cell.med : null,
    onTimePct: enough ? cell.ot : null,
    p90Sec: enough && Number.isFinite(cell.p90) ? cell.p90 : null,
  };
}

// Whether a result has anything to say about this train. `none` covers
// no lookup key, a missing or broken shard and an untrusted file, so it
// is never worth a way in; nor is a window that has not seen this train
// here at all. Collecting, stale and a real but small sample all are.
// Null (still loading) is not yet anything.
export function hasPerformance(result) {
  if (!result || result.state === 'none') return false;
  if (result.state === 'ok') return result.samples > 0;
  return true;
}

// The answer if there is one to be had without waiting, and null when
// the shard has not been fetched yet. Null means "ask and wait", never
// "no history" — the panel shows its loading state on it.
//
// This starts no request and changes no cache: it only reads what an
// earlier open already settled, which is what lets a second train in
// the same hundred render its figures in the first frame.
export function peekPerformance(trainNumber, stationKey) {
  if (!trainNumber || !stationKey) return NONE;
  const shard = shardFor(trainNumber);
  if (shard == null) return NONE;
  if (!settled.has(shard)) return null;
  return evaluate(settled.get(shard), trainNumber, stationKey);
}

export async function getPerformance(trainNumber, stationKey) {
  if (!trainNumber || !stationKey) return NONE;
  const shard = shardFor(trainNumber);
  if (shard == null) return NONE;
  return evaluate(await loadShard(shard), trainNumber, stationKey);
}
