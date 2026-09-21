/* ------------------------------------------------------------------
   iRail and Infrabel do not expose one shared public station
   identifier. Known naming differences are mapped explicitly here.

   Every entry is a verified mismatch between an iRail station name and
   the Infrabel operational point that is the same physical place —
   checked against the coordinates both sources publish. Nothing here is
   guessed, and nothing here is a "near enough" match: a station that
   cannot be resolved safely is left unresolved on purpose, because a
   wrong route is worse than no route.

   Keys are normalised iRail names (see normalizeStationName.js);
   values are the normalised Infrabel commercial name to look up.

   Deliberately NOT aliased, for the record, so nobody adds them later:
     Mortsel-Deurnesteenweg  161 m from Infrabel "Mortsel", but a
                             different station on a different line.
     Antwerpen-Linkeroever   a real halt, present in the Infrabel
                             operational-point list but absent from the
                             station-to-station network, so it cannot be
                             routed through at all.
     Zwankendamme, Melle PW  nearest Infrabel points are a freight yard
                             and a service installation, not the halt.
     *-Frontiere / *-Grens   network boundaries, not commercial stops.
     Y.<name>                junctions, not commercial stops.
   ------------------------------------------------------------------ */

export const STATION_ALIASES = {
  // Infrabel qualifies the town, iRail does not. Same point, 89 m apart.
  beveren: 'beveren-waas',
};
