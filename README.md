# Belgian Train Departures

A browser recreation of the blue departure displays found in Belgian railway
stations, running on live data from the public [iRail API](https://docs.irail.be/).

Vite + React with plain CSS and native `fetch` — no backend, no database, no
UI framework, no state-management library. It is an independent, unofficial
project; see [Disclaimer](#disclaimer).

## Features

- **Live departure board** — departures, delays, platforms, platform changes,
  cancellations, extra trains, shortened routes and service alerts from iRail,
  refreshed every 30 seconds.
- **Station-board interface** — the layouts and proportions are modelled on
  real installed displays. Two screen types exist: `compact` (concourse
  overview, one line per train) and `platform` (tall bands with the stop list).
  This is a recreation, not an official SNCB/NMBS product.
- **Station search** — an overlay opened from the title bar, autocompleting
  over the real iRail station list, accent- and language-insensitive.
- **From → To filtering** — restrict the board to direct trains that call at a
  chosen destination.
- **Train Details** — click a departure for its full route as a timeline, with
  per-stop times, platform, delay and occupancy where iRail reports it.
- **Route map** — an optional second view of the details overlay, drawing the
  journey on OpenStreetMap tiles with Leaflet. It is lazy-loaded: a session
  that never opens a map never downloads Leaflet or the rail graph.
- **Four languages** — FR / NL / EN / DE, chosen from the title bar; the fixed
  wording, the iRail data and the document `lang` all follow.
- **Last update indicator** — the title-bar menu shows the moment the board's
  data actually came from.
- **Live Belgian clock** — always `Europe/Brussels`, whatever the machine.
- **Fullscreen** — from the title-bar menu, where the browser allows it.
- **Browser title and favicon** — the tab is named after the station on screen.
- **Responsive layout** — desktop, laptop, tablet and phone, in CSS only.

## Data sources

| | |
|---|---|
| Departures, routes, stations | [iRail](https://docs.irail.be/) (`https://api.irail.be/v1`) |
| Railway geometry for the map | Infrabel open data, preprocessed into a static graph |
| Map base tiles | OpenStreetMap |

No API key is required: iRail is open and sends `Access-Control-Allow-Origin: *`,
so the browser calls it directly. There is no proxy, no backend and no
environment variable to set.

Nothing on the board is invented. A missing platform renders `–`, a train
without a `/vehicle` journey simply shows no stop list, and a failed refresh
keeps the last good board on screen rather than blanking it.

## How it works

`App.jsx` holds all the state — current station, language, last good board,
per-train stop lists, row count, filter, loading and error — and everything
below it is presentational. It fetches the liveboard every 30 seconds and
passes the departures to `DepartureBoard`, which maps them into `DepartureRow`s.

The board fits its own row count to the viewport at the reference row pitch,
holding at about 13 visible departures on a desktop screen. The phone layout
renders the same number of departures and scrolls instead.

The `CONFIG` block at the top of `App.jsx` sets the opening station, the screen
layout (`compact` / `platform`), the starting language, the refresh interval
and how many intermediate stops are printed.

### Networking

Every iRail request — `/stations`, `/liveboard` and `/vehicle` alike — is
dispatched by one shared scheduler in `src/services/irail.js`:

- a minimum of roughly 400 ms between dispatches, so the whole application
  stays inside iRail's rate limit;
- liveboard and station-list requests run at high priority, ahead of
  background route lookups, so a refresh never queues behind a route scan;
- `/vehicle` lookups stay serialized, one in flight at a time;
- journeys are cached and in-flight requests deduplicated, so the 30-second
  refresh normally reuses route data it already has and only genuinely new
  trains cost a request;
- cache hits never consume a scheduler slot.

## From → To

The From → To filter shows only **direct** trains: no change, no connection
search. It is client-side filtering over two iRail datasets.

- `/liveboard` supplies the candidate departures — everything in the station's
  current liveboard horizon, roughly the next hour or two.
- `/vehicle` supplies the authoritative route of each candidate: the stops it
  actually calls at.
- A departure qualifies when its own route, sliced to the stops *after* this
  station, contains the chosen destination. Intermediate stops count; stops
  the train has already passed do not. A qualifying train may well continue
  beyond the destination.

Every departure in the current liveboard is eligible for checking. The 13-row
board limit is a display limit and has nothing to do with how many trains are
evaluated. Matches appear progressively, in liveboard order, as journeys come
back from the queue.

`/connections` is not used as the source of truth. A train whose journey iRail
has no data for, or whose lookup failed, is reported as *unconfirmed* rather
than as a non-match: the board only says "no direct train" when every
candidate came back with a definitive answer.

## Train Details

Clicking a departure opens the details overlay. Its title bar carries the
train's own service label; its summary is the same `DepartureRow` the board
drew, rendered 1:1 rather than as a scaled copy.

Below it is the route timeline — every stop of the journey with its time,
platform, delay and, where iRail reports it, occupancy. The timeline is
horizontal on desktop and tablet and vertical at the phone breakpoint. Desktop
reveals a stop's details on hover; a phone opens the tapped stop's details in
place, one stop at a time.

"Open map" swaps the panel to the route map and "back to details" returns.
The map is lazy-loaded and reuses the journey already in state, so opening it
costs no extra iRail request. The drawn line follows real railway
infrastructure from Infrabel open data, but the exact tracks a train uses are
not knowable from static data — the panel says so, and OpenStreetMap
attribution stays visible.

## Languages

FR, NL, EN and DE. The globe in the title bar switches all fixed wording (the
`TEXT` map in `App.jsx`), the language iRail is asked for, and the document
`lang` attribute. Station identity is keyed on the iRail `id` and
`standardname`, both language-independent, so switching language never changes
which station is selected.

## URL state

The station, and optionally the destination filter, live in the address bar as
readable slugs:

```text
?station=bruxelles-central
?station=bruxelles-central&to=leuven
```

Slugs are public URL state only. They come from the station's `standardname`,
which is the same in all four languages, so a shared link opens the same
station whatever language the board is set to (`brussel-zuid` and
`bruxelles-midi` are the same station). On load a slug is looked up in the
real `/stations` list and resolved to a canonical station object; iRail ids
never appear in the URL and are never reconstructed from a slug. An
unrecognised `?station=` falls back to the default station and says so in the
notice strip; an unrecognised `?to=` is simply no filter.

Only `station` and `to` are touched — every other query parameter is left
alone. History is native `pushState` plus a `popstate` listener, so browser
Back and Forward move between stations and filters without a reload.

## Local preferences

Two values are kept in `localStorage`:

| Key | Meaning |
|---|---|
| `lastStationSlug` | the station last chosen from the picker |
| `preferredLanguage` | the language last picked from the title bar |

Station on startup is resolved in this order: **URL → saved station →
default**. The address bar always wins. No railway data is persisted — no
board, no journeys, no API cache — and every storage access is guarded, so a
private window or blocked site data simply falls back to the defaults.

## Development

```bash
npm install
npm run dev       # preflight launcher + Vite dev server
npm run dev:vite  # Vite alone
npm run build     # static bundle in dist/
npm run preview   # serve the built bundle
```

`npm run dev` goes through `scripts/development/start-local-development.js`, a
zero-dependency launcher that runs a preflight — dependencies, a free port,
and whether iRail is reachable — before starting Vite and printing where the
board is (<http://localhost:5173> by default).

Options: `--port 5174`, `--host` to expose it on the local network, `--open`,
`--no-net` to skip the iRail probe, `--no-color`, `--help` (for example
`npm run dev -- --port 5174`).

There is no lint or test script configured, and no environment variables or
API keys to set.

### Visual test mode

A real liveboard late in the evening carries six or seven trains, which is not
enough to judge the board's density. On the dev server only, `?mock=1`
replaces the live data with a fixture covering every row state:

```text
http://localhost:5173/?mock=1
http://localhost:5173/?mock=1&station=gent-sint-pieters
```

The fixture is `src/services/mockBoard.js`. It is reached only behind
`import.meta.env.DEV`, a compile-time constant, so `npm run build` folds the
flag to `false` and emits neither the fixture nor a code path that could reach
it.

### Rail graph

```bash
node scripts/data/build-rail-network.mjs
```

Regenerates `public/generated/belgian-rail-graph.json` from Infrabel open data.
It is run by hand, not on install or build; re-run it when the Infrabel
datasets change or when `normalizeStationName.js` or the alias table changes,
and commit the result. Nothing imports the file — it is fetched at runtime,
once per session, after the map is opened.

## Project structure

```text
index.html                          page shell, mounts #root
public/
├── favicon.svg                     tab icon
├── robots.txt                      crawl policy
├── llms.txt                        machine-readable project summary
└── generated/                      the preprocessed rail graph (fetched, never imported)
scripts/
├── development/                    zero-dependency dev launcher
└── data/build-rail-network.mjs     rail graph preprocessor
src/
├── components/
│   ├── Header.jsx                  title bar: clock, station, menu, language
│   ├── DepartureBoard.jsx          renders the list of departures
│   ├── DepartureRow.jsx            one train, in either screen layout
│   ├── StationModal.jsx            station picker and the From → To form
│   ├── TrainDetailsModal.jsx       details overlay: timeline, stops, map view
│   ├── TrainRouteMap.jsx           the lazy-loaded Leaflet route map
│   └── AboutModal.jsx              the About panel
├── services/
│   ├── irail.js                    all iRail calls, scheduler, caches, search
│   ├── railRoute.js                rail graph, station matching, routing
│   └── mockBoard.js                dev-only fixture board (?mock=1)
├── data/rail/                      station-name normaliser and alias table
├── App.jsx                         configuration, state, refresh loop, wording
├── main.jsx                        React entry point
└── styles.css                      design tokens and all styling
```

## API / rate limiting

All iRail communication lives in `src/services/irail.js`; no component ever
holds an iRail URL.

- `/liveboard` — the departures of a station
- `/vehicle` — the full journey of one train, cached per train and day
- `/stations` — the station list behind the picker, cached per language

iRail allows 3 requests per second per IP. That budget belongs to the whole
application, so there is exactly one scheduler and one limiter, described
under [How it works](#networking). A 429 pushes the next dispatch slot out
once; nothing retries automatically, so a failure can never become a retry
storm.

## Styling

All styling is in `src/styles.css`. A `:root` block holds the design tokens —
colours, typography, spacing, radii, shadows, motion and z-index layers — and
the rest of the sheet is organised into sections. Board geometry is derived
from the row height, which is itself derived from the viewport, so the
measured proportions hold at any resolution. There are four breakpoints —
desktop (≥1200px), laptop (≤1199px), tablet (≤899px), phone (≤599px) — plus a
short-viewport guard. See `AGENTS.md` for the conventions to follow.

## Limitations

- The board shows what iRail's liveboard currently returns, roughly the next
  hour or two — not the whole day's timetable.
- From → To is direct trains only. It never proposes a journey with a change.
- Live railway information can be delayed, incomplete, inaccurate or
  temporarily unavailable.
- The route map's line is approximate: it follows real railway infrastructure
  but not necessarily the tracks a given train used, and a journey that cannot
  be matched end to end shows no map rather than a wrong one.
- iRail reports no continuous train positions, so nothing here is a live
  vehicle location.

## Disclaimer

This is an independent, non-commercial project. It is not an official
SNCB/NMBS product, and it is not affiliated with, endorsed by, or operated by
SNCB/NMBS. The SNCB/NMBS names and trademarks remain the property of their
respective owners.

Railway data is provided through the iRail API and is shown for information
only; it may be incomplete or delayed. For official travel information,
consult [SNCB/NMBS](https://www.belgiantrain.be/) or the railway operator
concerned.

## License

No license has been specified for this repository.
