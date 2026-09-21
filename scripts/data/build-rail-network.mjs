/* ------------------------------------------------------------------
   Rail network preprocessor — run by hand, not by the build.

     node scripts/data/build-rail-network.mjs

   Turns two Infrabel Open Data sets into one compact graph the map can
   fetch at runtime, so the browser never talks to Infrabel itself:

     station_to_station                    the geometry of the network,
                                           one LineString per pair of
                                           adjacent operational points
     operationele-punten-van-het-netwerk   what those points are called
                                           and where they are

   The two join on `ptcarid`, which is the same identifier space in both
   sets (verified: 558 of the 559 points used by station_to_station are
   present in the operational-point list). That join is exact; the only
   fuzzy step in the whole pipeline is matching an iRail station name to
   an Infrabel commercial name, and that happens here, once, so the
   runtime only ever does a dictionary lookup.

   Output: public/generated/belgian-rail-graph.json — a static asset,
   fetched only after the user opens a map. Nothing imports it.

   Node stdlib only, like scripts/development/start-local-development.js.
   ------------------------------------------------------------------ */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStationName } from '../../src/data/rail/normalizeStationName.js';
import { STATION_ALIASES } from '../../src/data/rail/stationAliases.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(ROOT, 'public/generated/belgian-rail-graph.json');

const API = 'https://opendata.infrabel.be/api/explore/v2.1/catalog/datasets';
const GEOMETRY_SET = 'station_to_station';
const POINT_SET = 'operationele-punten-van-het-netwerk';

// Infrabel states its geography supports representation to roughly
// 1:25 000. Five decimals is about a metre — far finer than that, and
// finer than anything a Leaflet route line can show — so rounding here
// is lossless in practice and removes a lot of digits.
const COORD_DECIMALS = 5;

// Douglas-Peucker tolerance, in degrees. ~1.1e-5 deg is about 1 m of
// latitude; 4e-5 is therefore roughly 4 m. That is well inside the
// source's own precision, so curves and junction shapes survive while
// the redundant collinear points between them go. Raising this would
// start cutting visible corners — measure before you touch it.
const SIMPLIFY_TOLERANCE = 4e-5;

/* --- fetch ------------------------------------------------------- */

async function fetchDataset(id) {
  const meta = await fetchJson(`${API}/${id}`);
  const info = meta?.metas?.default ?? {};
  process.stdout.write(`  ${id}\n`);
  process.stdout.write(`    title    ${info.title ?? '?'}\n`);
  process.stdout.write(`    records  ${info.records_count ?? '?'}\n`);
  process.stdout.write(`    licence  ${info.license ?? '?'}\n`);
  process.stdout.write(`    modified ${info.modified ?? '?'}\n`);
  const rows = await fetchJson(`${API}/${id}/exports/json`);
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error(`${id}: export returned no rows`);
  }
  return { rows, info };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/* --- coordinates -------------------------------------------------- */

// GeoJSON order, [longitude, latitude], kept all the way through this
// file; the flip to Leaflet's [lat, lon] happens once, in the map
// component, and nowhere else.
//
// A coordinate that is missing, non-finite or out of range is rejected,
// never coerced: 0,0 is a real place in the Atlantic, not "no data".
function validCoordinate(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const lon = Number(pair[0]);
  const lat = Number(pair[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return [lon, lat];
}

const round = (n) => Number(n.toFixed(COORD_DECIMALS));

// Great-circle metres between two [lon, lat] pairs. Used only to decide
// which way round a stored LineString runs.
function metres([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* --- simplification ---------------------------------------------- */

// Perpendicular distance from `p` to the segment `a`-`b`, in degrees.
function perpendicular(p, a, b) {
  const [px, py] = p; const [ax, ay] = a; const [bx, by] = b;
  const dx = bx - ax; const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Douglas-Peucker. Endpoints are always kept, which is what keeps
// adjoining segments joined at the operational points they share.
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = perpendicular(points[i], points[0], points[points.length - 1]);
    if (d > worst) { worst = d; index = i; }
  }
  if (worst <= tolerance) return [points[0], points[points.length - 1]];
  const left = simplify(points.slice(0, index + 1), tolerance);
  const right = simplify(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

/* --- build -------------------------------------------------------- */

async function main() {
  process.stdout.write('Infrabel Open Data\n');
  const geometry = await fetchDataset(GEOMETRY_SET);
  const points = await fetchDataset(POINT_SET);

  // Which operational points the geometry actually uses. Only these are
  // worth naming: the point list also carries junctions, level
  // crossings and freight installations the network graph never visits.
  const used = new Set();
  for (const row of geometry.rows) {
    if (row.stationfrom_id) used.add(String(row.stationfrom_id));
    if (row.stationto_id) used.add(String(row.stationto_id));
  }

  // Every name Infrabel publishes for a point, in both languages, so an
  // iRail name in either language resolves to the same node.
  const NAME_FIELDS = [
    'commerciallongnamedutch', 'commerciallongnamefrench',
    'commercialmiddlenamedutch', 'commercialmiddlenamefrench',
    'commercialshortnamedutch', 'commercialshortnamefrench',
    'longnamedutch', 'longnamefrench',
  ];

  const nodes = {};
  const names = {};
  const collisions = [];
  let namedPoints = 0;

  for (const row of points.rows) {
    const id = String(row.ptcarid ?? '');
    if (!id || !used.has(id)) continue;
    const at = row.geo_point_2d ?? {};
    const coordinate = validCoordinate([at.lon, at.lat]);
    if (!coordinate) continue;
    // The label the map shows if it ever needs one: the commercial name,
    // which is what a passenger would recognise.
    const label = row.commerciallongnamedutch || row.longnamedutch || id;
    nodes[id] = { n: label, c: [round(coordinate[0]), round(coordinate[1])] };
    namedPoints += 1;

    for (const field of NAME_FIELDS) {
      for (const half of String(row[field] ?? '').split('/')) {
        const key = normalizeStationName(half);
        if (!key) continue;
        if (names[key] && names[key] !== id) {
          // Two distinct operational points answering to one name. The
          // runtime cannot choose between them, so neither is indexed.
          collisions.push({ key, ids: [names[key], id] });
          continue;
        }
        names[key] = id;
      }
    }
  }

  // Verified iRail-name differences, applied on top of the Infrabel
  // names so the runtime needs no alias logic of its own.
  const aliases = {};
  for (const [from, to] of Object.entries(STATION_ALIASES)) {
    const target = names[normalizeStationName(to)];
    if (!target) {
      throw new Error(`alias "${from}" -> "${to}": no such Infrabel point in the network`);
    }
    if (names[from] && names[from] !== target) {
      throw new Error(`alias "${from}" would override a real Infrabel name`);
    }
    names[from] = target;
    aliases[from] = to;
  }

  for (const { key, ids } of collisions) delete names[key];

  // Edges. Length is the distance Infrabel publishes for the pair, in
  // kilometres, and is the Dijkstra weight; the LineString is what gets
  // drawn, so it is kept rather than reduced to its endpoints.
  const edges = [];
  let rawPoints = 0;
  let keptPoints = 0;
  let skipped = 0;
  let reversed = 0;

  for (const row of geometry.rows) {
    const a = String(row.stationfrom_id ?? '');
    const b = String(row.stationto_id ?? '');
    if (!a || !b || a === b) { skipped += 1; continue; }
    if (!nodes[a] || !nodes[b]) { skipped += 1; continue; }

    const raw = row.geo_shape?.geometry;
    if (raw?.type !== 'LineString' || !Array.isArray(raw.coordinates)) { skipped += 1; continue; }

    const clean = [];
    for (const pair of raw.coordinates) {
      const coordinate = validCoordinate(pair);
      if (coordinate) clean.push(coordinate);
    }
    if (clean.length < 2) { skipped += 1; continue; }

    const length = Number(row.length);
    if (!Number.isFinite(length) || length <= 0) { skipped += 1; continue; }

    rawPoints += clean.length;

    // The stored LineString does not reliably run from `stationfrom_id`
    // to `stationto_id` — about half of them are the other way round.
    // Orientation is therefore taken from the geometry itself: whichever
    // node the first point is nearest is the end the line starts at. Every
    // edge is written a -> b so the runtime can concatenate segments
    // without re-deciding this per journey.
    const head = clean[0];
    const toA = metres(head, nodes[a].c);
    const toB = metres(head, nodes[b].c);
    if (toB < toA) { clean.reverse(); reversed += 1; }

    const line = simplify(clean, SIMPLIFY_TOLERANCE)
      .map(([lon, lat]) => [round(lon), round(lat)]);
    keptPoints += line.length;

    edges.push({ a, b, l: Number(length.toFixed(3)), g: line });
  }

  const graph = {
    metadata: {
      description:
        'Belgian railway network graph derived from Infrabel Open Data. '
        + 'Geometry is real railway infrastructure; the path chosen through '
        + 'it for any given train is inferred, not the track the train used.',
      sources: [
        {
          dataset: GEOMETRY_SET,
          role: 'railway geometry between adjacent operational points',
          url: `https://opendata.infrabel.be/explore/dataset/${GEOMETRY_SET}/`,
          licence: geometry.info.license ?? null,
          modified: geometry.info.modified ?? null,
          records: geometry.info.records_count ?? null,
        },
        {
          dataset: POINT_SET,
          role: 'operational point names and coordinates',
          url: `https://opendata.infrabel.be/explore/dataset/${POINT_SET}/`,
          licence: points.info.license ?? null,
          modified: points.info.modified ?? null,
          records: points.info.records_count ?? null,
        },
      ],
      generated: new Date().toISOString(),
      coordinateOrder: 'longitude,latitude',
      coordinateDecimals: COORD_DECIMALS,
      simplifyToleranceDegrees: SIMPLIFY_TOLERANCE,
      aliases,
    },
    nodes,
    names,
    edges,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(graph));

  const bytes = Buffer.byteLength(JSON.stringify(graph));
  process.stdout.write('\nGenerated\n');
  process.stdout.write(`  nodes            ${namedPoints}\n`);
  process.stdout.write(`  edges            ${edges.length} (${skipped} skipped)\n`);
  process.stdout.write(`  reoriented       ${reversed} stored against stationfrom -> stationto\n`);
  process.stdout.write(`  name keys        ${Object.keys(names).length}\n`);
  process.stdout.write(`  aliases applied  ${Object.keys(aliases).length}\n`);
  process.stdout.write(`  name collisions  ${collisions.length}${collisions.length ? ` (${collisions.map((c) => c.key).join(', ')})` : ''}\n`);
  process.stdout.write(`  geometry points  ${rawPoints} -> ${keptPoints} (${Math.round((1 - keptPoints / rawPoints) * 100)}% removed)\n`);
  process.stdout.write(`  file             ${(bytes / 1024).toFixed(1)} kB  ${OUT.replace(ROOT + '/', '')}\n`);
}

main().catch((err) => {
  process.stderr.write(`\nrail network build failed: ${err.message}\n`);
  process.exitCode = 1;
});
