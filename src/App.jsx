import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Header from './components/Header.jsx';
import DepartureBoard from './components/DepartureBoard.jsx';
import StationModal from './components/StationModal.jsx';
import TrainDetailsModal from './components/TrainDetailsModal.jsx';
import AboutModal from './components/AboutModal.jsx';
import {
  getLiveboard, getStops, getRoute, getStations, stationToSlug, findStationBySlug,
} from './services/irail.js';
import { getPerformance, peekPerformance } from './services/punctuality.js';
import { stationPerformanceKey } from './data/rail/normalizeStationName.js';

/* === CONFIGURATION ============================================== */

// Station the board opens on — the title-bar picker changes it from there.
// Accepts an iRail station name ("Brussel-Zuid", "Gent-Sint-Pieters",
// "Antwerpen-Centraal", ...) or an ID. An ID is the safer choice here: a
// name has to match the current language, and the language is switchable.
const STATION = 'BE.NMBS.008813003';   // Brussel-Centraal / Bruxelles-Central

// The station the board falls back to: no `?station=` in the URL, or one
// naming a station that does not exist. Only the id is known up front; the
// rest is filled in once the real station list arrives.
const DEFAULT_STATION = { id: STATION, name: '', standardname: '' };

// The single query parameter the board owns. Everything else in the URL is
// left untouched when the station changes.
const STATION_PARAM = 'station';

// The browser tab's name; the resolved station is prefixed to it.
const DOCUMENT_TITLE = 'Belgian Train Departures';

// The second parameter the board owns, and only while the From -> To
// filter is on: the readable slug of the destination the listed trains
// have to call at. Like `station` it is a slug, never an iRail id, and it
// is resolved back to a real station object from the /stations list.
const TO_PARAM = 'to';

const CONFIG = {
  // Which of the two real screen types to imitate:
  //   'compact'  concourse overview — single-line rows, "via" list inline
  //   'platform' platform detail    — tall bands, stop list underneath
  layout: 'compact',
  lang: 'fr',            // nl | fr | en | de — the language the board starts in
  refreshMs: 30_000,     // live data refresh interval
  showStops: true,       // fetch the intermediate stations of each train
  maxStops: 0,           // platform layout: 0 = every stop; or cap at e.g. 3
  viaStops: 3,           // compact layout: intermediate stations printed inline
  rows: 0,               // 0 = fit rows to the reference pitch; or force a number
};

// Row geometry of each screen type, measured from the photographs as a
// share of the board height, so the proportions survive any resolution.
// The compact figures come from the concourse reference screen, which fits
// thirteen single-line departures below the title bar: a row pitch of 7.7%
// of the board area. `rowsCap` is that same density expressed as a count, so
// a very tall desktop window holds at thirteen readable rows instead of
// packing in more, thinner ones. It only ever lowers the fitted count.
const LAYOUTS = {
  compact:  { share: 0.0770, minPx: 52,  maxPx: 104, rowsMin: 5, rowsMax: 16, rowsCap: 13 },
  platform: { share: 0.2220, minPx: 116, maxPx: 300, rowsMin: 3, rowsMax: 8 },
};

// Below this width each departure is stacked over several lines instead
// of being squeezed into five columns (kept in step with styles.css).
const STACKED_QUERY = '(max-width: 599px)';

/* === DEVELOPMENT-ONLY VISUAL TEST MODE ========================== */

// `?mock=1` on the dev server feeds the board the fixture in
// src/services/mockBoard.js instead of iRail, so a sparse evening
// liveboard still shows a full screen with a delayed, cancelled,
// platform-changed and shortened row on it at once. It owns its own
// parameter and leaves `?station=` alone, so the two combine.
//
// Every use below is written as `import.meta.env.DEV && mockRequested()`.
// `import.meta.env.DEV` is a compile-time constant, so a production build
// folds the condition to false, drops the branch, and never emits the
// fixture: the shipped bundle can only talk to iRail.
const MOCK_PARAM = 'mock';

// Written as a ternary on `import.meta.env.DEV`, not `&&`: the flag is a
// compile-time constant, so a production build folds this whole thing to
// `false`, and every branch guarded by it below — including the import of
// the fixture — is removed as dead code. The shipped bundle carries no
// mock data and no mock code path.
const MOCK = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get(MOCK_PARAM) === '1'
  : false;

// The fixture is loaded on demand, so it stays out of the module graph
// until the dev server is actually asked for it. The import sits inside
// the same dead branch, which is what keeps it out of the production
// bundle: with no live caller left, the function goes with it.
async function mockSource() {
  if (import.meta.env.DEV) return import('./services/mockBoard.js');
  return null;
}

// The fixture hands back a plain stop list; the board speaks getStops'
// { status, stops } shape, so the two are reconciled here rather than by
// teaching the filter a second result format.
function mockResult(stops) {
  return stops ? { status: 'ok', stops } : { status: 'unavailable', stops: null };
}

// The historical figures come from a static aggregate a scheduled
// workflow publishes on a separate branch, so on a dev machine there is
// nothing to fetch and every train answers `none` — the one state that
// shows none of the section. The fixture answers the same four states
// in the same shape instead, on the same dead branch as everything else
// here. It is a second source, never a second rendering path: the panel
// below is handed one object and cannot tell which one wrote it.
function mockPerformance(trainNumber) {
  return mockSource().then((m) => m.getMockPerformance(trainNumber));
}

/* === WORDING ==================================================== */

// The four languages iRail serves; the globe in the title bar picks one
// and the whole board follows, wording and data alike.
const LANGUAGES = [
  { code: 'nl', label: 'NL' },
  { code: 'fr', label: 'FR' },
  { code: 'en', label: 'EN' },
  { code: 'de', label: 'DE' },
];

// Only for the one date the Performance section can print — the last
// service day its window covers, and only once that window has fallen
// behind. Belgian forms where there is one.
const DATE_LOCALES = { nl: 'nl-BE', fr: 'fr-BE', en: 'en-GB', de: 'de-DE' };

const TEXT = {
  nl: {
    title: 'Vertrek',
    via: 'via',
    platform: 'Spoor',
    stops: 'Deze trein stopt te:',
    cancelled: 'Afgeschaft',
    cancelledLong: 'Trein afgeschaft',
    limited: 'Beperkt',
    limitedTo: (s) => `Beperkt tot ${s}.`,
    extra: 'Extra trein',
    none: 'Geen vertrekkende treinen',
    offline: 'Geen verbinding met de gegevensbron',
    pick: 'Kies een station',
    search: 'Zoek een station',
    loading: 'Stations laden…',
    noResults: 'Geen station gevonden',
    listFailed: 'Stationslijst niet beschikbaar',
    favorites: 'Favorieten',
    favoritesHint: 'Opgeslagen stations',
    favoritesEmpty: 'Nog geen favoriete stations.',
    favoriteAdd: (s) => `${s} aan favorieten toevoegen`,
    favoriteRemove: (s) => `${s} uit favorieten verwijderen`,
    favoriteLimit: 'Je kunt maximaal 5 favoriete stations opslaan.',
    language: 'Taal',
    menu: 'Menu',
    about: 'Over dit bord',
    stationLabel: 'Station',
    updated: 'Laatst bijgewerkt',
    aboutWhat: 'Dit is een onafhankelijk, niet-commercieel project om Belgische treinvertrekken te bekijken in een interface in de stijl van een stationsbord.',
    aboutIndependent: 'Het is geen officieel product van SNCB/NMBS en is niet verbonden aan, goedgekeurd door of uitgebaat door SNCB/NMBS.',
    aboutData: 'Live spoorweggegevens worden geleverd via de',
    aboutIRail: 'iRail API',
    aboutMapData: 'De optionele routekaart tekent het spoortracé op basis van open data van Infrabel (CC0); de achtergrondkaart is © OpenStreetMap-bijdragers. Het tracé volgt echte spoorlijnen, maar de sporen waarover de trein precies rijdt, kunnen afwijken.',
    aboutPerformance: 'De prestatiecijfers bij de treindetails zijn gebaseerd op ruwe stiptheidsgegevens uit de open data van Infrabel (CC0), over de laatste 30 dienstdagen. Ze worden door deze onafhankelijke site berekend en zijn geen officiële statistieken van Infrabel of SNCB/NMBS.',
    aboutLive: 'De informatie wordt uitsluitend ter informatie getoond. Live vertrektijden, vertragingen, sporen, afschaffingen en andere dienstinformatie kunnen soms onvolledig, vertraagd, onnauwkeurig of tijdelijk niet beschikbaar zijn.',
    aboutOfficial: 'Raadpleeg voor officiële reisinformatie',
    aboutOfficialSuffix: 'of de betrokken spoorwegmaatschappij.',
    aboutTrademarks: 'De namen en handelsmerken SNCB/NMBS blijven eigendom van hun respectieve rechthebbenden.',
    fullscreen: 'Volledig scherm',
    fullscreenExit: 'Volledig scherm verlaten',
    unknownStation: (s) => `Onbekend station “${s}”`,
    details: 'Treindetails',
    close: 'Sluiten',
    arrival: 'Aankomst',
    departureAt: 'Vertrek',
    extraStop: 'Extra halte',
    platformChange: 'Spoorwijziging',
    delayedBy: (n) => `${n} minuten vertraging`,
    currentStation: 'Huidig station',
    loadingRoute: 'Route laden…',
    noRoute: 'Gedetailleerde route-informatie is niet beschikbaar voor deze trein.',
    back: 'Terug',
    openMap: 'Kaart openen',
    backToDetails: 'Terug naar details',
    routeMap: 'Routekaart',
    loadingMap: 'Routekaart laden…',
    approximateRoute: 'Bij benadering',
    approximateRouteInfo: 'De route volgt echte spoorlijnen uit de open data van Infrabel. De sporen waarover deze trein precies rijdt, kunnen afwijken.',
    mapUnavailable: 'Routekaart niet beschikbaar',
    railRouteUnavailable: 'Spoorroute niet beschikbaar',
    mapSummary: (from, to) => `Routekaart van ${from} naar ${to}`,
    modeRoute: 'Van → Naar',
    modeRouteHint: 'Alleen rechtstreekse treinen',
    fromLabel: 'Van',
    toLabel: 'Naar',
    showDepartures: 'Vertrekken tonen',
    directOnly: 'Alleen rechtstreekse treinen, zonder overstap.',
    findingDirect: 'Rechtstreekse treinen zoeken…',
    noDirect: (s) => `Geen rechtstreekse trein naar ${s}.`,
    noDirectUnconfirmed: 'Er konden geen rechtstreekse vertrekken worden bevestigd. Sommige treinroutes konden niet worden geverifieerd.',
    someUnchecked: 'Sommige treinroutes konden niet worden geverifieerd.',
    routeFilter: (from, to) => `${from} → ${to}`,
    clearFilter: 'Bestemmingsfilter wissen',
    occupancy: { low: 'Lage bezetting', medium: 'Gemiddelde bezetting', high: 'Hoge bezetting' },
    performance: 'Prestaties',
    minutesShort: 'min',
    performanceWindow: (days) => `Laatste ${days} dagen`,
    performanceThrough: (through) => `t/m ${through}`,
    performanceJourneys: (n) => `${n} vergelijkbare ${n === 1 ? 'rit' : 'ritten'}`,
    performanceCollecting: (n) => `Geschiedenis wordt opgebouwd · ${n} ${n === 1 ? 'dag' : 'dagen'} beschikbaar`,
    performanceLoading: 'Historische prestaties laden…',
    performanceNoneYet: 'Nog geen historische gegevens beschikbaar',
    performanceNotEnoughYet: 'Nog te weinig historische gegevens',
    performanceNotComparable: 'Nog te weinig vergelijkbare ritten',
    performanceStale: 'Historische gegevens zijn niet actueel',
    typicalDelay: 'Gebruikelijke vertraging',
    typicalDelayHint: 'Mediane vertraging',
    onTimeRate: 'Stiptheid',
    onTimeRateHint: 'Minder dan 6 min vertraging',
    p90Label: '90% komt aan binnen',
    p90Hint: '90% van de aankomsten',
  },
  fr: {
    title: 'Départ',
    via: 'via',
    platform: 'Voie',
    stops: "Ce train s'arrête à :",
    cancelled: 'Supprimé',
    cancelledLong: 'Train supprimé',
    limited: 'Limité',
    limitedTo: (s) => `Limité à ${s}.`,
    extra: 'Train supplémentaire',
    none: 'Aucun départ',
    offline: 'Pas de connexion à la source de données',
    pick: 'Choisir une gare',
    search: 'Chercher une gare',
    loading: 'Chargement des gares…',
    noResults: 'Aucune gare trouvée',
    listFailed: 'Liste des gares indisponible',
    favorites: 'Favoris',
    favoritesHint: 'Gares enregistrées',
    favoritesEmpty: 'Aucune gare favorite pour le moment.',
    favoriteAdd: (s) => `Ajouter ${s} aux favoris`,
    favoriteRemove: (s) => `Retirer ${s} des favoris`,
    favoriteLimit: 'Vous pouvez enregistrer jusqu’à 5 gares favorites.',
    language: 'Langue',
    menu: 'Menu',
    about: 'À propos',
    stationLabel: 'Gare',
    updated: 'Dernière mise à jour',
    aboutWhat: "Ce projet indépendant et non commercial permet de consulter les départs des trains belges dans une interface inspirée des tableaux de gare.",
    aboutIndependent: "Il ne s'agit pas d'un produit officiel de SNCB/NMBS et il n'est ni affilié à, ni approuvé par, ni exploité par SNCB/NMBS.",
    aboutData: 'Les données ferroviaires en temps réel sont fournies via',
    aboutIRail: 'l’API iRail',
    aboutMapData: 'La carte optionnelle du parcours trace la voie à partir des données ouvertes d’Infrabel (CC0) ; le fond de carte est © les contributeurs d’OpenStreetMap. Le tracé suit de vraies lignes ferroviaires, mais les voies exactement empruntées par le train peuvent différer.',
    aboutPerformance: 'Les chiffres de ponctualité affichés dans les détails du train proviennent des données brutes de ponctualité publiées en open data par Infrabel (CC0), sur les 30 derniers jours de service. Ils sont calculés par ce site indépendant et ne constituent pas des statistiques officielles d’Infrabel ou de SNCB/NMBS.',
    aboutLive: "Les informations sont fournies à titre informatif uniquement. Les heures de départ, retards, voies, suppressions et autres informations de service en temps réel peuvent parfois être incomplets, retardés, inexacts ou temporairement indisponibles.",
    aboutOfficial: 'Pour obtenir des informations de voyage officielles, consultez',
    aboutOfficialSuffix: 'ou l’opérateur ferroviaire concerné.',
    aboutTrademarks: 'Les noms et marques SNCB/NMBS restent la propriété de leurs détenteurs respectifs.',
    fullscreen: 'Plein écran',
    fullscreenExit: 'Quitter le plein écran',
    unknownStation: (s) => `Gare inconnue « ${s} »`,
    details: 'Détails du train',
    close: 'Fermer',
    arrival: 'Arrivée',
    departureAt: 'Départ',
    extraStop: 'Arrêt supplémentaire',
    platformChange: 'Changement de voie',
    delayedBy: (n) => `${n} minutes de retard`,
    currentStation: 'Gare actuelle',
    loadingRoute: 'Chargement du parcours…',
    noRoute: 'Les informations détaillées de parcours ne sont pas disponibles pour ce train.',
    back: 'Retour',
    openMap: 'Ouvrir la carte',
    backToDetails: 'Retour aux détails',
    routeMap: 'Carte du parcours',
    loadingMap: 'Chargement de la carte…',
    approximateRoute: 'Tracé approximatif',
    approximateRouteInfo: 'Le tracé suit de vraies lignes ferroviaires issues des données ouvertes d’Infrabel. Les voies exactement empruntées par ce train peuvent différer.',
    mapUnavailable: 'Carte du parcours indisponible',
    railRouteUnavailable: 'Tracé ferroviaire indisponible',
    mapSummary: (from, to) => `Carte du parcours de ${from} à ${to}`,
    modeRoute: 'De → Vers',
    modeRouteHint: 'Trains directs uniquement',
    fromLabel: 'De',
    toLabel: 'Vers',
    showDepartures: 'Afficher les départs',
    directOnly: 'Trains directs uniquement, sans correspondance.',
    findingDirect: 'Recherche des trains directs…',
    noDirect: (s) => `Aucun train direct vers ${s}.`,
    noDirectUnconfirmed: 'Aucun départ direct n’a pu être confirmé. Certains itinéraires de train n’ont pas pu être vérifiés.',
    someUnchecked: 'Certains itinéraires de train n’ont pas pu être vérifiés.',
    routeFilter: (from, to) => `${from} → ${to}`,
    clearFilter: 'Effacer le filtre de destination',
    occupancy: { low: 'Faible affluence', medium: 'Affluence moyenne', high: 'Forte affluence' },
    performance: 'Ponctualité',
    minutesShort: 'min',
    performanceWindow: (days) => `${days} derniers jours`,
    performanceThrough: (through) => `jusqu’au ${through}`,
    performanceJourneys: (n) => `${n} trajet${n === 1 ? '' : 's'} comparable${n === 1 ? '' : 's'}`,
    performanceCollecting: (n) => `Historique en cours de constitution · ${n} jour${n === 1 ? '' : 's'} disponible${n === 1 ? '' : 's'}`,
    performanceLoading: 'Chargement des données de ponctualité…',
    performanceNoneYet: 'Aucune donnée historique disponible pour l’instant',
    performanceNotEnoughYet: 'Pas encore assez de données historiques',
    performanceNotComparable: 'Pas encore assez de trajets comparables',
    performanceStale: 'Les données historiques ne sont pas à jour',
    typicalDelay: 'Retard habituel',
    typicalDelayHint: 'Retard médian',
    onTimeRate: 'Taux de ponctualité',
    onTimeRateHint: 'Moins de 6 min de retard',
    p90Label: '90% arrivent en moins de',
    p90Hint: '90% des arrivées',
  },
  en: {
    title: 'Departures',
    via: 'via',
    platform: 'Platform',
    stops: 'This train calls at:',
    cancelled: 'Cancelled',
    cancelledLong: 'Train cancelled',
    limited: 'Limited',
    limitedTo: (s) => `Limited to ${s}.`,
    extra: 'Extra train',
    none: 'No departures',
    offline: 'No connection to the data source',
    pick: 'Choose a station',
    search: 'Find a station',
    loading: 'Loading stations…',
    noResults: 'No station found',
    listFailed: 'Station list unavailable',
    favorites: 'Favorites',
    favoritesHint: 'Saved stations',
    favoritesEmpty: 'No favorite stations yet.',
    favoriteAdd: (s) => `Add ${s} to favorites`,
    favoriteRemove: (s) => `Remove ${s} from favorites`,
    favoriteLimit: 'You can save up to 5 favorite stations.',
    language: 'Language',
    menu: 'Menu',
    about: 'About',
    stationLabel: 'Station',
    updated: 'Last updated',
    aboutWhat: 'This is an independent, non-commercial project for viewing Belgian train departures in a station-board style interface.',
    aboutIndependent: 'It is not an official SNCB/NMBS product and is not affiliated with, endorsed by, or operated by SNCB/NMBS.',
    aboutData: 'Live railway data is provided through the',
    aboutIRail: 'iRail API',
    aboutMapData: 'The optional route map draws the railway line from Infrabel open data (CC0); the base map is © OpenStreetMap contributors. The line follows real railway lines, but the exact tracks used by the train may differ.',
    aboutPerformance: 'The performance figures in the train details are derived from raw punctuality data published as Infrabel Open Data (CC0), over the last 30 service days. They are calculated by this independent site and are not official Infrabel or SNCB/NMBS statistics.',
    aboutLive: 'Information shown here is provided for informational purposes only. Live departure times, delays, platforms, cancellations and other service information may occasionally be incomplete, delayed, inaccurate or temporarily unavailable.',
    aboutOfficial: 'For official travel information, please consult',
    aboutOfficialSuffix: 'or the relevant railway operator.',
    aboutTrademarks: 'SNCB/NMBS names and trademarks remain the property of their respective owners.',
    fullscreen: 'Full screen',
    fullscreenExit: 'Exit full screen',
    unknownStation: (s) => `Unknown station “${s}”`,
    details: 'Train details',
    close: 'Close',
    arrival: 'Arrival',
    departureAt: 'Departure',
    extraStop: 'Extra stop',
    platformChange: 'Platform change',
    delayedBy: (n) => `${n} minute${n === 1 ? '' : 's'} late`,
    currentStation: 'Current station',
    loadingRoute: 'Loading route…',
    noRoute: 'Detailed route information is not available for this train.',
    back: 'Back',
    openMap: 'Open map',
    backToDetails: 'Back to details',
    routeMap: 'Route map',
    loadingMap: 'Loading route map…',
    approximateRoute: 'Approximate route',
    approximateRouteInfo: 'The route follows real railway lines from Infrabel Open Data. The exact tracks used by this train may differ.',
    mapUnavailable: 'Route map unavailable',
    railRouteUnavailable: 'Railway route unavailable',
    mapSummary: (from, to) => `Route map from ${from} to ${to}`,
    modeRoute: 'From → To',
    modeRouteHint: 'Direct trains only',
    fromLabel: 'From',
    toLabel: 'To',
    showDepartures: 'Show departures',
    directOnly: 'Direct trains only, no transfers.',
    findingDirect: 'Finding direct departures…',
    noDirect: (s) => `No direct departures found to ${s}.`,
    noDirectUnconfirmed: 'No direct departures could be confirmed. Some train routes could not be verified.',
    someUnchecked: 'Some train routes could not be verified.',
    routeFilter: (from, to) => `${from} → ${to}`,
    clearFilter: 'Clear destination filter',
    occupancy: { low: 'Low occupancy', medium: 'Medium occupancy', high: 'High occupancy' },
    performance: 'Performance',
    minutesShort: 'min',
    performanceWindow: (days) => `Last ${days} days`,
    performanceThrough: (through) => `through ${through}`,
    performanceJourneys: (n) => `${n} comparable ${n === 1 ? 'journey' : 'journeys'}`,
    performanceCollecting: (n) => `Collecting history · ${n} ${n === 1 ? 'day' : 'days'} available`,
    performanceLoading: 'Loading historical performance…',
    performanceNoneYet: 'No historical data available yet',
    performanceNotEnoughYet: 'Not enough historical data yet',
    performanceNotComparable: 'Not enough comparable journeys yet',
    performanceStale: 'Historical data is not up to date',
    typicalDelay: 'Typical Delay',
    typicalDelayHint: 'Median delay',
    onTimeRate: 'On-Time Rate',
    onTimeRateHint: 'Under 6 min delay',
    p90Label: '90% Arrive Within',
    p90Hint: '90% of arrivals',
  },
  de: {
    title: 'Abfahrt',
    via: 'über',
    platform: 'Gleis',
    stops: 'Dieser Zug hält in:',
    cancelled: 'Gestrichen',
    cancelledLong: 'Zug gestrichen',
    limited: 'Verkürzt',
    limitedTo: (s) => `Verkürzt bis ${s}.`,
    extra: 'Zusatzzug',
    none: 'Keine Abfahrten',
    offline: 'Keine Verbindung zur Datenquelle',
    pick: 'Bahnhof wählen',
    search: 'Bahnhof suchen',
    loading: 'Bahnhöfe werden geladen…',
    noResults: 'Kein Bahnhof gefunden',
    listFailed: 'Bahnhofsliste nicht verfügbar',
    favorites: 'Favoriten',
    favoritesHint: 'Gespeicherte Bahnhöfe',
    favoritesEmpty: 'Noch keine Lieblingsbahnhöfe.',
    favoriteAdd: (s) => `${s} zu den Favoriten hinzufügen`,
    favoriteRemove: (s) => `${s} aus den Favoriten entfernen`,
    favoriteLimit: 'Sie können bis zu 5 Lieblingsbahnhöfe speichern.',
    language: 'Sprache',
    menu: 'Menü',
    about: 'Über diese Tafel',
    stationLabel: 'Bahnhof',
    updated: 'Zuletzt aktualisiert',
    aboutWhat: 'Dies ist ein unabhängiges, nicht kommerzielles Projekt zur Anzeige belgischer Zugabfahrten in einer Benutzeroberfläche im Stil einer Bahnhofstafel.',
    aboutIndependent: 'Es ist kein offizielles Produkt von SNCB/NMBS und ist weder mit SNCB/NMBS verbunden noch von SNCB/NMBS empfohlen oder betrieben.',
    aboutData: 'Live-Bahndaten werden über die',
    aboutIRail: 'iRail API',
    aboutMapData: 'Die optionale Streckenkarte zeichnet den Verlauf auf Basis offener Daten von Infrabel (CC0); die Hintergrundkarte stammt von © OpenStreetMap-Mitwirkenden. Der Verlauf folgt echten Bahnstrecken, die genauen Gleise, auf denen der Zug fährt, können jedoch abweichen.',
    aboutPerformance: 'Die Pünktlichkeitswerte in den Zugdetails beruhen auf den Rohdaten zur Pünktlichkeit aus den offenen Daten von Infrabel (CC0) der letzten 30 Betriebstage. Sie werden von dieser unabhängigen Website berechnet und sind keine offiziellen Statistiken von Infrabel oder SNCB/NMBS.',
    aboutLive: 'Die hier gezeigten Informationen dienen ausschließlich Informationszwecken. Live-Abfahrtszeiten, Verspätungen, Gleise, Zugausfälle und andere Betriebsinformationen können gelegentlich unvollständig, verspätet, ungenau oder vorübergehend nicht verfügbar sein.',
    aboutOfficial: 'Offizielle Reiseinformationen erhalten Sie bei',
    aboutOfficialSuffix: 'oder dem jeweiligen Eisenbahnunternehmen.',
    aboutTrademarks: 'Die Namen und Marken SNCB/NMBS bleiben Eigentum ihrer jeweiligen Inhaber.',
    fullscreen: 'Vollbild',
    fullscreenExit: 'Vollbild beenden',
    unknownStation: (s) => `Unbekannter Bahnhof „${s}“`,
    details: 'Zugdetails',
    close: 'Schließen',
    arrival: 'Ankunft',
    departureAt: 'Abfahrt',
    extraStop: 'Zusätzlicher Halt',
    platformChange: 'Gleiswechsel',
    delayedBy: (n) => `${n} Minuten Verspätung`,
    currentStation: 'Aktueller Bahnhof',
    loadingRoute: 'Fahrtverlauf wird geladen…',
    noRoute: 'Detaillierte Streckeninformationen sind für diesen Zug nicht verfügbar.',
    back: 'Zurück',
    openMap: 'Karte öffnen',
    backToDetails: 'Zurück zu den Details',
    routeMap: 'Streckenkarte',
    loadingMap: 'Streckenkarte wird geladen…',
    approximateRoute: 'Ungefährer Verlauf',
    approximateRouteInfo: 'Die Strecke folgt echten Bahnstrecken aus den offenen Daten von Infrabel. Die genauen Gleise, auf denen dieser Zug fährt, können davon abweichen.',
    mapUnavailable: 'Streckenkarte nicht verfügbar',
    railRouteUnavailable: 'Streckenverlauf nicht verfügbar',
    mapSummary: (from, to) => `Streckenkarte von ${from} nach ${to}`,
    modeRoute: 'Von → Nach',
    modeRouteHint: 'Nur Direktzüge',
    fromLabel: 'Von',
    toLabel: 'Nach',
    showDepartures: 'Abfahrten anzeigen',
    directOnly: 'Nur Direktzüge, ohne Umstieg.',
    findingDirect: 'Direktverbindungen werden gesucht…',
    noDirect: (s) => `Kein Direktzug nach ${s}.`,
    noDirectUnconfirmed: 'Es konnten keine direkten Verbindungen bestätigt werden. Einige Zugverbindungen konnten nicht überprüft werden.',
    someUnchecked: 'Einige Zugverbindungen konnten nicht überprüft werden.',
    routeFilter: (from, to) => `${from} → ${to}`,
    clearFilter: 'Zielfilter löschen',
    occupancy: { low: 'Geringe Auslastung', medium: 'Mittlere Auslastung', high: 'Hohe Auslastung' },
    performance: 'Pünktlichkeit',
    minutesShort: 'Min.',
    performanceWindow: (days) => `Letzte ${days} Tage`,
    performanceThrough: (through) => `bis ${through}`,
    performanceJourneys: (n) => `${n} vergleichbare ${n === 1 ? 'Fahrt' : 'Fahrten'}`,
    performanceCollecting: (n) => `Verlauf wird erfasst · ${n} ${n === 1 ? 'Tag' : 'Tage'} verfügbar`,
    performanceLoading: 'Historische Pünktlichkeitsdaten werden geladen…',
    performanceNoneYet: 'Noch keine historischen Daten verfügbar',
    performanceNotEnoughYet: 'Noch zu wenige historische Daten',
    performanceNotComparable: 'Noch zu wenige vergleichbare Fahrten',
    performanceStale: 'Historische Daten sind nicht aktuell',
    typicalDelay: 'Übliche Verspätung',
    typicalDelayHint: 'Median der Verspätung',
    onTimeRate: 'Pünktlichkeitsrate',
    onTimeRateHint: 'Weniger als 6 Min. Verspätung',
    p90Label: '90% kommen an innerhalb von',
    p90Hint: '90% der Ankünfte',
  },
};

/* === HELPERS ==================================================== */

// How many rows fit on this screen, at the reference proportions.
function fitRows(measuredHeight) {
  const L = LAYOUTS[CONFIG.layout] || LAYOUTS.compact;
  if (window.matchMedia(STACKED_QUERY).matches) {
    // A phone scrolls, so it is not limited to what fits at once: render
    // the same number of departures the desktop board would and let the
    // page grow. Capping this to a screenful dropped trains on mobile.
    return CONFIG.rows || L.rowsMax;
  }
  if (CONFIG.rows) return CONFIG.rows;
  // Once mounted, the flexed board is the source of truth. The fallback is
  // only used by the state initializer before there is a board to measure.
  const usable = measuredHeight || window.innerHeight * 0.907;
  const target = Math.min(L.maxPx, Math.max(L.minPx, usable * L.share));
  const fitted = Math.min(L.rowsMax, Math.max(L.rowsMin, Math.round(usable / target)));
  // Hold the board at the reference density where the height genuinely carries
  // it; a window too short for that many readable rows keeps the fitted count.
  const cap = L.rowsCap || L.rowsMax;
  return fitted > cap && usable / cap >= L.minPx ? cap : fitted;
}

/* --- remembered preferences ------------------------------------- */

// Three scraps of user intent survive a reload: the station last chosen,
// the language last picked, and the handful of stations starred as
// favourites. Nothing else is persisted — no board, no journeys, no
// filter, no API cache. Storage is treated as unavailable at any moment
// (private windows, blocked site data), so every access is guarded and the
// app simply falls back to its defaults.
const STORE_STATION = 'lastStationSlug';
const STORE_LANG = 'preferredLanguage';
const STORE_FAVORITES = 'favoriteStationSlugs';

// A deliberately short list: the picker offers favourites as a shortcut,
// not as a second board.
const MAX_FAVORITES = 5;

function readStored(key) {
  try {
    const value = window.localStorage.getItem(key);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch { /* storage unavailable: the session simply does not remember */ }
}

// Favourites are stored as canonical slugs — the same readable identifier
// the URL carries — never as translated names. Anything else in the key is
// treated as noise: not an array, entries that are not strings, duplicates
// and anything past the fifth are dropped rather than trusted.
function readFavorites() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORE_FAVORITES));
    if (!Array.isArray(parsed)) return [];
    const slugs = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const slug = entry.trim();
      if (!slug || slugs.includes(slug)) continue;
      slugs.push(slug);
      if (slugs.length === MAX_FAVORITES) break;
    }
    return slugs;
  } catch {
    return [];
  }
}

function writeFavorites(slugs) {
  try {
    window.localStorage.setItem(STORE_FAVORITES, JSON.stringify(slugs));
  } catch { /* storage unavailable: the session simply does not remember */ }
}

// A stored language is only honoured if it is still one the board speaks.
function storedLang() {
  const code = readStored(STORE_LANG);
  return LANGUAGES.some((l) => l.code === code) ? code : CONFIG.lang;
}

// The slugs currently in the address bar, if any.
function slugsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return {
    station: params.get(STATION_PARAM) || '',
    to: params.get(TO_PARAM) || '',
  };
}

// Does this journey call at the chosen destination? The stop list handed
// in is already the slice *after* the boarding stop, so a train that
// passed the station earlier in its run does not match. Identity is the
// canonical iRail station id; `standardname` — the same string in all four
// languages — is the fallback for a stop iRail sent without one.
function servesStation(stops, target) {
  if (!stops?.length || !target) return false;
  return stops.some((stop) => (stop.id && target.id && stop.id === target.id)
    || (stop.standardname && target.standardname
        && stop.standardname === target.standardname));
}

/* === APP ======================================================== */

export default function App() {
  // One source of truth: the whole station object. The display name, the
  // canonical id sent to iRail and the slug shown in the URL are all derived
  // from it, never stored separately.
  const [station, setStation] = useState(DEFAULT_STATION);
  const [stations, setStations] = useState(null);   // the /stations list
  const [unknownSlug, setUnknownSlug] = useState('');
  const [favorites, setFavorites] = useState(readFavorites);
  // The From -> To filter: the whole destination station object, or null
  // for the ordinary full board. Same rule as `station` — one object, and
  // the name, the id and the slug are all derived from it.
  const [destination, setDestination] = useState(null);
  const [picking, setPicking] = useState(false);
  const [about, setAbout] = useState(false);
  // Only the id of the opened departure: the departure itself is derived
  // from the live list below, so it keeps refreshing while the overlay is
  // open instead of freezing a copy.
  const [openId, setOpenId] = useState(null);
  const [route, setRoute] = useState(null);        // the full /vehicle journey
  const [routeLoading, setRouteLoading] = useState(false);
  // How this train has run at this station over the last 30 service
  // days, from the static Infrabel aggregate. Independent of `route`:
  // it is keyed on the train number and the board's own station, so a
  // train with no /vehicle journey can still have a history.
  // Tagged with the departure it belongs to, so a result that lands
  // after the reader has moved on is never drawn under another train.
  const [performance, setPerformance] = useState(null);
  const [board, setBoard] = useState(null);        // last successfully loaded board
  // Journey results by departure id — the shared { status, stops } shape
  // getStops returns, never a bare stop list, so an unavailable journey
  // stays distinguishable from a journey with nothing after this station.
  const [routesById, setRoutesById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The one moment the board's data is from: written by the refresh below
  // when a fetch actually commits, read by the title bar and by the menu.
  const [updatedAt, setUpdatedAt] = useState(null);
  const [rows, setRows] = useState(fitRows);
  const [lang, setLang] = useState(storedLang);    // nl | fr | en | de

  // Dev only: the mock board labels itself with the station on screen,
  // while `refresh` keys on the id alone so filling in a name later never
  // costs a second fetch. The ref keeps the value current without
  // becoming a dependency of the live path.
  const stationRef = useRef(station);
  stationRef.current = station;

  const lastGood = useRef(0);
  const refreshSequence = useRef(0);
  // The remembered station as it was when this session started. A history
  // entry that names no station meant *that* station when it was pushed,
  // so going Back to it must not be answered with whatever the user has
  // chosen since — re-reading the live storage here made Back look as if
  // it had done nothing.
  const openedWith = useRef(readStored(STORE_STATION));
  const stationsRef = useRef(null);
  const noticeRef = useRef(null);
  const screenRef = useRef(null);
  // One language throughout: the fixed wording, and what iRail is asked for.
  const t = TEXT[lang];

  // Picking a language is a deliberate choice, so it outlives the session.
  const selectLanguage = useCallback((code) => {
    setLang(code);
    writeStored(STORE_LANG, code);
  }, []);

  /* --- station list, and the readable slug in the URL ------------- */

  // The same cached /stations call the picker uses — one list, not two.
  // `standardname` and `id` are identical in every language, so switching
  // language never changes which station is selected.
  useEffect(() => {
    let cancelled = false;
    getStations(lang)
      .then((list) => {
        if (cancelled) return;
        stationsRef.current = list;
        setStations(list);
      })
      .catch(() => { /* the picker reports this; the board keeps running */ });
    return () => { cancelled = true; };
  }, [lang]);

  // URL -> state. Resolving a slug means finding it in the real station
  // list; an id is never derived from the slug itself. Unknown slugs fall
  // back to the default station and say so in the notice strip.
  const applyUrl = useCallback((list) => {
    const slugs = slugsFromUrl();
    const found = slugs.station ? findStationBySlug(list, slugs.station) : null;
    // The address bar always wins. Only when it names no station does the
    // remembered slug get a say, and it is resolved through the same real
    // station list — a slug that matches nothing is ignored, silently,
    // because the user never typed it.
    const remembered = slugs.station ? null : findStationBySlug(list, openedWith.current);
    setStation(slugs.station ? (found || DEFAULT_STATION) : (remembered || DEFAULT_STATION));
    setUnknownSlug(!slugs.station || found ? '' : slugs.station);
    // A `to=` that names no real station is simply not a filter: the board
    // falls back to every departure rather than to an invented one.
    setDestination(slugs.to ? findStationBySlug(list, slugs.to) || null : null);
  }, []);

  // Once the list is there, adopt whatever station the address bar names.
  useEffect(() => {
    if (stations) applyUrl(stations);
  }, [stations, applyUrl]);

  // Back / forward: re-resolve, swap the board, no page reload.
  useEffect(() => {
    const onPop = () => applyUrl(stationsRef.current);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [applyUrl]);

  // A deliberate choice by the user: push a history entry so Back returns
  // to the previous station, and touch only the `station` parameter.
  const selectStation = useCallback((picked) => {
    setStation(picked);
    setDestination(null);
    setUnknownSlug('');
    const url = new URL(window.location.href);
    url.searchParams.set(STATION_PARAM, stationToSlug(picked));
    writeStored(STORE_STATION, stationToSlug(picked));
    // Choosing a station is a request for that station's whole board.
    url.searchParams.delete(TO_PARAM);
    window.history.pushState(null, '', url);
  }, []);

  // From -> To: the origin becomes the board's station and the destination
  // becomes its filter. Both travel as readable slugs; every request still
  // uses the canonical ids held in state.
  const selectRoute = useCallback((origin, target) => {
    setStation(origin);
    setDestination(target);
    setUnknownSlug('');
    const url = new URL(window.location.href);
    url.searchParams.set(STATION_PARAM, stationToSlug(origin));
    url.searchParams.set(TO_PARAM, stationToSlug(target));
    // Only the origin is remembered; the From -> To filter is not.
    writeStored(STORE_STATION, stationToSlug(origin));
    window.history.pushState(null, '', url);
  }, []);

  /* --- favourite stations ----------------------------------------- */

  // Stored slugs are resolved back through the same real /stations list as
  // any other slug, so a favourite shows the station's name in the current
  // language and a slug that matches nothing is simply not offered.
  const favoriteStations = useMemo(() => {
    if (!stations) return [];
    return favorites
      .map((slug) => findStationBySlug(stations, slug))
      .filter(Boolean);
  }, [favorites, stations]);

  // Starring a station adds it to the end of the list, so the order is the
  // order they were saved in. A sixth is refused outright rather than
  // pushing one of the five out: the answer is `false`, and the picker says
  // so. Never touches the board's own station.
  const toggleFavorite = useCallback((picked) => {
    const slug = stationToSlug(picked);
    if (!slug) return false;
    const next = favorites.includes(slug)
      ? favorites.filter((s) => s !== slug)
      : favorites.length >= MAX_FAVORITES ? null
        : [...favorites, slug];
    if (!next) return false;
    setFavorites(next);
    writeFavorites(next);
    return true;
  }, [favorites]);

  // Back to the full board for the same station, without leaving it.
  const clearDestination = useCallback(() => {
    setDestination(null);
    const url = new URL(window.location.href);
    url.searchParams.delete(TO_PARAM);
    window.history.pushState(null, '', url);
  }, []);

  /* --- live data, refreshed every CONFIG.refreshMs ---------------- */

  const refresh = useCallback(async (signal) => {
    const sequence = refreshSequence.current + 1;
    refreshSequence.current = sequence;
    try {
      // Always the canonical iRail id — the slug never reaches the API.
      const next = MOCK
        ? (await mockSource()).getMockLiveboard(stationRef.current)
        : await getLiveboard(station.id, lang, signal);
      if (signal?.aborted || sequence !== refreshSequence.current) return;
      setBoard(next);
      setError(null);
      lastGood.current = Date.now();
      setUpdatedAt(lastGood.current);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError'
          || sequence !== refreshSequence.current) return;
      // Keep the last good board on screen; report the problem in the strip.
      console.error('[board] refresh failed:', err);
      setError(err);
    } finally {
      if (!signal?.aborted && sequence === refreshSequence.current) setLoading(false);
    }
  }, [station.id, lang]);

  useEffect(() => {
    const controller = new AbortController();
    setBoard(null);
    // stop lists are cached per departure, and they are language-specific
    setRoutesById({});
    setError(null);
    setLoading(true);
    refresh(controller.signal);
    const id = setInterval(() => refresh(controller.signal), CONFIG.refreshMs);
    return () => { controller.abort(); clearInterval(id); };
  }, [refresh]);

  /* --- intermediate stations of the visible trains ---------------- */

  // The trains whose journey the app wants to know. Without a filter that
  // is just the visible rows, as it has always been. With one it is every
  // departure iRail returned — a direct train to the chosen destination is
  // as likely to be the fortieth row as the fourth, and a count bound there
  // is indistinguishable from a wrong answer. How many rows the board can
  // draw has nothing to do with how many trains have to be checked.
  //
  // Every lookup goes through getStops, which is cached, de-duplicated and
  // paced, so the rows the board already fetched cost nothing a second time
  // and the rest arrive one scheduler slot apart.
  const candidates = useMemo(() => {
    if (!board) return [];
    return destination ? board.departures : board.departures.slice(0, rows);
  }, [board, rows, destination]);

  // Each journey is committed the moment it lands, not once the whole set
  // has. The requests all go straight into getStops, which serialises them
  // behind the shared 400 ms queue, so this costs no more traffic than
  // awaiting them together — it just means an already-cached train shows
  // up at once and the filtered board fills in as the queue drains.
  useEffect(() => {
    if (!CONFIG.showStops || !candidates.length) return undefined;
    let cancelled = false;
    candidates.forEach(async (d) => {
      const result = MOCK
        ? mockResult((await mockSource()).getMockStops(d.vehicleId, d.time))
        : await getStops(d.vehicleId, d.time, lang);
      // The station, the language or the board moved on while this was in
      // the queue: the answer is still cached for whoever wants it next,
      // but it must not reach a board it no longer describes.
      if (cancelled) return;
      setRoutesById((prev) => (
        prev[d.id] === result ? prev : { ...prev, [d.id]: result }));
    });
    return () => { cancelled = true; };
  }, [candidates, lang]);

  // The direct-train filter. Every candidate is in exactly one of four
  // states, and the difference between the last two is the whole point:
  //
  //   pending    its journey has not come back yet
  //   match      its journey is known and calls at the destination later
  //   no-match   its journey is known and does not
  //   unknown    its journey could not be read at all
  //
  // Only a no-match is evidence of absence. An unknown train might well be
  // the direct train the user is looking for, so while any exist the board
  // may report what it found but never that there is nothing to find.
  //
  // Matches are collected in candidate order, which is the liveboard's own
  // chronological order, so the sequence the journeys happen to come back
  // in never reaches the screen.
  const filtered = useMemo(() => {
    if (!destination) return null;
    const matches = [];
    let pending = 0;
    let unknown = 0;
    let checked = 0;
    for (const departure of candidates) {
      const result = routesById[departure.id];
      if (!result) { pending += 1; continue; }
      if (result.status !== 'ok') { unknown += 1; continue; }
      checked += 1;
      if (servesStation(result.stops, destination)) matches.push(departure);
    }
    return {
      matches,
      pending,
      unknown,
      checked,
      total: candidates.length,
      // Every candidate answered, and answered definitively. Anything less
      // and an empty board means "not found", never "not there".
      exhaustive: pending === 0 && unknown === 0,
    };
  }, [destination, candidates, routesById]);

  // Merge the journeys into the departures and derive the shortened-route
  // flag: a run of cancelled stops at the end means the train turns back.
  const departures = useMemo(() => {
    if (!board) return [];
    const source = filtered ? filtered.matches : board.departures;
    return source.slice(0, rows).map((d) => {
      const stops = routesById[d.id]?.stops;
      if (!stops?.length) return d;
      const lastServed = [...stops].reverse().find((s) => !s.cancelled);
      const shortened = Boolean(lastServed) && Boolean(stops.at(-1)?.cancelled);
      return {
        ...d,
        intermediateStops: CONFIG.maxStops ? stops.slice(0, CONFIG.maxStops) : stops,
        shortened,
        shortenedAt: shortened ? lastServed.name : null,
      };
    });
  }, [board, rows, routesById, filtered]);

  /* --- the opened train ------------------------------------------- */

  const selectedDeparture = useMemo(
    () => departures.find((d) => d.id === openId) || null,
    [departures, openId]);

  // A closed overlay, or a departure that has left the board, closes it.
  useEffect(() => {
    if (openId && !selectedDeparture) setOpenId(null);
  }, [openId, selectedDeparture]);

  // The route comes from the same cached, queued /vehicle call the board
  // already uses for its "via" list, so opening a listed train costs no
  // extra request. A train without a journey resolves to null and the
  // overlay says so.
  useEffect(() => {
    if (!selectedDeparture) { setRoute(null); setRouteLoading(false); return; }
    let cancelled = false;
    setRoute(null);
    setRouteLoading(true);
    const journey = MOCK
      ? mockSource().then((m) => m.getMockRoute(selectedDeparture.vehicleId, stationRef.current))
      : getRoute(selectedDeparture.vehicleId, selectedDeparture.time, lang);
    journey
      .then((stops) => { if (!cancelled) { setRoute(stops); setRouteLoading(false); } });
    return () => { cancelled = true; };
  }, [selectedDeparture?.vehicleId, selectedDeparture?.id, lang]);

  // The historical figures, from a static file on this same origin.
  // Deliberately not chained to the route above: nothing here needs the
  // journey, so a slow or missing /vehicle never holds it up, and a
  // train iRail has no journey for can still show a history.
  //
  // One shard per hundred train numbers, fetched the first time a train
  // in that range is opened and kept for the session. The board itself
  // asks for none of this, and every failure resolves to null.
  const stationKey = useMemo(() => stationPerformanceKey(station), [station]);

  // The date is only ever shown once the window has fallen behind, and
  // it is formatted here because App is where the display language is.
  const withLabel = useCallback((result) => (result && {
    ...result,
    throughLabel: result.throughDay
      ? new Intl.DateTimeFormat(DATE_LOCALES[lang] ?? 'en-GB', {
        day: 'numeric', month: 'short', timeZone: 'Europe/Brussels',
      }).format(new Date(`${result.throughDay}T12:00:00Z`))
      : null,
  }), [lang]);

  useEffect(() => {
    if (!selectedDeparture) { setPerformance(null); return undefined; }
    let cancelled = false;
    (MOCK
      ? mockPerformance(selectedDeparture.trainNumber)
      : getPerformance(selectedDeparture.trainNumber, stationKey))
      .then((result) => {
        // A later open has already superseded this one.
        if (cancelled) return;
        setPerformance({ id: selectedDeparture.id, result: withLabel(result) });
      });
    return () => { cancelled = true; };
  }, [selectedDeparture?.id, selectedDeparture?.trainNumber, stationKey, withLabel]);

  // What the panel is actually shown. A result already in hand is read
  // straight out of the session cache during render, so a second train
  // in the same hundred draws its figures in the very first frame
  // rather than blinking through "loading" on the way to them. Null
  // means the shard is genuinely still in flight, and only then does
  // the panel show its loading state — never the previous train's
  // figures, because the stored result is tagged with its departure.
  const shownPerformance = useMemo(() => {
    if (!selectedDeparture) return null;
    if (performance?.id === selectedDeparture.id) return performance.result;
    // The session cache belongs to the real service; the fixture has no
    // shard to have fetched, so the mock board simply waits one tick
    // for the effect above and shows the loading state meanwhile.
    if (MOCK) return null;
    return withLabel(peekPerformance(selectedDeparture.trainNumber, stationKey));
  }, [performance, selectedDeparture?.id, selectedDeparture?.trainNumber, stationKey, withLabel]);

  /* --- clock-independent chrome: layout class, row count, title --- */

  useEffect(() => {
    const cls = `layout-${CONFIG.layout === 'platform' ? 'platform' : 'compact'}`;
    document.body.classList.add(cls);
    return () => document.body.classList.remove(cls);
  }, []);

  // The station on screen, in the display language, in front of the app name.
  // Only a resolved station name changes it: loading, errors and the
  // From -> To filter all keep whatever the last good board titled the tab.
  useEffect(() => {
    document.title = board?.station
      ? `${board.station} · ${DOCUMENT_TITLE}`
      : DOCUMENT_TITLE;
  }, [board?.station]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const refitRows = useCallback(() => {
    const boardElement = screenRef.current?.querySelector(':scope > .departure-board');
    setRows(fitRows(boardElement?.clientHeight));
  }, []);

  // Re-fit from the board's real flexed height on resize/fullscreen and when
  // the viewport crosses the stacked breakpoint.
  useEffect(() => {
    const mq = window.matchMedia(STACKED_QUERY);
    window.addEventListener('resize', refitRows);
    mq.addEventListener('change', refitRows);
    return () => {
      window.removeEventListener('resize', refitRows);
      mq.removeEventListener('change', refitRows);
    };
  }, [refitRows]);

  // `pending` is a count, but nothing on screen wants the number: reduced
  // to a boolean it changes twice per scan instead of once per train, so
  // the row fitting below does not re-run every 400 ms.
  const scanning = (filtered?.pending ?? 0) > 0;

  // Trains were found, but not every candidate could be read. The matches
  // are real and stay the main content; this is a footnote, not a warning.
  const partial = Boolean(destination) && !scanning
    && (filtered?.unknown ?? 0) > 0 && filtered.matches.length > 0;

  /* --- bottom strip: only present when there is something to say -- */

  let notice = null;
  if (error && board) {
    const mins = Math.round((Date.now() - lastGood.current) / 60000);
    notice = { text: `${t.offline} · ${mins} min`, kind: 'alert' };
  } else if (error) {
    notice = { text: t.offline, kind: 'alert' };
  } else if (unknownSlug) {
    notice = { text: t.unknownStation(unknownSlug), kind: 'info' };
  } else if (board?.alerts.length) {
    notice = { text: board.alerts[0], kind: 'info' };
  }

  useLayoutEffect(() => {
    const h = noticeRef.current ? noticeRef.current.offsetHeight : 0;
    document.documentElement.style.setProperty('--notice-h', `${h}px`);
    refitRows();
  }, [notice?.text, notice?.kind, destination, scanning, partial, rows, refitRows]);

  useLayoutEffect(() => {
    const L = LAYOUTS[CONFIG.layout] || LAYOUTS.compact;
    const boardElement = screenRef.current?.querySelector(':scope > .departure-board');
    const boardHeight = boardElement?.clientHeight || 0;
    const rendered = departures.length;
    // Enough slots that a half-empty board is not drawn as a few giant bands,
    // but never more than the fitted count: past it the extra slots would show
    // as blank space under the last train instead of filling the screen.
    const minimumSlots = boardHeight
      ? Math.min(rows, Math.ceil(boardHeight / L.maxPx))
      : 1;
    const fittedRows = window.matchMedia(STACKED_QUERY).matches || !rendered
      ? rows
      : Math.max(rendered, minimumSlots);
    document.documentElement.style.setProperty('--rows', fittedRows);
  }, [departures.length, notice?.text, notice?.kind, destination, rows]);

  // What the board says when it has no rows to draw. With a destination
  // filter on, "no departures" would be wrong twice over: the station does
  // have departures, and this mode only ever looked for direct ones.
  //
  // An empty filtered board says one of three different things, and only
  // the last of them is a claim about the railway: still looking, looked
  // but could not read every train, or looked at every train and there is
  // none. Saying the third when the second is true would be a lie the user
  // has no way to detect.
  const empty = loading ? ''
    : error && !board ? t.offline
      : destination ? (
        scanning ? t.findingDirect
          : filtered?.exhaustive ? t.noDirect(destination.name)
            : t.noDirectUnconfirmed)
        : t.none;

  const closeStationPicker = useCallback(() => setPicking(false), []);
  const closeTrainDetails = useCallback(() => setOpenId(null), []);
  const openAbout = useCallback(() => setAbout(true), []);
  const closeAbout = useCallback(() => setAbout(false), []);

  // Keep obscured application content out of both keyboard navigation and
  // the accessibility tree without placing either overlay inside an inert
  // ancestor. Native inert is restored as soon as the last modal closes.
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen) return undefined;
    const modalOpen = picking || about || Boolean(selectedDeparture);
    const background = [...screen.children].filter(
      (node) => !node.classList.contains('station-overlay')
        && !node.classList.contains('train-overlay')
        && !node.classList.contains('about-overlay'));
    background.forEach((node) => { node.inert = modalOpen; });
    return () => background.forEach((node) => { node.inert = false; });
  }, [picking, about, selectedDeparture]);

  return (
    <div className="screen" ref={screenRef}>
      {/* The page's one heading. The board is a screen, not a document:
          a visible title would have to fight the measured title-bar
          geometry, so this is `.sr-only` — clipped to 1px and out of
          flow, which leaves the layout untouched. The station on screen
          is carried by document.title instead, which is what actually
          follows the board. */}
      <h1 className="sr-only">{DOCUMENT_TITLE}</h1>

      <Header
        station={board?.station ?? ''}
        title={t.title}
        pickLabel={t.pick}
        onPickStation={() => setPicking(true)}
        languages={LANGUAGES}
        lang={lang}
        onLanguage={selectLanguage}
        languageLabel={t.language}
        fullscreenLabel={t.fullscreen}
        fullscreenExitLabel={t.fullscreenExit}
        menuLabel={t.menu}
        aboutLabel={t.about}
        stationLabel={t.stationLabel}
        updatedLabel={t.updated}
        updatedAt={updatedAt}
        onAbout={openAbout}
      />

      <DepartureBoard
        departures={departures}
        layout={CONFIG.layout}
        viaStops={CONFIG.viaStops}
        t={t}
        empty={empty}
        onOpen={(d) => setOpenId(d.id)}
      />

      {(destination || notice) && (
        <div className="notice-stack" ref={noticeRef}>
          {destination && (
            <div className="notice notice--route">
              <span className="notice__route">
                {t.routeFilter(board?.station || station.name, destination.name)}
              </span>
              {/* One steady sentence per state, not a running count: a
                  live region that changed every 400 ms would read every
                  single train's result aloud. */}
              {(scanning || partial) && (
                <span className="notice__progress" role="status" aria-live="polite">
                  {scanning ? t.findingDirect : t.someUnchecked}
                </span>
              )}
              <button
                type="button"
                className="notice__clear"
                onClick={clearDestination}
                aria-label={t.clearFilter}
                title={t.clearFilter}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>
          )}
          {notice && (
            <div className={`notice${notice.kind === 'info' ? ' notice--info' : ''}`}>
              {notice.text}
            </div>
          )}
        </div>
      )}

      <TrainDetailsModal
        departure={selectedDeparture}
        route={route}
        loading={routeLoading}
        performance={shownPerformance}
        stationId={station.id}
        layout={CONFIG.layout}
        viaStops={CONFIG.viaStops}
        t={t}
        onClose={closeTrainDetails}
      />

      <StationModal
        open={picking}
        t={t}
        lang={lang}
        currentStation={station}
        destination={destination}
        favorites={favoriteStations}
        onClose={closeStationPicker}
        onSelect={selectStation}
        onRoute={selectRoute}
        onToggleFavorite={toggleFavorite}
      />

      <AboutModal open={about} t={t} onClose={closeAbout} />

      <div className="sr-only" role="alert">{error ? t.offline : ''}</div>
    </div>
  );
}
