/* ------------------------------------------------------------------
   Historical punctuality preprocessor — run by a schedule, not by the
   build, and never by anything a reader does.

     node scripts/data/build-punctuality.mjs --daily
     node scripts/data/build-punctuality.mjs --backfill 202608
     node scripts/data/build-punctuality.mjs --aggregate

   Turns Infrabel Open Data into the small static files the Performance
   section reads, so the browser never talks to Infrabel itself:

     ruwe-gegevens-van-stiptheid-d-1        yesterday's arrivals and
                                            departures at every
                                            stopping point. Overwritten
                                            every morning, so a day not
                                            collected is a day lost
                                            until the monthly file lands
     stiptheid-gegevens-maandelijksebestanden
                                            the same rows per month,
                                            since 2014, as links to CSV
                                            files. Used for the initial
                                            backfill and to repair a
                                            missed day

   Only four source columns survive: DATDEP, TRAIN_NO, PTCAR_LG_NM_NL
   and DELAY_ARR. Everything else is dropped at ingest — the three
   published metrics are all distributions of one signed number, and
   RELATION in particular is deliberately never read: it describes the
   relation, not the run, and 15% of train numbers change its label
   within a month.

   Two directories, and they are not the same thing:

     state/     the rolling working set: the 30 calendar days ending at
                the newest one collected, one gzipped file each. Days
                that were missed are simply absent, and the sample count
                the panel prints carries that rather than the wording.
                Operational state — it lives on the orphan `data`
                branch, never in main.
     generated/performance/
                what the browser fetches: one shard per hundred train
                numbers, keyed so the frontend can find its shard from
                departure.trainNumber alone.

   Node stdlib only, like scripts/data/build-rail-network.mjs.
   ------------------------------------------------------------------ */

import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStationName, stationPerformanceKey } from '../../src/data/rail/normalizeStationName.js';
import { STATION_ALIASES } from '../../src/data/rail/stationAliases.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const INFRABEL = 'https://opendata.infrabel.be/api/explore/v2.1/catalog/datasets';
const DAILY_SET = 'ruwe-gegevens-van-stiptheid-d-1';
const MONTHLY_SET = 'stiptheid-gegevens-maandelijksebestanden';
const IRAIL_STATIONS = 'https://api.irail.be/v1/stations/?format=json&lang=';

// The window is exactly this many days, counted back from the newest
// service day collected. Not a default and not a floor.
const WINDOW_DAYS = 30;

// Below these a metric is not published at all. Ten observations is
// where a median and a percentage stop being anecdote; a p90 is a claim
// about the tail and needs twice that before it means anything.
const MIN_SAMPLES = 10;
const MIN_SAMPLES_P90 = 20;

// "On time" is the SNCB/Infrabel convention: a delay of strictly less
// than six minutes. The threshold is a reporting convention, not
// something the dataset defines, which is why the UI prints it in words
// beside the percentage rather than leaving "On-Time Rate" to be read
// as whatever the reader assumes.
const ON_TIME_SECONDS = 360;

/* --- ingest validation -------------------------------------------
   Measured floors, not guesses: a quiet Sunday in the D-1 set is about
   43 700 rows, 2 759 train numbers and 561 stopping points, and 94% of
   its rows name a station iRail also knows. Each bound sits well below
   its measurement so ordinary variation passes, and far enough above
   zero that a truncated download, an emptied dataset or a rename in the
   station column fails the run instead of quietly publishing a thinner
   board. Nothing is pushed when one of these trips. */
const MIN_ROWS = 30_000;
const MIN_TRAINS = 1_800;
const MIN_POINTS = 350;
const MIN_MATCH_RATE = 0.85;

// The generated output is a pure function of the state, so its size
// only moves when the state does. A sudden halving or doubling means
// something upstream changed shape; stop rather than publish it.
//
// This guards the *daily* path only. An explicit backfill exists
// precisely to fill a gap, so it is allowed to grow the aggregate as
// much as the new days warrant — every other validation still applies.
const MAX_OUTPUT_DRIFT = 0.4;

/* --- adaptive windows ----------------------------------------------
   A day missing from the state is not the same thing as a train not
   running that day. A train that did not run contributes no
   observation and the sample count carries that honestly; a missing
   *day* removes every train's observations at once and reshapes the
   sample rather than shrinking it. So a window may only be named if
   the state actually covers it.

   Rather than one all-or-nothing 30-day gate, the largest window the
   state genuinely covers is used, and each is measured over the real
   trailing calendar days ending at the newest service day — never over
   "whichever days we happen to have". Ten August days and one
   September day are not "the last 10 days".

   The longer two leave room for roughly one tenth of the window to be
   missing — one day at 15, three at 30 — while staying dense enough
   that no single day-of-week can drop out of them entirely.

   Ten days is the shortest window offered, and it is the one that
   demands every day: a train calls at a station about once a day, so a
   window of n days yields at most n observations for it, and ten is
   exactly what a median or a percentage needs. A seven-day window could
   never have reached it at all, and a ten-day window missing one day
   would top out at nine — both would have shown a real-looking window
   label above no figures. Requiring 10 of 10 is what keeps the shortest
   window one that can actually say something.

   Below ten days nothing is named and the panel says it is still
   collecting. Do not lower this floor or add a shorter tier without
   also revisiting MIN_SAMPLES — they are one decision seen from either
   end. */
const WINDOWS = [
  { days: 30, minDays: 27 },
  { days: 15, minDays: 14 },
  { days: 10, minDays: 10 },
];

// The shortest window there is. Below this the panel shows the
// collecting state and counts the days it has inside it.
const SHORTEST_WINDOW = WINDOWS.at(-1).days;

/* === helpers ==================================================== */

const out = (line = '') => process.stdout.write(`${line}\n`);

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/* --- CSV ---------------------------------------------------------
   Both Infrabel exports are plain comma-separated text with quoted
   fields, so a six-line reader is enough and a dependency is not. The
   monthly files are ~320 MB, which is the whole reason this streams a
   line at a time instead of holding a response in memory. */

function splitCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { value += '"'; i += 1; } else quoted = false;
      } else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { values.push(value); value = ''; }
    else value += ch;
  }
  values.push(value);
  return values;
}

// Yields one row object per line, keyed by lower-cased header. The two
// datasets spell their headers differently in case and carry different
// column sets; lower-casing is all it takes to read both with one path.
async function* csvRows(url) {
  const res = await fetch(url, { headers: { Accept: 'text/csv' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let header = null;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut = buffer.indexOf('\n');
    while (cut !== -1) {
      const line = buffer.slice(0, cut).replace(/\r$/, '');
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf('\n');
      if (!line) continue;
      if (!header) {
        // The daily export opens with a byte-order mark; the monthly
        // files do not.
        header = splitCsvLine(line.replace(/^﻿/, '')).map((h) => h.trim().toLowerCase());
        continue;
      }
      const values = splitCsvLine(line);
      const row = {};
      for (let i = 0; i < header.length; i += 1) row[header[i]] = values[i] ?? '';
      yield row;
    }
  }
  const tail = buffer.replace(/\r$/, '');
  if (header && tail) {
    const values = splitCsvLine(tail);
    const row = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = values[i] ?? '';
    yield row;
  }
}

/* --- dates -------------------------------------------------------
   DATDEP is the service day, not a calendar date: a train leaving at
   23:08 keeps yesterday's DATDEP when it arrives after midnight. It is
   the only date this pipeline reads, and it is the window's unit.

   The daily export prints it as 2026-09-20; the monthly files print the
   same day as 20SEP2026. Both reduce to the ISO form and nothing
   downstream knows which file a day came from. */

const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

function serviceDay(raw) {
  const value = String(raw || '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const sas = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(value.toUpperCase());
  if (sas && MONTHS[sas[2]]) return `${sas[3]}-${MONTHS[sas[2]]}-${sas[1]}`;
  return null;
}

// Today in Brussels, as a service day. The runner is UTC, so this has
// to be said out loud or a run just after midnight would prune against
// the wrong date.
const brusselsDay = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

/* --- station matching --------------------------------------------
   iRail and Infrabel publish no shared station identifier, so the join
   is by name, through the project's one normaliser and its one verified
   alias table — the same contract the route map already depends on.

   It is deliberately strict. An Infrabel stopping point that is not a
   station iRail knows is dropped, not guessed at: the punctuality set
   measures junctions, sidings, freight yards and depots as well as
   platforms, and about 6% of its rows are those. Every surviving row is
   labelled with the key the browser will look it up by, so the runtime
   only ever does a dictionary lookup. */

async function buildStationIndex() {
  const index = new Map();
  const byIrailKey = new Map();
  for (const lang of ['nl', 'fr']) {
    const json = await fetchJson(IRAIL_STATIONS + lang);
    const list = Array.isArray(json?.station) ? json.station : [];
    for (const station of list) {
      // Foreign stations iRail also lists are not on the Belgian
      // network Infrabel measures.
      if (!/^BE\.NMBS\.0088/.test(station.id || '')) continue;
      const key = stationPerformanceKey(station);
      if (!key) continue;
      byIrailKey.set(key, key);
      for (const field of [station.standardname, station.name]) {
        for (const half of String(field || '').split('/')) {
          const candidate = normalizeStationName(half);
          if (candidate && !index.has(candidate)) index.set(candidate, key);
        }
      }
    }
  }
  // A verified naming difference: the alias maps an iRail name to the
  // Infrabel one, so it is the Infrabel side that needs the entry here.
  for (const [irailName, infrabelName] of Object.entries(STATION_ALIASES)) {
    const target = index.get(normalizeStationName(irailName)) ?? byIrailKey.get(normalizeStationName(irailName));
    const from = normalizeStationName(infrabelName);
    if (target && from && !index.has(from)) index.set(from, target);
  }
  return index;
}

/* === reading one service day ==================================== */

// Collapses a CSV stream into { day -> { train -> { station -> [delays] } } }.
// Rows without an arrival delay are skipped, which is exactly one row
// per run — its origin, where a train cannot be late arriving. Negative
// delays are kept signed: about a third of all observations are early,
// and clamping them would bias every median upward.
async function readObservations(url, stations, { keepDays = null } = {}) {
  const days = new Map();
  const unmatched = new Map();
  let rows = 0;
  let matched = 0;
  const trains = new Set();
  const points = new Set();

  for await (const row of csvRows(url)) {
    const day = serviceDay(row.datdep);
    if (!day) continue;
    rows += 1;
    const point = row.ptcar_lg_nm_nl;
    points.add(point);
    trains.add(row.train_no);
    if (keepDays && !keepDays.has(day)) continue;

    const key = stations.get(normalizeStationName(point));
    if (!key) {
      unmatched.set(point, (unmatched.get(point) ?? 0) + 1);
      continue;
    }
    matched += 1;

    const delay = row.delay_arr;
    if (delay === '' || delay == null) continue;
    const seconds = Number(delay);
    if (!Number.isFinite(seconds)) continue;
    const train = String(row.train_no || '').trim();
    if (!train) continue;

    if (!days.has(day)) days.set(day, new Map());
    const byTrain = days.get(day);
    if (!byTrain.has(train)) byTrain.set(train, new Map());
    const byStation = byTrain.get(train);
    if (!byStation.has(key)) byStation.set(key, []);
    byStation.get(key).push(seconds);
  }

  return {
    days,
    stats: {
      rows,
      matched,
      trains: trains.size,
      points: points.size,
      matchRate: rows ? matched / rows : 0,
      unmatched,
    },
  };
}

/* === the rolling state ==========================================
   One gzipped file per service day. Station names are interned against
   a per-day dictionary, so the file is a list of [train, station index,
   delay] triples rather than the same few hundred names repeated tens
   of thousands of times. */

const stateFile = (dir, day) => join(dir, 'state', `${day}.json.gz`);

async function writeDay(dir, day, byTrain) {
  const stations = [...new Set(
    [...byTrain.values()].flatMap((byStation) => [...byStation.keys()]))].sort();
  const stationIndex = new Map(stations.map((name, i) => [name, i]));
  const observations = [];
  for (const [train, byStation] of byTrain) {
    for (const [station, delays] of byStation) {
      for (const delay of delays) observations.push([train, stationIndex.get(station), delay]);
    }
  }
  const payload = { day, stations, observations };
  await mkdir(join(dir, 'state'), { recursive: true });
  await writeFile(stateFile(dir, day), gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
  return observations.length;
}

async function listDays(dir) {
  let entries;
  try {
    entries = await readdir(join(dir, 'state'));
  } catch {
    return [];
  }
  return entries
    .map((name) => /^(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(name)?.[1])
    .filter(Boolean)
    .sort();
}

async function readDay(dir, day) {
  const raw = JSON.parse(gunzipSync(await readFile(stateFile(dir, day))).toString());
  return raw;
}

// Day 31 arriving means day 1 leaving. The window is the 30 calendar
// days ending at the newest service day in state — not simply the 30
// newest files. The difference matters when a day has been missed: with
// a gap in the window, counting files would let the window quietly
// stretch across seven weeks while the panel still said "last 30 days".
// Counting days keeps that sentence true and lets the sample count
// carry the thinness instead, which is what it is for.
async function pruneWindow(dir) {
  const days = await listDays(dir);
  if (!days.length) return { keep: [], drop: [] };
  const oldest = expectedDays(days)[0];
  const keep = days.filter((day) => day >= oldest);
  const drop = days.filter((day) => day < oldest);
  for (const day of drop) await rm(stateFile(dir, day), { force: true });
  return { keep, drop };
}

async function writeManifest(dir, days) {
  await mkdir(join(dir, 'state'), { recursive: true });
  await writeFile(join(dir, 'state', 'manifest.json'), `${JSON.stringify({
    windowDays: WINDOW_DAYS,
    days,
    from: days[0] ?? null,
    through: days.at(-1) ?? null,
    // What the window would hold if nothing had been missed. A gap is
    // recorded rather than repaired here: the monthly file is the only
    // thing that can repair one, and it arrives a month later.
    missing: expectedDays(days).filter((day) => !days.includes(day)),
    updated: new Date().toISOString(),
  }, null, 2)}\n`);
}

// The real calendar days ending at `through`, newest last. Everything
// that asks "is this window covered" asks it of these dates, never of
// the set of files that happen to exist.
function trailingDays(through, count) {
  if (!through) return [];
  const end = Date.parse(`${through}T00:00:00Z`);
  if (!Number.isFinite(end)) return [];
  const days = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    days.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

function expectedDays(days) {
  return trailingDays(days.at(-1), WINDOW_DAYS);
}

/* Which of the window's 30 trailing days the state holds, as one
   character per day, newest first: index i is `through` minus i days.

   Thirty characters, identical in every shard, and it is what lets the
   browser work out trailing coverage for 7, 10, 15 and 30 days from
   real dates rather than from a single count — which cannot distinguish
   ten recent days from ten scattered ones. */
function availabilityString(through, present) {
  return trailingDays(through, WINDOW_DAYS)
    .reverse()
    .map((day) => (present.has(day) ? '1' : '0'))
    .join('');
}

const countAvailable = (availability, days) =>
  [...availability.slice(0, days)].reduce((n, c) => n + (c === '1' ? 1 : 0), 0);

// The largest window the trailing dates actually cover, or null. The
// selection depends only on which dates exist, so it is one decision
// for the whole dataset and is made once, here, at build time.
function selectWindow(availability) {
  for (const window of WINDOWS) {
    if (countAvailable(availability, window.days) >= window.minDays) {
      return { ...window, present: countAvailable(availability, window.days) };
    }
  }
  return null;
}

/* === the published aggregate ====================================
   Three numbers per (train, station), all of them distributions of the
   same signed arrival delay over the same window, so one sample count
   speaks for all three. */

// Continuous percentile, interpolated between order statistics — the
// definition percentile_cont uses, so the median and the p90 come from
// one function and agree with each other.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

async function aggregate(dir) {
  const all = await listDays(dir);
  const oldest = expectedDays(all)[0];
  const days = all.filter((day) => day >= oldest);
  if (!days.length) throw new Error('no service days in state — nothing to aggregate');

  const through = days.at(-1);
  const availability = availabilityString(through, new Set(days));
  const window = selectWindow(availability);

  // Every figure comes from the selected window's own days and nothing
  // else. A 30-day median relabelled "Last 7 days" would be a different
  // number about a different fortnight, so the days outside the window
  // are never read at all.
  const metricDays = new Set(window ? trailingDays(through, window.days) : []);

  const samples = new Map();   // train -> station -> number[]  (selected window only)
  const seen = new Set();      // every train in the 30-day state
  for (const day of days) {
    const { stations, observations } = await readDay(dir, day);
    const counts = metricDays.has(day);
    for (const [train, stationIndex, delay] of observations) {
      seen.add(train);
      if (!counts) continue;
      const station = stations[stationIndex];
      if (station == null) continue;
      if (!samples.has(train)) samples.set(train, new Map());
      const byStation = samples.get(train);
      if (!byStation.has(station)) byStation.set(station, []);
      byStation.get(station).push(delay);
    }
  }

  const shards = new Map();
  let cells = 0;
  let thin = 0;
  let trains = 0;
  for (const train of seen) {
    const entry = {};
    for (const [station, delays] of samples.get(train) ?? []) {
      const sorted = delays.slice().sort((a, b) => a - b);
      // Every cell carries its sample count, including the thin ones.
      // "We have four journeys and that is too few" and "we have never
      // seen this train here" are different answers, and the panel says
      // different things about them, so a thin cell is published with
      // its count and no figures rather than dropped.
      const cell = { n: sorted.length };
      if (sorted.length >= MIN_SAMPLES) {
        cell.med = Math.round(percentile(sorted, 0.5));
        cell.ot = Math.round((100 * sorted.filter((d) => d < ON_TIME_SECONDS).length) / sorted.length);
        cells += 1;
      } else thin += 1;
      // Absent means unavailable. There is no null and no placeholder:
      // the row simply does not render.
      if (sorted.length >= MIN_SAMPLES_P90) cell.p90 = Math.round(percentile(sorted, 0.9));
      entry[station] = cell;
    }
    const shard = shardFor(train);
    if (shard == null) continue;
    // A train with no cells in the selected window is still published,
    // as an empty entry. That is what lets the panel say "last 7 days,
    // not enough comparable journeys" for a train that ran in August
    // instead of "no historical data", which would be false.
    if (Object.keys(entry).length) trains += 1;
    if (!shards.has(shard)) shards.set(shard, {});
    shards.get(shard)[train] = entry;
  }

  return {
    days,
    through,
    shards,
    cells,
    thin,
    trains,
    present: days.length,
    availability,
    window,
    // What the panel counts when no window qualifies: the days it holds
    // inside the shortest window there is.
    recent: countAvailable(availability, SHORTEST_WINDOW),
  };
}

// The frontend must find its file from departure.trainNumber alone —
// no index, no manifest, no lookup before the lookup.
function shardFor(train) {
  const number = Number(train);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number / 100) : null;
}

// Rendered in memory first so the whole aggregate can be measured and
// judged before a single file is touched. Writing first and checking
// afterwards would leave a rejected run's output on disk, and — worse —
// make it the baseline the next run compares against, so re-running a
// rejected build would quietly accept it.
function renderShards({ through, shards, availability, window }) {
  const files = [];
  for (const [shard, trains] of shards) {
    const body = JSON.stringify({
      // The window these figures were computed over, in days — 0 when
      // the state covers none of them and nothing may be shown.
      w: window ? window.days : 0,
      // The newest service day included, for the staleness check.
      g: through,
      // Which of the 30 trailing days the state holds, newest first.
      // Thirty characters, the same in every shard, and the only thing
      // that can tell ten recent days from ten scattered ones.
      a: availability,
      t: trains,
    });
    files.push({ name: `${shard}.json`, body, size: Buffer.byteLength(body) });
  }
  return files;
}

async function writeShards(dir, files) {
  const target = join(dir, 'generated', 'performance');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const file of files) await writeFile(join(target, file.name), file.body);
}

/* === commands =================================================== */

async function probeDailyDay() {
  const url = `${INFRABEL}/${DAILY_SET}/records`
    + '?select=datdep%2Ccount(*)%20as%20n&group_by=datdep&limit=5';
  const json = await fetchJson(url);
  const rows = Array.isArray(json?.results) ? json.results : [];
  const days = [...new Set(rows.map((r) => serviceDay(r.datdep)).filter(Boolean))];
  if (days.length !== 1) {
    throw new Error(`D-1 published ${days.length} service days (${days.join(', ') || 'none'}); expected exactly one`);
  }
  return { day: days[0], rows: rows[0]?.n ?? null };
}

function reportIngest(stats) {
  out(`    rows            ${stats.rows}`);
  out(`    train numbers   ${stats.trains}`);
  out(`    stopping points ${stats.points}`);
  out(`    station match   ${(stats.matchRate * 100).toFixed(1)}% (${stats.matched} rows)`);
  const top = [...stats.unmatched.entries()].sort((a, b) => b[1] - a[1]);
  if (top.length) {
    out(`    unmatched       ${top.length} names, ${top.reduce((sum, [, n]) => sum + n, 0)} rows`);
    for (const [name, n] of top.slice(0, 15)) out(`                    ${name} (${n})`);
    if (top.length > 15) out(`                    … ${top.length - 15} more`);
  }
}

function validateIngest(stats) {
  const problems = [];
  if (stats.rows < MIN_ROWS) problems.push(`only ${stats.rows} rows (expected at least ${MIN_ROWS})`);
  if (stats.trains < MIN_TRAINS) problems.push(`only ${stats.trains} train numbers (expected at least ${MIN_TRAINS})`);
  if (stats.points < MIN_POINTS) problems.push(`only ${stats.points} stopping points (expected at least ${MIN_POINTS})`);
  if (stats.matchRate < MIN_MATCH_RATE) {
    problems.push(`station match rate ${(stats.matchRate * 100).toFixed(1)}% is below ${(MIN_MATCH_RATE * 100).toFixed(0)}%`
      + ' — the iRail/Infrabel name join has drifted, so nothing is published');
  }
  if (problems.length) throw new Error(`ingest rejected:\n  - ${problems.join('\n  - ')}`);
}

/* The published output as it stands, for the size comparison below —
   but only when it is comparable. Two things make it not:

     a different schema, from before a format change, whose size says
     nothing about this one;
     a different selected window, because a window that legitimately
     narrowed from 30 days to 7 is *expected* to shrink the aggregate
     by most of its size. Guarding that would turn an ordinary,
     self-healing coverage dip into a failing pipeline.

   In both cases there is simply no baseline, and the invariants above
   are what stand in its place. */
async function previousOutput(dir) {
  const target = join(dir, 'generated', 'performance');
  let entries;
  try {
    entries = (await readdir(target)).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }
  if (!entries.length) return null;
  let total = 0;
  for (const name of entries) total += (await stat(join(target, name))).size;
  let header;
  try {
    header = JSON.parse(await readFile(join(target, entries[0]), 'utf8'));
  } catch {
    return null;
  }
  if (typeof header?.a !== 'string' || !Number.isInteger(header?.w)) return null;
  return { size: total || null, window: header.w };
}

/* Everything that must be true of the published files, whatever put
   them there. These are invariants, not heuristics: a violation means
   the aggregator is wrong, so they are checked on the daily path and
   the backfill path alike and can never be waived.

   The size guard below is the only check that is *not* an invariant —
   it is a heuristic about how much the output ought to move between two
   runs, and it is the one an explicit backfill is allowed to skip. */
function validateOutput(result) {
  const problems = [];
  if (!result.shards.size) problems.push('no trains in the aggregate');
  // A cell floor only applies once the window could actually reach it.
  // A train calls at a station about once a day, so ten observations
  // need ten *covered* days — a 10-day window with nine covered
  // legitimately publishes no figures at all, and the panel says so.
  // Requiring cells there would fail the build for behaving correctly.
  if (result.window && result.window.present >= MIN_SAMPLES && !result.cells) {
    problems.push(`a ${result.window.days}-day window with ${result.window.present} covered days`
      + ` reached no cell of n=${MIN_SAMPLES}`);
  }
  if (!result.window && result.cells) problems.push('figures published without a qualifying window');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result.through || '')) problems.push(`through date is ${result.through}`);
  if (result.present < 1 || result.present > WINDOW_DAYS) {
    problems.push(`${result.present} service days for a ${WINDOW_DAYS}-day window`);
  }
  // The availability string is the contract the browser re-derives the
  // window from, so it has to say exactly what the state says.
  if (!new RegExp(`^[01]{${WINDOW_DAYS}}$`).test(result.availability || '')) {
    problems.push(`availability is ${result.availability}`);
  } else {
    if (result.availability[0] !== '1') problems.push('availability does not include the newest day');
    if (countAvailable(result.availability, WINDOW_DAYS) !== result.present) {
      problems.push('availability disagrees with the number of service days');
    }
    const derived = selectWindow(result.availability);
    if ((derived?.days ?? 0) !== (result.window?.days ?? 0)) {
      problems.push(`window ${result.window?.days ?? 0} is not what the availability string implies (${derived?.days ?? 0})`);
    }
  }

  for (const [shard, trains] of result.shards) {
    for (const [train, entry] of Object.entries(trains)) {
      if (shardFor(train) !== shard) problems.push(`train ${train} written into shard ${shard}`);
      for (const [station, cell] of Object.entries(entry)) {
        const where = `${train} @ ${station}`;
        const extra = Object.keys(cell).filter((k) => !['n', 'med', 'ot', 'p90'].includes(k));
        if (extra.length) problems.push(`${where}: unexpected field(s) ${extra.join(', ')}`);
        if (!Number.isInteger(cell.n) || cell.n < 1) problems.push(`${where}: sample count ${cell.n}`);
        // Figures and thresholds must agree in both directions: no
        // figure below its floor, and none missing above it.
        const hasFigures = cell.med !== undefined || cell.ot !== undefined;
        if (hasFigures !== (cell.n >= MIN_SAMPLES)) problems.push(`${where}: n=${cell.n} with figures=${hasFigures}`);
        if ((cell.p90 !== undefined) !== (cell.n >= MIN_SAMPLES_P90)) problems.push(`${where}: n=${cell.n} with p90=${cell.p90}`);
        for (const [key, value] of Object.entries(cell)) {
          if (value === null || !Number.isFinite(value)) problems.push(`${where}: ${key} is ${value}`);
        }
        if (cell.ot !== undefined && (cell.ot < 0 || cell.ot > 100)) problems.push(`${where}: on-time ${cell.ot}%`);
        if (!station || station !== station.trim()) problems.push(`${where}: bad station key`);
      }
    }
  }
  if (problems.length) {
    const shown = problems.slice(0, 10).join('\n  - ');
    throw new Error(`generated output rejected:\n  - ${shown}`
      + (problems.length > 10 ? `\n  … and ${problems.length - 10} more` : ''));
  }
}

async function runAggregate(dir, { quiet = false, allowGrowth = false } = {}) {
  const previous = await previousOutput(dir);
  const result = await aggregate(dir);
  // Invariants first: nothing is written until the aggregate is sane.
  validateOutput(result);
  const files = renderShards(result);
  const sizes = files.map((file) => file.size);
  const total = sizes.reduce((sum, n) => sum + n, 0);
  // A backfill's whole purpose is to add days, so it is allowed to grow
  // the aggregate by however much those days are worth. It is not
  // allowed to skip anything above, and it is not allowed to shrink:
  // a backfill that made the output smaller did not do what was asked.
  const selected = result.window ? result.window.days : 0;
  const before = previous && previous.window === selected ? previous.size : null;
  if (previous && previous.window !== selected) {
    out(`  window changed    last ${previous.window || 'none'} -> last ${selected || 'none'} days; size guard does not apply`);
  }
  const drifted = before && Math.abs(total - before) / before > MAX_OUTPUT_DRIFT;
  if (drifted && !(allowGrowth && total > before)) {
    throw new Error(`generated output moved from ${(before / 1024).toFixed(0)} kB to ${(total / 1024).toFixed(0)} kB`
      + ` (> ${MAX_OUTPUT_DRIFT * 100}%) — refusing to publish without a look`
      + (allowGrowth ? '' : '\n  a backfill may grow the output this much; an ordinary daily ingest may not'));
  }
  if (drifted && allowGrowth) {
    out(`  output grew       ${(before / 1024).toFixed(0)} kB -> ${(total / 1024).toFixed(0)} kB (backfill)`);
  }
  // Every check has passed; only now does anything on disk change.
  await writeShards(dir, files);
  await writeManifest(dir, result.days);
  if (!quiet) {
    const sorted = sizes.slice().sort((a, b) => a - b);
    out('\nGenerated');
    out(`  service days     ${result.present}/${WINDOW_DAYS} in state (${result.days[0]} … ${result.through})`);
    out(`  trailing coverage${WINDOWS.map((w) => ` ${countAvailable(result.availability, w.days)}/${w.days}`).join('')}`);
    out(`  window           ${result.window
      ? `last ${result.window.days} days (${result.window.present}/${result.window.days} covered)`
      : `none qualifies — collecting, ${result.recent} day(s) inside the last ${SHORTEST_WINDOW}`}`);
    out(`  trains           ${result.trains}`);
    out(`  train/station    ${result.cells} cells with figures, ${result.thin} below n=${MIN_SAMPLES}`);
    out(`  shards           ${sizes.length}`);
    out(`  shard size       median ${(percentile(sorted, 0.5) / 1024).toFixed(1)} kB, max ${(Math.max(...sizes) / 1024).toFixed(1)} kB`);
    out(`  total            ${(total / 1024).toFixed(1)} kB  ${join(dir, 'generated/performance')}`);
  }
  return { ...result, sizes, total };
}

async function commandDaily(dir) {
  out('Infrabel D-1');
  const { day, rows } = await probeDailyDay();
  out(`  published service day ${day}${rows ? ` (${rows} rows)` : ''}`);
  const present = await listDays(dir);
  if (present.includes(day)) {
    out(`  already in state — nothing to do`);
    return { ingested: false, day };
  }

  const stations = await buildStationIndex();
  out(`  station index   ${stations.size} name keys`);
  out(`  downloading ${DAILY_SET}`);
  const { days, stats } = await readObservations(
    `${INFRABEL}/${DAILY_SET}/exports/csv?delimiter=%2C`, stations);
  reportIngest(stats);
  validateIngest(stats);

  const ingested = [...days.keys()];
  if (ingested.length !== 1 || ingested[0] !== day) {
    throw new Error(`export holds ${ingested.join(', ') || 'no days'}, but the probe said ${day}`);
  }
  const written = await writeDay(dir, day, days.get(day));
  out(`    observations    ${written} kept`);

  const { drop } = await pruneWindow(dir);
  if (drop.length) out(`  rolled out       ${drop.join(', ')}`);
  await runAggregate(dir);
  return { ingested: true, day };
}

async function monthlyUrl(month) {
  // 100 is the API's page ceiling, and the newest hundred months reach
  // back to 2018 — far further than a 30-day window can ever need.
  const url = `${INFRABEL}/${MONTHLY_SET}/records?limit=100&order_by=mois%20desc`;
  const json = await fetchJson(url);
  const rows = Array.isArray(json?.results) ? json.results : [];
  const wanted = `${month.slice(0, 4)}-${month.slice(4, 6)}`;
  const match = rows.find((r) => String(r.mois || '').startsWith(wanted));
  if (!match?.link_to_data) {
    throw new Error(`no monthly file published for ${wanted}`
      + ` (available: ${rows.slice(0, 6).map((r) => String(r.mois).slice(0, 7)).join(', ')})`);
  }
  return match.link_to_data;
}

async function commandBackfill(dir, month) {
  if (!/^\d{6}$/.test(month)) throw new Error('--backfill takes a month as YYYYMM');
  out(`Infrabel monthly file ${month.slice(0, 4)}-${month.slice(4, 6)}`);
  const url = await monthlyUrl(month);
  out(`  ${url}`);
  const stations = await buildStationIndex();
  out(`  station index   ${stations.size} name keys`);
  out('  streaming (nothing is written to disk)');

  const { days, stats } = await readObservations(url, stations);
  reportIngest(stats);
  validateIngest(stats);

  const existing = await listDays(dir);
  let written = 0;
  let observations = 0;
  for (const [day, byTrain] of [...days.entries()].sort()) {
    if (existing.includes(day)) continue;
    observations += await writeDay(dir, day, byTrain);
    written += 1;
  }
  out(`    service days    ${written} written, ${days.size - written} already present`);
  out(`    observations    ${observations} kept`);

  const { keep, drop } = await pruneWindow(dir);
  if (drop.length) out(`  rolled out       ${drop.length} day(s) outside the ${WINDOW_DAYS}-day window`);
  out(`  window           ${keep.length} day(s)`);
  await runAggregate(dir, { allowGrowth: true });
}

/* === entry ====================================================== */

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : (argv[i + 1] ?? '');
  };
  // Where the rolling state and the generated shards live. In CI this
  // is a checkout of the orphan `data` branch; locally it defaults to a
  // scratch directory that is never committed.
  const dir = resolve(ROOT, flag('--state') ?? '.punctuality');

  if (argv.includes('--daily')) {
    const result = await commandDaily(dir);
    if (process.env.GITHUB_OUTPUT) {
      await writeFile(process.env.GITHUB_OUTPUT,
        `ingested=${result.ingested}\nday=${result.day}\n`, { flag: 'a' });
    }
    return;
  }
  if (argv.includes('--backfill')) {
    await commandBackfill(dir, String(flag('--backfill') || '').trim());
    return;
  }
  if (argv.includes('--aggregate')) {
    await runAggregate(dir);
    return;
  }
  out('usage:');
  out('  node scripts/data/build-punctuality.mjs --daily              ingest the published D-1 day');
  out('  node scripts/data/build-punctuality.mjs --backfill YYYYMM    seed the window from a monthly file');
  out('  node scripts/data/build-punctuality.mjs --aggregate          rebuild the shards from state');
  out('');
  out('  --state <dir>   where the rolling state and generated shards live (default .punctuality)');
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`\npunctuality build failed: ${err.message}\n`);
  process.exitCode = 1;
});
