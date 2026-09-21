/* ------------------------------------------------------------------
   Railway route geometry — the map's data layer.

   Responsibilities, kept strictly apart:
     iRail       which stations this train calls at, and in what order.
                 The journey always comes from /vehicle; nothing here
                 invents, reorders or supplements it.
     Infrabel    the shape of the Belgian railway network, preprocessed
                 into public/generated/belgian-rail-graph.json by
                 scripts/data/build-rail-network.mjs.

   This module joins the two: it walks the Infrabel graph between each
   consecutive pair of iRail stops and returns the real track geometry
   that connects them.

   The path it picks is the shortest one through real infrastructure. It
   is not a statement about which tracks the train actually used — the
   network has parallel lines, high-speed and conventional corridors,
   junctions and diversions that no static dataset can resolve. Every
   caller must present the result as approximate.

   Nothing here is loaded until the user opens a map: the graph is a
   static asset fetched on first use, not an import.
   ------------------------------------------------------------------ */

import { normalizeStationName } from '../data/rail/normalizeStationName.js';

const GRAPH_URL = `${import.meta.env.BASE_URL}generated/belgian-rail-graph.json`;

// Vite replaces `import.meta.env` with a literal, so this folds to false
// in a production build and the logging goes with it. The `typeof` guard
// only matters outside Vite, where the preprocessing checks run this
// module under plain Node.
const DEV = typeof import.meta.env !== 'undefined' && Boolean(import.meta.env.DEV);
const dev = (...args) => { if (DEV) console.info('[rail-map]', ...args); };

/* --- the graph ---------------------------------------------------- */

// One fetch per session. The promise itself is the cache, so several
// map opens in flight at once still share a single request. A failed
// load is evicted so the next open can retry it.
let graphPromise = null;

export function loadRailGraph() {
  if (!graphPromise) {
    const started = Date.now();
    graphPromise = fetch(GRAPH_URL, { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (!res.ok) throw new Error(`rail graph ${res.status}`);
        return res.json();
      })
      .then((raw) => {
        const graph = index(raw);
        dev(`rail graph loaded in ${Date.now() - started}ms`,
          `(${Object.keys(graph.nodes).length} nodes, ${graph.edges.length} edges)`);
        return graph;
      })
      .catch((err) => { graphPromise = null; throw err; });
  }
  return graphPromise;
}

// Adjacency is built once, on load, rather than per route: the graph is
// small (≈560 nodes, ≈1380 edges) and every journey walks it repeatedly.
function index(raw) {
  const adjacency = new Map();
  raw.edges.forEach((edge, i) => {
    if (!raw.nodes[edge.a] || !raw.nodes[edge.b]) return;
    // Infrabel stores most pairs in both directions; the graph is
    // undirected either way, and geometry is oriented when it is walked.
    if (!adjacency.has(edge.a)) adjacency.set(edge.a, []);
    if (!adjacency.has(edge.b)) adjacency.set(edge.b, []);
    adjacency.get(edge.a).push({ to: edge.b, edge: i });
    adjacency.get(edge.b).push({ to: edge.a, edge: i });
  });
  return { ...raw, adjacency };
}

/* --- station matching --------------------------------------------- */

// iRail and Infrabel share no public station identifier, so the join is
// by name — and it is deliberately strict. The order is:
//
//   1. the station's iRail id, if the graph was built with one (it is
//      not today, but the shape is here so a future id join slots in)
//   2. an exact normalised name, in either language, including the
//      verified aliases baked into the graph's name index
//   3. nothing
//
// There is no similarity scoring and no nearest-station fallback. An
// unmatched stop fails its route, because a confidently wrong line
// through the wrong corridor is worse than no line at all.
function matchStation(graph, stop) {
  const candidates = [];
  for (const name of [stop.name, stop.standardname]) {
    if (!name) continue;
    for (const half of String(name).split('/')) {
      const key = normalizeStationName(half);
      if (key) candidates.push(key);
    }
  }
  for (const key of candidates) {
    const id = graph.names[key];
    if (id && graph.nodes[id]) return id;
  }
  return null;
}

/* --- shortest path ------------------------------------------------- */

// Dijkstra over the Infrabel graph, weighted by the segment lengths
// Infrabel publishes (kilometres). Small enough that a linear scan for
// the next node costs less than maintaining a heap would.
function shortestPath(graph, from, to) {
  if (from === to) return [];
  const distance = new Map([[from, 0]]);
  const previous = new Map();
  const settled = new Set();
  const queue = new Set([from]);

  while (queue.size) {
    let current = null;
    let best = Infinity;
    for (const node of queue) {
      const d = distance.get(node) ?? Infinity;
      if (d < best) { best = d; current = node; }
    }
    if (current == null) break;
    queue.delete(current);
    settled.add(current);
    if (current === to) break;

    for (const link of graph.adjacency.get(current) ?? []) {
      if (settled.has(link.to)) continue;
      const weight = graph.edges[link.edge].l;
      const next = best + weight;
      if (next < (distance.get(link.to) ?? Infinity)) {
        distance.set(link.to, next);
        previous.set(link.to, { node: current, edge: link.edge });
        queue.add(link.to);
      }
    }
  }

  if (!previous.has(to)) return null;
  const hops = [];
  let cursor = to;
  while (cursor !== from) {
    const step = previous.get(cursor);
    if (!step) return null;
    hops.unshift({ edge: step.edge, from: step.node, to: cursor });
    cursor = step.node;
  }
  return hops;
}

/* --- geometry ------------------------------------------------------ */

const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

// A segment's stored LineString may run either way round, so each one is
// oriented against the node it is being entered from before it is
// appended. The duplicated point at each join is dropped so the result
// is one continuous line rather than a string of touching pieces.
function concatenate(graph, hops) {
  const line = [];
  for (const hop of hops) {
    const edge = graph.edges[hop.edge];
    const forward = edge.a === hop.from;
    const piece = forward ? edge.g : [...edge.g].reverse();
    if (!piece.length) continue;
    if (line.length && near(line[line.length - 1], piece[0])) line.push(...piece.slice(1));
    else line.push(...piece);
  }
  return line;
}

/* --- route cache ---------------------------------------------------- */

// Bounded and keyed on the journey, so re-opening the map for the same
// train is free while a different train never sees a stale line.
const routeCache = new Map();
const MAX_ROUTES = 32;

function cacheRoute(key, value) {
  routeCache.set(key, value);
  if (routeCache.size > MAX_ROUTES) {
    routeCache.delete(routeCache.keys().next().value);
  }
  return value;
}

/* --- public -------------------------------------------------------- */

// Services that run on roads rather than rails. iRail names them
// "BE.NMBS.BUS1943"; the board shows them as an ordinary departure, but
// they must never be drawn over railway geometry.
const ROAD_SERVICE = /^(?:BE\.NMBS\.)?(?:BUS|TAXI)/i;

export function isRoadService(vehicleId) {
  return ROAD_SERVICE.test(String(vehicleId ?? ''));
}

/**
 * Railway geometry for one journey.
 *
 * Returns either
 *   { ok: true,  line, matched }        a single [lon, lat] LineString
 *   { ok: false, reason, detail }       nothing drawable
 *
 * `reason` is one of 'too-short' | 'unmatched' | 'no-path', so the UI can
 * stay honest without inventing a partial line. A journey that cannot be
 * routed end to end fails as a whole: no straight-line bridging, no gaps.
 */
export async function getRailRoute(vehicleId, serviceDay, stops) {
  // A rail-replacement bus calls at railway stations, so its stops match
  // the graph perfectly and it would be drawn along the line it is
  // replacing — the one route it certainly does not take. iRail labels
  // these services BUS in the vehicle id, which is the only signal we
  // need: no railway geometry is produced for them at all.
  if (isRoadService(vehicleId)) return { ok: false, reason: 'not-rail' };

  const usable = (stops ?? []).filter((s) => s?.name);
  if (usable.length < 2) return { ok: false, reason: 'too-short' };

  const key = `${vehicleId}|${serviceDay}|${usable.map((s) => s.id || s.name).join('>')}`;
  if (routeCache.has(key)) return routeCache.get(key);

  const graph = await loadRailGraph();

  const matched = [];
  for (const stop of usable) {
    const node = matchStation(graph, stop);
    if (!node) {
      dev('unmatched station:', stop.name);
      return cacheRoute(key, { ok: false, reason: 'unmatched', detail: stop.name });
    }
    matched.push({ stop, node });
  }

  const line = [];
  for (let i = 0; i < matched.length - 1; i += 1) {
    const from = matched[i];
    const to = matched[i + 1];
    if (from.node === to.node) continue;          // a call at the same point twice
    const hops = shortestPath(graph, from.node, to.node);
    if (!hops) {
      dev(`no graph path: ${from.stop.name} → ${to.stop.name}`);
      return cacheRoute(key, {
        ok: false,
        reason: 'no-path',
        detail: `${from.stop.name} → ${to.stop.name}`,
      });
    }
    const piece = concatenate(graph, hops);
    if (line.length && piece.length && near(line[line.length - 1], piece[0])) {
      line.push(...piece.slice(1));
    } else {
      line.push(...piece);
    }
  }

  if (line.length < 2) return cacheRoute(key, { ok: false, reason: 'no-path' });
  return cacheRoute(key, { ok: true, line, matched: matched.length });
}
