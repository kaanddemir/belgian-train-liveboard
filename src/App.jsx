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
const DOCUMENT_TITLE = 'Belgian Train Liveboard';

// The second parameter the board owns, and only while the From -> To
// filter is on: the readable slug of the destination the listed trains
// have to call at. Like `station` it is a slug, never an iRail id, and it
// is resolved back to a real station object from the /stations list.
const TO_PARAM = 'to';

// An opened Train Details view, addressable while it is open: the train
// number and the exact *scheduled* departure in Unix seconds. The number
// alone repeats every day; the timestamp pins the one run, date included,
// and a delay never changes it.
const TRAIN_PARAM = 'train';
const DEP_PARAM = 'dep';
const TRAIN_PATTERN = /^[A-Za-z0-9]{1,12}$/;
// 2001-09-09 .. 2100-01-01: anything outside is not a departure time.
const DEP_MIN = 1_000_000_000;
const DEP_MAX = 4_102_444_800;
// How long the "no longer on the board" line stays before it clears itself.
const MISSING_LINK_MS = 10_000;

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
    aboutWhat: 'Belgian Train Liveboard is een onafhankelijk project om Belgische treinvertrekken te bekijken in een interface naar het voorbeeld van een stationsbord.',
    aboutFeatures: 'Het brengt live vertrekken, treindetails, routekaarten en historische stiptheid samen op één plek.',
    aboutData: 'Live spoorweggegevens komen van de',
    aboutIRail: 'iRail API',
    aboutMapData: 'Spoorroutes en historische stiptheid zijn afgeleid van Infrabel Open Data; de kaarten gebruiken OpenStreetMap.',
    aboutPerformance: 'De historische prestaties in de treindetails worden door dit project berekend uit vroegere aankomstvertragingen, om te tonen hoe een trein doorgaans reed in het gekozen station.',
    aboutPurpose: 'Het project wil een lichte, onofficiële manier bieden om Belgische spoorweginformatie te verkennen.',
    aboutOfficial: 'Raadpleeg voor officiële reisinformatie',
    aboutOfficialSuffix: 'of de betrokken spoorwegmaatschappij.',
    legal: 'Juridisch & disclaimer',
    legalSections: [
      ['Onafhankelijk project', 'Deze site is niet verbonden aan, gesponsord, goedgekeurd of uitgebaat door SNCB/NMBS, Infrabel, iRail of een andere spoorwegmaatschappij.'],
      ['Gegevens en nauwkeurigheid', 'Vertrektijden, vertragingen, sporen, afschaffingen en andere dienstinformatie kunnen vertraagd, onvolledig, onjuist of niet beschikbaar zijn. Controleer belangrijke reisinformatie altijd bij officiële bronnen.'],
      ['Historische prestaties', 'Deze cijfers zijn afgeleid van historische stiptheidsgegevens. Het zijn geen voorspellingen en geen officiële statistieken van SNCB/NMBS, Infrabel of iRail.'],
      ['Gegevens en diensten van derden', 'Live gegevens: iRail API. Routes en stiptheid: Infrabel Open Data (CC0). Achtergrondkaart: © OpenStreetMap-bijdragers.'],
      ['Geen garantie', 'De informatie wordt uitsluitend ter informatie aangeboden. Voor zover toegestaan door het toepasselijke recht wordt niet gegarandeerd dat ze volledig, actueel of foutloos is. Gebruik deze site niet als enige bron voor tijdgevoelige reisbeslissingen.'],
      ['Handelsmerken', 'Namen, logo’s en handelsmerken blijven eigendom van hun respectieve eigenaars. Het vermelden ervan houdt geen verbondenheid of goedkeuring in.'],
    ],
    fullscreen: 'Volledig scherm',
    fullscreenExit: 'Volledig scherm verlaten',
    unknownStation: (s) => `Onbekend station “${s}”`,
    details: 'Treindetails',
    close: 'Sluiten',
    share: 'Delen',
    shareCopied: 'Link gekopieerd',
    shareFailed: 'Kon de link niet kopiëren. Kopieer hem hieronder:',
    shareLink: 'Link naar dit vertrek',
    linkMissing: 'Dit vertrek staat niet meer op het bord',
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
    aboutWhat: 'Belgian Train Liveboard est un projet indépendant pour consulter les départs des trains belges dans une interface inspirée des tableaux de gare.',
    aboutFeatures: 'Il réunit en un seul endroit les départs en temps réel, les détails des trains, les cartes de parcours et la ponctualité historique.',
    aboutData: 'Les données ferroviaires en temps réel proviennent de',
    aboutIRail: 'l’API iRail',
    aboutMapData: 'Les tracés ferroviaires et la ponctualité historique sont issus des données ouvertes d’Infrabel ; les cartes utilisent OpenStreetMap.',
    aboutPerformance: 'La ponctualité historique affichée dans les détails du train est calculée par ce projet à partir des retards d’arrivée passés, pour montrer comment un train a généralement circulé dans la gare choisie.',
    aboutPurpose: 'Le projet se veut une façon légère et non officielle d’explorer l’information ferroviaire belge.',
    aboutOfficial: 'Pour obtenir des informations de voyage officielles, consultez',
    aboutOfficialSuffix: 'ou l’opérateur ferroviaire concerné.',
    legal: 'Mentions légales',
    legalSections: [
      ['Projet indépendant', 'Ce site n’est ni affilié à, ni sponsorisé, approuvé ou exploité par SNCB/NMBS, Infrabel, iRail ou tout autre opérateur ferroviaire.'],
      ['Données et exactitude', 'Les heures de départ, retards, voies, suppressions et autres informations de service peuvent être retardés, incomplets, inexacts ou indisponibles. Vérifiez toujours les informations importantes auprès des sources officielles.'],
      ['Ponctualité historique', 'Ces chiffres sont dérivés de données historiques de ponctualité. Ce ne sont pas des prévisions, ni des statistiques officielles de SNCB/NMBS, d’Infrabel ou d’iRail.'],
      ['Données et services tiers', 'Données en temps réel : API iRail. Parcours et ponctualité : Infrabel Open Data (CC0). Fond de carte : © contributeurs d’OpenStreetMap.'],
      ['Absence de garantie', 'Les informations sont fournies à titre informatif. Dans la mesure permise par la loi applicable, aucune garantie n’est donnée quant à leur exhaustivité, leur actualité ou leur exactitude. Ne vous fiez pas à ce site comme seule source pour des décisions de voyage urgentes.'],
      ['Marques', 'Les noms, logos et marques restent la propriété de leurs détenteurs respectifs. Leur mention n’implique ni affiliation ni approbation.'],
    ],
    fullscreen: 'Plein écran',
    fullscreenExit: 'Quitter le plein écran',
    unknownStation: (s) => `Gare inconnue « ${s} »`,
    details: 'Détails du train',
    close: 'Fermer',
    share: 'Partager',
    shareCopied: 'Lien copié',
    shareFailed: 'Impossible de copier le lien. Copiez-le ci-dessous :',
    shareLink: 'Lien vers ce départ',
    linkMissing: 'Ce départ n’est plus affiché',
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
    aboutWhat: 'Belgian Train Liveboard is an independent project for viewing Belgian train departures in a station-board-inspired interface.',
    aboutFeatures: 'It brings together live departures, Train Details, route maps and historical punctuality insights in one place.',
    aboutData: 'Live railway data is provided through the',
    aboutIRail: 'iRail API',
    aboutMapData: 'Railway routes and historical punctuality data are derived from Infrabel Open Data, while maps use OpenStreetMap.',
    aboutPerformance: 'Historical Performance in Train Details is calculated by this project from past arrival-delay data, to give context about how a train has typically performed at the selected station.',
    aboutPurpose: 'The project is intended as a lightweight, unofficial way to explore Belgian railway information.',
    aboutOfficial: 'For official travel information, please consult',
    aboutOfficialSuffix: 'or the relevant railway operator.',
    legal: 'Legal & Disclaimer',
    legalSections: [
      ['Independent project', 'This site is not affiliated with, sponsored by, endorsed by, or operated by SNCB/NMBS, Infrabel, iRail or any railway operator.'],
      ['Data and accuracy', 'Departure times, delays, platforms, cancellations and other service information may be delayed, incomplete, inaccurate or unavailable. Always verify important travel information with official sources.'],
      ['Historical performance', 'These figures are derived from historical punctuality data. They are not predictions, and they are not official SNCB/NMBS, Infrabel or iRail statistics.'],
      ['Third-party data and services', 'Live data: iRail API. Routes and punctuality: Infrabel Open Data (CC0). Base map: © OpenStreetMap contributors.'],
      ['No warranty', 'Information is provided for informational purposes only. To the extent permitted by applicable law, no guarantee is made that it is complete, current or error-free. Do not rely on this site as your sole source for time-sensitive travel decisions.'],
      ['Trademarks', 'Names, logos and trademarks remain the property of their respective owners. Their inclusion does not imply affiliation or endorsement.'],
    ],
    fullscreen: 'Full screen',
    fullscreenExit: 'Exit full screen',
    unknownStation: (s) => `Unknown station “${s}”`,
    details: 'Train details',
    close: 'Close',
    share: 'Share',
    shareCopied: 'Link copied',
    shareFailed: 'Could not copy the link. Copy it below:',
    shareLink: 'Link to this departure',
    linkMissing: 'This departure is no longer on the board',
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
    aboutWhat: 'Belgian Train Liveboard ist ein unabhängiges Projekt, das belgische Zugabfahrten in einer an Bahnhofstafeln angelehnten Oberfläche zeigt.',
    aboutFeatures: 'Es vereint Live-Abfahrten, Zugdetails, Streckenkarten und historische Pünktlichkeit an einem Ort.',
    aboutData: 'Live-Bahndaten stammen aus der',
    aboutIRail: 'iRail API',
    aboutMapData: 'Bahnstrecken und historische Pünktlichkeitsdaten stammen aus Infrabel Open Data; die Karten nutzen OpenStreetMap.',
    aboutPerformance: 'Die historische Pünktlichkeit in den Zugdetails berechnet dieses Projekt aus vergangenen Ankunftsverspätungen – als Einordnung, wie ein Zug am gewählten Bahnhof üblicherweise unterwegs war.',
    aboutPurpose: 'Das Projekt soll eine schlanke, inoffizielle Möglichkeit bieten, belgische Bahninformationen zu erkunden.',
    aboutOfficial: 'Offizielle Reiseinformationen erhalten Sie bei',
    aboutOfficialSuffix: 'oder dem jeweiligen Eisenbahnunternehmen.',
    legal: 'Rechtliches & Haftungsausschluss',
    legalSections: [
      ['Unabhängiges Projekt', 'Diese Website ist weder mit SNCB/NMBS, Infrabel, iRail oder einem anderen Eisenbahnunternehmen verbunden noch von ihnen gesponsert, empfohlen oder betrieben.'],
      ['Daten und Genauigkeit', 'Abfahrtszeiten, Verspätungen, Gleise, Zugausfälle und andere Betriebsinformationen können verzögert, unvollständig, ungenau oder nicht verfügbar sein. Prüfen Sie wichtige Reiseinformationen stets bei offiziellen Quellen.'],
      ['Historische Pünktlichkeit', 'Diese Werte beruhen auf historischen Pünktlichkeitsdaten. Sie sind keine Prognosen und keine offiziellen Statistiken von SNCB/NMBS, Infrabel oder iRail.'],
      ['Daten und Dienste Dritter', 'Live-Daten: iRail API. Strecken und Pünktlichkeit: Infrabel Open Data (CC0). Hintergrundkarte: © OpenStreetMap-Mitwirkende.'],
      ['Keine Gewähr', 'Die Informationen dienen ausschließlich Informationszwecken. Soweit nach geltendem Recht zulässig, wird keine Gewähr für Vollständigkeit, Aktualität oder Fehlerfreiheit übernommen. Verlassen Sie sich bei zeitkritischen Reiseentscheidungen nicht allein auf diese Website.'],
      ['Marken', 'Namen, Logos und Marken bleiben Eigentum ihrer jeweiligen Inhaber. Ihre Nennung bedeutet keine Verbindung oder Billigung.'],
    ],
    fullscreen: 'Vollbild',
    fullscreenExit: 'Vollbild beenden',
    unknownStation: (s) => `Unbekannter Bahnhof „${s}“`,
    details: 'Zugdetails',
    close: 'Schließen',
    share: 'Teilen',
    shareCopied: 'Link kopiert',
    shareFailed: 'Link konnte nicht kopiert werden. Bitte unten kopieren:',
    shareLink: 'Link zu dieser Abfahrt',
    linkMissing: 'Diese Abfahrt steht nicht mehr auf der Tafel',
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

// The departure named in the address bar: null when there is none,
// `false` when the parameters are there but not a departure identity.
function linkFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const train = params.get(TRAIN_PARAM);
  const dep = params.get(DEP_PARAM);
  if (train === null && dep === null) return null;
  const seconds = /^\d{10}$/.test(dep ?? '') ? Number(dep) : NaN;
  return TRAIN_PATTERN.test(train ?? '') && seconds >= DEP_MIN && seconds <= DEP_MAX
    ? { train, dep: seconds }
    : false;
}

// The same identity for a departure on the board. The train number is
// `vehicleLabel()`'s; only a label it could not split falls back to the
// last segment of the vehicle id. A row without a vehicle is not linkable.
function departureLink(departure) {
  if (!departure?.vehicleId || !(departure.time instanceof Date)) return null;
  const train = departure.trainNumber || departure.vehicleId.split('.').pop();
  const dep = Math.floor(departure.time.getTime() / 1000);
  return TRAIN_PATTERN.test(train) && Number.isFinite(dep) ? { train, dep } : null;
}

const sameLink = (a, b) => Boolean(a && b) && a.train === b.train && a.dep === b.dep;

// The current URL with the departure set, or removed when `link` is null.
// Every other parameter (`station`, `to`, `mock`, ...) is left as it is.
function urlWithLink(link) {
  const url = new URL(window.location.href);
  if (link) {
    url.searchParams.set(TRAIN_PARAM, link.train);
    url.searchParams.set(DEP_PARAM, String(link.dep));
  } else {
    url.searchParams.delete(TRAIN_PARAM);
    url.searchParams.delete(DEP_PARAM);
  }
  return url;
}

// history.state minus the marker that says "this entry was pushed by
// opening Train Details", so whatever else is in it survives.
function stateWithoutDetails() {
  const { trainDetails, ...rest } = window.history.state || {};
  return Object.keys(rest).length ? rest : null;
}

// Drop the departure from the current entry without adding one.
function clearLinkFromUrl() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(TRAIN_PARAM) && !params.has(DEP_PARAM)) return;
  window.history.replaceState(stateWithoutDetails(), '', urlWithLink(null));
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
  // which informational panel is open, if any: 'about' | 'legal'
  const [info, setInfo] = useState(null);
  // Only the id of the opened departure: the departure itself is derived
  // from the live list below, so it keeps refreshing while the overlay is
  // open instead of freezing a copy.
  const [openId, setOpenId] = useState(null);
  // A departure named by the URL that has not been looked for yet, tagged
  // with the id of the station it belongs to. One-shot: the first board of
  // that station consumes it, found or not, so no later refresh reopens a
  // panel the user has closed.
  const [pendingLink, setPendingLink] = useState(null);
  // That lookup came back empty. Shown as the board's first line until
  // the user navigates somewhere else.
  const [missingLink, setMissingLink] = useState(false);
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
  const applyUrl = useCallback((list, withLink) => {
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
    // The departure, on start-up and on Back / Forward only: a language
    // switch re-resolves the station but is not a navigation. It is only
    // ever looked for on the board of the station the URL names, so a
    // link without one, or naming an unknown one, is not a link at all.
    if (!withLink) return;
    const link = linkFromUrl();
    setMissingLink(false);
    if (link && found) {
      setPendingLink({ ...link, stationId: found.id });
    } else {
      setPendingLink(null);
      setOpenId(null);
      if (link !== null) clearLinkFromUrl();
    }
  }, []);

  // Once the list is there, adopt whatever station the address bar names.
  // Only the first list carries the departure; later ones are language
  // switches.
  const linkApplied = useRef(false);
  useEffect(() => {
    if (!stations) return;
    applyUrl(stations, !linkApplied.current);
    linkApplied.current = true;
  }, [stations, applyUrl]);

  // Back / forward: re-resolve, swap the board, no page reload.
  useEffect(() => {
    const onPop = () => applyUrl(stationsRef.current, true);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [applyUrl]);

  // A deliberate choice by the user: push a history entry so Back returns
  // to the previous station, and touch only the `station` parameter.
  const selectStation = useCallback((picked) => {
    setStation(picked);
    setDestination(null);
    setUnknownSlug('');
    setOpenId(null);
    setPendingLink(null);
    setMissingLink(false);
    const url = urlWithLink(null);
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
    setOpenId(null);
    setPendingLink(null);
    setMissingLink(false);
    const url = urlWithLink(null);
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
    const url = urlWithLink(null);
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
      // Tagged with the station it was fetched for, so a board that lands
      // for the start-up default is never searched for a linked departure.
      setBoard({ ...next, stationId: station.id });
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
  const withJourney = useCallback((d) => {
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
  }, [routesById]);

  const departures = useMemo(() => {
    if (!board) return [];
    const source = filtered ? filtered.matches : board.departures;
    return source.slice(0, rows).map(withJourney);
  }, [board, rows, withJourney, filtered]);

  /* --- the opened train ------------------------------------------- */

  // Looked up on the whole board, not only the rows drawn: a linked train
  // may sit below the row limit or outside the From -> To matches, and it
  // is still a departure iRail returned.
  const selectedDeparture = useMemo(() => {
    if (!openId) return null;
    const shown = departures.find((d) => d.id === openId);
    if (shown) return shown;
    const listed = board?.departures.find((d) => d.id === openId);
    return listed ? withJourney(listed) : null;
  }, [departures, board, openId, withJourney]);

  // A departure that has left the board closes the overlay, and the URL
  // stops naming it.
  useEffect(() => {
    if (openId && !selectedDeparture) {
      setOpenId(null);
      clearLinkFromUrl();
    }
  }, [openId, selectedDeparture]);

  // The linked departure, looked for exactly once, on the first board of
  // the station the URL names — scheduled time and train number, never
  // the number alone. A departure that is not there is reported, and no
  // other train is opened in its place.
  useEffect(() => {
    if (!pendingLink || !board || board.stationId !== pendingLink.stationId) return;
    setPendingLink(null);
    const match = board.departures.find((d) => sameLink(departureLink(d), pendingLink));
    if (match) {
      setOpenId(match.id);
    } else {
      setOpenId(null);
      setMissingLink(true);
      clearLinkFromUrl();
    }
  }, [pendingLink, board]);

  // A row click: open it and give it a history entry of its own, marked
  // so closing the panel can step back over it.
  const openDeparture = useCallback((d) => {
    setOpenId(d.id);
    setPendingLink(null);
    setMissingLink(false);
    const link = departureLink(d);
    if (!link) return;
    window.history.pushState(
      { ...(window.history.state || {}), trainDetails: true }, '', urlWithLink(link));
  }, []);

  // What Share hands on: the canonical link, from the row already on
  // screen. No request is made for it.
  const share = useMemo(() => {
    const link = departureLink(selectedDeparture);
    if (!link) return null;
    const url = urlWithLink(link);
    url.searchParams.set(STATION_PARAM, stationToSlug(station));
    if (destination) url.searchParams.set(TO_PARAM, stationToSlug(destination));
    else url.searchParams.delete(TO_PARAM);
    return { url: url.href };
  }, [selectedDeparture, station, destination]);

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

  // The missing-departure line is drawn as the board's first row, in a
  // row's height, so on a fitted desktop board it takes one train's slot
  // rather than pushing the last row out of the clipped board. The phone
  // scrolls, so there it simply sits above every train.
  const stacked = window.matchMedia(STACKED_QUERY).matches;
  const boardDepartures = missingLink && !stacked
    ? departures.slice(0, Math.max(0, rows - 1))
    : departures;
  const boardSlots = boardDepartures.length + (missingLink ? 1 : 0);

  useLayoutEffect(() => {
    const L = LAYOUTS[CONFIG.layout] || LAYOUTS.compact;
    const boardElement = screenRef.current?.querySelector(':scope > .departure-board');
    const boardHeight = boardElement?.clientHeight || 0;
    const rendered = boardSlots;
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
  }, [boardSlots, notice?.text, notice?.kind, destination, rows]);

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

  // The removed button took focus with it; hand it to the first train.
  const dismissMissingLink = useCallback(() => {
    setMissingLink(false);
    requestAnimationFrame(() => {
      const screen = screenRef.current;
      (screen?.querySelector('.departure-row.is-openable')
        || screen?.querySelector('.topbar-pick'))?.focus();
    });
  }, []);
  // The notice is transient: it goes by itself after ten seconds. Focus
  // is only moved if it was on the notice's own X, which is going away.
  useEffect(() => {
    if (!missingLink) return undefined;
    const id = setTimeout(() => {
      if (document.activeElement?.closest('.departure-board__notice')) dismissMissingLink();
      else setMissingLink(false);
    }, MISSING_LINK_MS);
    return () => clearTimeout(id);
  }, [missingLink, dismissMissingLink]);

  const closeStationPicker = useCallback(() => setPicking(false), []);
  // An entry this session pushed for the panel is stepped back over, so
  // Back and Close agree. A link opened directly has nothing of ours
  // behind it — going back would leave the site — so its entry is
  // rewritten to the plain board instead.
  const closeTrainDetails = useCallback(() => {
    setOpenId(null);
    if (!new URLSearchParams(window.location.search).has(TRAIN_PARAM)) return;
    if (window.history.state?.trainDetails) window.history.back();
    else clearLinkFromUrl();
  }, []);
  const openAbout = useCallback(() => setInfo('about'), []);
  const openLegal = useCallback(() => setInfo('legal'), []);
  const closeInfo = useCallback(() => setInfo(null), []);

  // Keep obscured application content out of both keyboard navigation and
  // the accessibility tree without placing either overlay inside an inert
  // ancestor. Native inert is restored as soon as the last modal closes.
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen) return undefined;
    const modalOpen = picking || Boolean(info) || Boolean(selectedDeparture);
    const background = [...screen.children].filter(
      (node) => !node.classList.contains('station-overlay')
        && !node.classList.contains('train-overlay')
        && !node.classList.contains('about-overlay'));
    background.forEach((node) => { node.inert = modalOpen; });
    return () => background.forEach((node) => { node.inert = false; });
  }, [picking, info, selectedDeparture]);

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
        legalLabel={t.legal}
        stationLabel={t.stationLabel}
        updatedLabel={t.updated}
        updatedAt={updatedAt}
        onAbout={openAbout}
        onLegal={openLegal}
      />

      <DepartureBoard
        departures={boardDepartures}
        layout={CONFIG.layout}
        viaStops={CONFIG.viaStops}
        t={t}
        empty={empty}
        notice={missingLink ? t.linkMissing : ''}
        onDismissNotice={dismissMissingLink}
        onOpen={openDeparture}
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
        share={share}
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

      <AboutModal kind={info} t={t} onClose={closeInfo} />

      <div className="sr-only" role="alert">{error ? t.offline : ''}</div>
      {/* Set once when a linked departure is not found; the board's own
          refreshes never change it, so it is read once. */}
      <div className="sr-only" role="status">{missingLink ? t.linkMissing : ''}</div>
    </div>
  );
}
