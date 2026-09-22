/* ------------------------------------------------------------------
   One station-name normaliser, shared by the build script that bakes
   the rail graph and by the runtime that looks stations up in it.

   iRail and Infrabel do not publish a common station identifier, so a
   name is the only join we have. That makes this function part of the
   matching contract: the generated graph's name index is built with
   it, so changing it silently invalidates every baked key. Regenerate
   the graph whenever it changes.

   It folds only differences that are purely typographic — case,
   accents, ligatures, apostrophes, punctuation and spacing. It must
   never fold anything that distinguishes two real stations: Mortsel
   and Mortsel-Deurnesteenweg are 161 m apart and are not the same
   place, so no suffix, qualifier or bracketed part is ever stripped.
   ------------------------------------------------------------------ */

// Ligatures NFD does not decompose, plus the stroked o. Without this
// "Ville-Pommerœul" and "Ville-Pommeroeul" are different stations.
const LIGATURES = [
  [/œ/g, 'oe'],   // œ
  [/æ/g, 'ae'],   // æ
  [/ß/g, 'ss'],   // ß
  [/ø/g, 'o'],    // ø
];

// Straight and curly apostrophes and backticks are dropped rather than
// turned into separators: "'s-Gravenbrakel" must not gain a leading gap.
const APOSTROPHES = /['‘’`´]/g;

export function normalizeStationName(value) {
  if (!value) return '';
  let s = String(value).normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining accents
    .toLowerCase();
  for (const [pattern, replacement] of LIGATURES) s = s.replace(pattern, replacement);
  return s
    .replace(APOSTROPHES, '')
    .replace(/[^a-z0-9]+/g, '-')       // spaces, dots, slashes, brackets
    .replace(/^-+|-+$/g, '');
}

/* ------------------------------------------------------------------
   The one key a station is known by outside iRail.

   Two consumers have to agree on it exactly, or a lookup silently
   misses: scripts/data/build-punctuality.mjs, which labels every
   Infrabel observation with it, and src/services/punctuality.js, which
   looks the board's own station up by it. Keeping it here, beside the
   normaliser it is built from, is what stops the two drifting apart.

   `standardname` is the source because iRail returns it identically in
   all four languages, so the key does not change meaning with the
   display language — the same reason stationToSlug() uses it. A
   bilingual name is reduced to its first half, deterministically.
   ------------------------------------------------------------------ */
export function stationPerformanceKey(station) {
  const source = station?.standardname || station?.name || '';
  return normalizeStationName(source.split('/')[0] || source);
}
