# AGENTS.md

Engineering instructions for coding agents working in this repository.
Read `README.md` for what the project is and how to run it; this file is
about how to change it safely.

## Project purpose

A browser recreation of the SNCB/NMBS departure displays installed in
Belgian stations, fed by live iRail data. The UI **intentionally mimics
real railway information screens** — the layouts, colours and
proportions were measured from photographs of installed displays, not
designed. Visual fidelity to those screens is a feature, not an accident;
treat unexplained deviations as bugs and do not "modernise" the board.

## Stack

- **Vite 5** for the build and the dev server.
- **React 18**, function components and hooks only.
- **JavaScript** (ESM, JSX). No TypeScript, no build-time codegen.
- **Plain CSS**, one stylesheet, CSS custom properties.
- **Native `fetch`** against iRail. No backend, no proxy, no API key, no
  environment variables.
- Runtime dependencies are `react`, `react-dom` and `leaflet`, and
  `leaflet` only inside the lazy map chunk. Adding anything else needs a
  stated reason; see the coding rules below.

## Architecture

```text
main.jsx  →  App
             ├── Header            (clock, station name, search + language buttons)
             ├── DepartureBoard    (list)
             │   └── DepartureRow  (CompactRow | PlatformRow)
             ├── notice stack      (route filter chip + notice strip,
             │                      inline in App.jsx)
             ├── StationModal      (station picker / From -> To form)
             ├── TrainDetailsModal (train details overlay)
             │   ├── TrainRouteMap (lazy, the map view of that same panel)
             │   └── Performance    (historical figures, inline disclosure)
             └── AboutModal        (about / disclaimer panel)
```

State lives in `App.jsx` only: current station, the From -> To
destination, language, last good board, per-train journey results, the
opened departure and its route, row count, last-update time, and
loading/error. Everything below
it is presentational and receives props. `Header` owns its own clock,
`StationModal` owns its own query/result state — nothing else holds
state.

Two board layouts exist, selected by `CONFIG.layout` in `App.jsx`:
`compact` (one line per train) and `platform` (tall bands). The choice
adds a `layout-compact` / `layout-platform` class to `<body>`, and
`DepartureRow` renders the matching sub-component. Both layouts share
the same class names; the CSS differs per layout prefix.

## File responsibilities

```text
src/main.jsx                    React entry point; mounts <App> and imports styles.css.
src/App.jsx                     CONFIG block, translations (TEXT), app state, the 30 s
                                refresh loop, row-count fitting, the notice strip.
src/components/Header.jsx       Title bar: Brussels clock, station name, search button,
                                menu (language, fullscreen, last update, About).
src/components/DepartureBoard.jsx  Maps departures to rows; renders the empty state.
src/components/DepartureRow.jsx Both row layouts, the delay badge, disruption bands,
                                platform cell and inline stop lists.
src/components/StationModal.jsx Search overlay, two faces in one dialog: the station
                                picker (input, keyboard navigation, suggestion
                                list), which is always what an opening shows,
                                and the From -> To route filter form it swaps
                                to in place.
src/components/TrainDetailsModal.jsx  Train details overlay: the train's service label in
                                the bar, the clicked row redrawn by DepartureRow, the
                                route timeline (horizontal on desktop/tablet, vertical
                                on a phone), stop details, occupancy, and the lazy
                                import of the map view.
src/components/AboutModal.jsx   The informational panel, two faces picked by `kind`:
                                About (short plain-language summary) and Legal &
                                Disclaimer (six short sections), all of it from TEXT.
src/services/irail.js           All iRail communication, response normalisation,
                                caching and the station search/ranking algorithm.
src/services/mockBoard.js       Development-only fixture board behind `?mock=1`.
                                Never imported by a production build.
src/components/TrainRouteMap.jsx  The optional route map. Lazy-loaded; the only
                                module that imports Leaflet.
src/services/railRoute.js       Rail graph fetch/cache, iRail-to-Infrabel station
                                matching, Dijkstra, geometry concatenation.
src/services/punctuality.js     Historical Performance: shard fetch, session memoisation,
                                staleness, and the null-on-anything-wrong contract.
                                Never computes a statistic.
scripts/data/build-punctuality.mjs
                                Infrabel punctuality pipeline. Run by a schedule, not by
                                the build. Node stdlib only.
.github/workflows/punctuality.yml
                                The only thing that ever talks to Infrabel for punctuality.
                                Writes the orphan `data` branch.
src/data/rail/normalizeStationName.js  The one station-name normaliser, shared by
                                the build scripts and the runtime. Also exports
                                stationPerformanceKey(), the key both halves of
                                Performance must agree on exactly.
src/data/rail/stationAliases.js Verified iRail/Infrabel name differences.
public/generated/belgian-rail-graph.json  Generated. Never imported — fetched at
                                runtime after the map is opened.
src/styles.css                  Design tokens and every style rule in the app.
scripts/development/start-local-development.js
                                Dev launcher (preflight + Vite). Node stdlib only.
scripts/data/build-rail-network.mjs
                                Rail graph preprocessor. Run by hand, not by the
                                build. Node stdlib only.
```

## Coding rules

- Keep the project lightweight. It is a small app, not an enterprise
  codebase.
- Prefer native browser APIs (`fetch`, `Intl`, `matchMedia`,
  `AbortController`) over libraries.
- Do not add dependencies without a clear, stated reason. Runtime
  dependencies are `react`, `react-dom` and `leaflet`; keep it that way.
  Leaflet is the one narrow exception, admitted for the optional route
  map only, and it is never imported outside the lazy map chunk. It does
  not loosen this rule for anything else: no React-Leaflet, no Mapbox, no
  OpenLayers, no routing or graph library — the map's routing is a small
  Dijkstra in `src/services/railRoute.js`.
- Never add Tailwind, Sass, styled-components, a CSS-in-JS runtime, a
  component library, or a state-management library (Redux, Zustand, …).
- Use function components and hooks. No classes.
- Keep API logic out of presentation components: all iRail access goes
  through `src/services/irail.js`.
- Keep translations in the `TEXT` map in `App.jsx` and pass them down as
  the `t` prop. No hard-coded user-facing strings in components.
- Do not redesign the SNCB visual identity unless explicitly asked.
- The train details overlay follows the board's visual system: its
  summary **is** `DepartureRow`, a direct child of the panel with no rule
  of its own beyond `flex:0 0 auto`. It must render 1:1 with the board
  row, not a scaled copy — so the panel fills the backdrop's inset box
  and the row keeps the viewport-based tokens (`--pad-l`, `--gutter`, the
  column tracks, `--row-h`). Never give the row a container-relative
  width, a wrapper that insets it, or overlay chrome inside its grid: the
  close button lives in `.train-details__bar`, above and outside it.
  The panel's own inset comes from `.train-overlay`'s padding, so the
  row's fixed columns keep the board's widths and only the `1fr`
  destination column absorbs it.

## Component rules

- Create a component when it represents a meaningful piece of UI or
  behaviour, not to shorten a file. The four existing components are the
  right granularity.
- Avoid over-componentisation: small local helpers (`Badge`, `Platform`,
  `MainLine`, `SecondLine` in `DepartureRow.jsx`) stay in the file that
  uses them.
- Keep the component tree small and readable; new top-level components
  should be rare.

## CSS rules

- Everything lives in `src/styles.css`. Avoid inline styles for main UI
  styling — the only current exception is the language menu's computed
  `top` / `right`, which is measured at runtime.
- Reuse the tokens in the `:root` block. Do not introduce a new colour,
  shadow or duration that is not derived from an existing token unless
  the design genuinely requires it; add it to `:root` if it does.
- Use `--space-*` for spacing, `--radius-*` for radii, `--transition-*`
  for motion, `--z-*` for stacking, and the existing `--font-size-*` /
  `--font-weight-*` roles for type.
- Board type sizes are fractions of `--row-h` (`--f-time`, `--f-main`,
  `--f-plat`, `--f-badge`). Change the fraction, not the pixel value.
- Desktop board geometry is driven primarily by `--row-h`. The phone row
  instead uses the semantic `--font-size-mobile-*` `em` scale; train and
  platform metadata must share its metadata role. On wider layouts, reuse
  `--font-size-meta` where metadata equality is intended.
- If the title-bar height proportion changes, review the matching usable-height
  assumption in `fitRows()` in `App.jsx` as well.
- Column structure comes from `--grid-compact` and `--grid-platform`.
  Change those tokens (including inside a media query) rather than
  writing a second `grid-template-columns`.
- Do not casually consolidate viewport-relative grid, gutter or board-padding
  values: they preserve separately measured screen geometry.
- Phone railway surfaces share `--phone-edge`; keep the station modal on its
  separate alignment system. Do not replace board viewport/row-relative
  spacing with the generic `--space-*` scale.
- The timeline tooltip's `--tip-space`, top padding and negative margin are a
  coupled clearance formula and must change together.
- Merge identical spacing values only when they represent the same semantic
  role, not merely because their numbers match.
- Class names are semantic and lightly BEM-flavoured:
  `departure-row`, `departure-row__time`, `badge--split`,
  `station-modal`, state classes `is-active` / `is-cancelled` / `is-on`.
  Follow that pattern; never name a class after a colour or a position.
- Keep the file's section order and its `/* === */` banners.
- Board cell rules are two-class (`.layout-compact .departure-row__time`),
  so a phone override written as `.departure-row__time` loses on
  specificity and silently keeps the desktop `--row-h` sizing. Inside the
  phone breakpoint, prefix board-cell overrides with `.layout-compact` /
  `.layout-platform` to match specificity, then rely on the phone block's
  later source order.
- The phone row resets `font-size` on `.departure-row` and sizes its cells
  in `em` of that base, the same way the desktop board derives type from
  `--row-h`. Change the ratio, not a pixel value.
- Reuse the modal design language (`--surface-gradient`,
  `--color-surface-*`, `--radius-*`, `--shadow-*`, `--blur-overlay`) for
  any future overlay. `.train-overlay` shares the picker's backdrop rule
  with `.station-overlay`; keep new overlays on that same rule.
- Keep the railway palette centralized: never duplicate its colours with
  component-local literals. Yellow means priority/attention, not a generic
  warning; cancellation always uses `--color-alert`.
- Delay colour is the alert red everywhere it is read as a delay: in active
  status containers, and in both placements of the Train Details stop detail
  (`--tip-delay`), where only the shade is surface-corrected — `--color-alert`
  on the dark board, the darkened `--color-alert-strong` on the light tooltip.
  Yellow remains attention on dark railway surfaces for everything else.
  Preserve the scoped `--tip-*` theme.
- Platform-change boxes also invert by surface; use the scoped theme variables
  instead of hard-coding one presentation.
- Reuse existing semantic light-surface alpha tokens. Do not collapse nearby
  opacity steps without visual verification, or change the railway palette for
  accessibility without first validating the rendered size and context.
- Every interactive control needs `:hover`, `:focus-visible`, `:active`
  states. Never remove focus outlines.
- Interactive departure rows need concise localized names covering their key
  journey details and status, not destination alone.
- Modal overlays must contain focus, restore it safely on close, and make the
  obscured application content inert.
- Announce user-triggered loading and failure states, but keep background
  polling quiet. Timeline state must be programmatic, not colour-only.
- Keep the document `lang` synchronized with the UI language, and aim for
  approximately 44px mobile hit areas where the measured layout permits it.
- Prefer native semantics; do not add ARIA where native HTML already suffices,
  and never remove a focus outline without an equivalent replacement.

## Responsive rules

- Desktop departure-board fidelity is the primary target; tablet and
  mobile must remain usable, not beautiful.
- Four steps only: desktop (≥1200px), laptop (≤1199px), tablet (≤899px),
  phone (≤599px), plus one short-viewport guard (`max-height: 560px`).
  Do not invent new breakpoints.
- The phone breakpoint is mirrored by `STACKED_QUERY` in `App.jsx`
  (row-count fitting). Change both together.
- The phone renders the same number of departures as the desktop board
  and scrolls; `fitRows()` must not cap the stacked layout to a
  screenful. Fix row density in CSS, never by dropping trains.
- The stacked row is `TIME | CONTENT`: destination, via, train label and
  delay badge all share one left edge. Keep them in the content column.
- Do **not** turn mobile rows into generic app cards. The folded phone
  row keeps the same blue, the same yellow destinations, the same
  separators and the same red badge.
- Layout is CSS's job: grid, flexbox, `clamp()`, relative units, media
  queries. Do not use JavaScript viewport detection for normal layout.
- The route timeline is **horizontal on desktop and tablet**, and turns
  **vertical at the phone breakpoint** — the same markup and the same
  states, re-laid out as `TIME | rail | NAME` rows. Above that
  breakpoint long routes scroll sideways inside `.train-timeline` and
  are never compressed until labels collide; on a phone they scroll
  downward inside it instead. The page itself never scrolls sideways at
  any size.
- Desktop reveals a stop's details on hover (the tooltip is a child of
  the hover target, so moving onto it cannot flicker). The phone
  breakpoint hides that tooltip and opens the tapped stop's details in
  place, under that stop's own name — one active stop at a time.
- Verify at 2560×1440, 1920×1080, 1440×900, 1366×768, 1024×768,
  768×1024, 430×932 and 390×844.

## Data rules

- iRail is the only source of railway data. Never fabricate, mock or
  extrapolate train information in the UI. The single exception is
  `src/services/mockBoard.js`, the visual test fixture: it is reached
  only behind `import.meta.env.DEV` and `?mock=1`, both branches fold
  away at build time, and nothing it returns can reach a shipped bundle.
  Keep it that way — never widen the gate, and never let a component
  import it.
- Handle unavailable fields gracefully: a missing platform renders `–`,
  a train without a `/vehicle` journey (Eurostar, for instance) simply
  shows no stop list.
- Preserve previously loaded valid data when a refresh fails. `App.jsx`
  keeps the last good board in state and surfaces the failure in the
  notice strip; do not clear the board on error.
- The liveboard refresh runs every `CONFIG.refreshMs` (30 s) and only the
  newest refresh may commit board state. A refresh must not trigger a
  full `/vehicle` refetch: it re-evaluates the same candidates against
  the journey cache, so only genuinely new trains cost a request.
- 404 / "no journey available" is **not** authoritative evidence of a
  non-match. `getStops()` reports it as `unavailable`, and the filter
  treats unavailable and failed alike as unknown.
- Requests are aborted and intervals cleared on unmount / dependency
  change. Keep that discipline when adding effects.

## API rules

- All endpoints, query parameters, parsing and caching stay in
  `src/services/irail.js`. Never put an iRail URL in a component.
- Responses are strings all the way down; normalise them in the service
  into the internal shape the board renders, and keep that shape stable.
- Respect the existing caches (`stopsCache`, `stationsByLang`) rather
  than refetching.
- Station identity is the iRail station `id` (`BE.NMBS.008813003`). Take
  it from a `/stations` or `stationinfo` response — never build one from
  a name or a UIC number. The docs are explicit: URIs and ids
  "shouldn't be composed by the user, but should be retrieved from a
  previous response."
- `/liveboard` accepts **either** `station` (a name) **or** `id` (an
  iRail id), never both. `getLiveboard()` picks the right parameter from
  the value it is given; keep that split if you touch it.
- Liveboard fetches accept the polling lifecycle's `AbortSignal`, and only
  the newest refresh may commit board state. Aborts are not user-facing errors.
- `stationinfo.name` is translated by `lang`; `standardname` is not.
  Display `name`, search both, and key state/React lists on `id` so
  station identity never depends on the selected language.
- `delay` is in **seconds**. The board converts to minutes in
  `normalizeDeparture` — do not treat the raw number as minutes.
- `time` is a Unix timestamp in seconds. Format it with
  `timeZone: 'Europe/Brussels'`, never with the machine's local zone.
- Never turn a missing or invalid timestamp into Unix epoch. Departures need a
  valid scheduled time; route stops may keep `null` when no scheduled time exists.
- Valid departure identity remains vehicle id plus scheduled time. Incomplete
  rows need a deterministic, collision-safe fallback identity.
- Cancellation is `canceled` on the departure only. Never infer it from
  a delay, a missing platform or a missing vehicle.
- `vehicleinfo.shortname` is the only documented human-readable train
  label (required in the `/vehicle` schema, alongside `name` and `@id`).
  `type` and `number` are returned by the live API but appear in no
  documented schema — use them only as a fallback, never as contract.
  `vehicleLabel()` parses `shortname` first and must keep working if
  `type` / `number` disappear.
- `/liveboard` returns no intermediate stops. They come from `/vehicle`
  and only from there; a train without a journey simply shows none.
- iRail allows **3 requests/second per IP** (burst 5) and returns 429
  above that. That budget belongs to the whole application, so **every
  actual iRail HTTP request — `/stations`, `/liveboard` and `/vehicle`
  alike — is dispatched by the one scheduler in `irail.js`**, and nothing
  else calls `apiGet` directly. Never add a second limiter: two polite
  limiters still add up to a 429.
- The scheduler keeps at least 400 ms between *dispatches*, not between
  responses, so a slow train lookup cannot stall the board. Do not lower
  that spacing to make a scan finish sooner.
- It has two priorities. **High** is for the small requests that decide
  what is on screen — the initial liveboard, the 30 s refresh, the station
  list. **Normal** is background `/vehicle` route work. A board refresh
  takes the next free slot instead of queueing behind a whole route scan;
  high priority yields a slot after four dispatches in a row so background
  work cannot be starved.
- `/vehicle` jobs are additionally `serial`: one in flight at a time,
  exactly as before. Board requests may overlap them. Do not make journey
  lookups concurrent just because the scheduler exists.
- Request timeouts are measured from dispatch, never from the moment a job
  was queued — otherwise waiting for a slot would be reported as a network
  failure. A timeout is a transient, retryable failure, not an abort.
- A job whose `signal` is already aborted before dispatch is rejected
  without spending a network slot, and an abort is never a user-visible
  board error.
- Cache hits and in-flight promise reuse must never touch the scheduler:
  only a genuine HTTP request consumes a slot.
- One `/vehicle` call serves both consumers. `getJourney()` holds the
  cache; `getStops()` (board "via" list) and `getRoute()` (details
  timeline) are views of that one entry. Opening the details of a listed
  train must cost no extra request.
- Preserve successful and in-flight journey deduplication. Cache genuine
  unavailable journeys gracefully, evict transient failures so they can retry,
  and keep completed journey caches bounded for long-running sessions.
- Cache and request dates for `/vehicle` must come from the same Brussels date.
  A vehicle request must time out so it cannot block the serialized queue;
  timeouts remain transient and retryable. Do not redesign that queue without evidence.
- All `/vehicle` retries still go through the scheduler; never bypass its
  400 ms spacing. A 429 pushes the next slot out once; nothing retries
  automatically, so a failure can never become a retry storm.
- Occupancy is real API data only: `stops.stop[].occupancy.name` on the
  existing `/vehicle` response, normalised to `low` / `medium` / `high`
  or `null`. Never infer passenger load from type, time, route or any
  other signal, and never add a request for it.
- `unknown`, missing and unrecognised occupancy all normalise to `null`,
  and the details overlay then renders no occupancy section at all —
  no label, no placeholder, no reserved space.
- Occupancy is secondary to the route: it stays one compact line below
  the timeline and never grows into a card.

- **Components never call `/vehicle`.** `App.jsx` fetches the route and
  passes it down as a prop. Never open a second, unthrottled request path
  from a UI component.

## Route map rules

- Train route maps are optional and must not replace or redesign the
  Train Details timeline. The timeline stays the primary, accessible
  representation of a journey; the map is a second view of the same
  panel, reached from one secondary action and left with "back to
  details".
- Leaflet/map code and rail graph data must remain lazy-loaded and must
  not burden initial board load. `TrainRouteMap.jsx` is reached only
  through the dynamic `import()` in `TrainDetailsModal.jsx` — keep that
  the single reference, and check `dist/index.html` for a `modulepreload`
  after any change to the boundary.
- Railway geometry comes from preprocessed Infrabel open data; do not
  query Infrabel/Overpass at runtime. The graph is regenerated by hand
  with `node scripts/data/build-rail-network.mjs`, which writes
  `public/generated/belgian-rail-graph.json`. Nothing imports that file:
  it is fetched once per session, after the map is opened.
- The highlighted path follows real railway infrastructure but is
  inferred; never describe it as the exact physical track used by the
  train. The map carries one quiet "approximate route" label, and the
  wording in `TEXT` must keep saying so in all four languages.
- `vehicleinfo` coordinates are not continuous GPS. iRail reports 0,0
  for a vehicle it has no position for, and station coordinates are
  station-granular. Never present either as a live train position.
- Opening the map must not trigger a second `/vehicle` request. The
  journey is already in `App.jsx` state and is passed down as a prop.
- The map supports wheel/trackpad zoom, pinch zoom and drag panning, plus
  Leaflet's zoom control. Do not disable them.
- OpenStreetMap attribution must remain visible. OSM supplies the base
  tiles and nothing else — the route line is Infrabel-derived geometry,
  never anything read off a tile.
- Station matching between iRail and Infrabel is deliberately strict:
  exact normalised name, or a verified entry in
  `src/data/rail/stationAliases.js`, or unresolved. No fuzzy similarity
  and no nearest-station snapping — a journey that cannot be matched end
  to end shows no map rather than a wrong one, and a partly routed
  journey is never bridged with a straight line.
- `normalizeStationName.js` is part of that matching contract: the
  graph's name index is baked with it, so regenerate the graph whenever
  it changes.
- Rail-replacement buses call at railway stations and would otherwise be
  drawn along the line they are replacing. `isRoadService()` keeps them
  off the rails; keep that guard.

## Historical Performance rules

The Performance section in `TrainDetailsModal` is the only historical
thing on the board. Everything else is live iRail.

- It answers exactly one question: **how has this train run at this
  station?** It is historical, never predictive, and never a forecast
  about today's train. Do not add a route analysis, a journey duration,
  a destination prediction, a chart, a sparkline or a trend line.
- **Three metrics, and only three**, all of them the same sample of
  signed `DELAY_ARR` seconds over the same window, so one sample count
  speaks for all of them and is always shown:

  ```text
  Typical Delay           median                     n >= 10
  On-Time Rate            share with delay < 360 s   n >= 10
  90% Arrive Within       p90, rounded up            n >= 20
  ```

  The thresholds count observations **inside the selected window**, and
  reaching ten needs ten *covered* days — which is why the 10-day tier
  requires all ten. A train that did not run every one of those days
  still falls short, and the panel then says "not enough comparable
  journeys" under a real window label. That is correct behaviour, not a
  build failure.

  Do not add Average Delay, a cancellation rate, a reliability score or
  a fourth row.
- **The section always renders**, from the moment the panel opens.
  When there is nothing to say it says which nothing it is, and the five
  states are never run together: `loading` (the shard is in flight),
  `none` (no usable dataset), `collecting` (fresh but no window yet),
  `stale` (the newest day is too old) and `ok` (a window qualified,
  which may still be short of comparable journeys for this train).
- A shard already fetched this session is read synchronously with
  `peekPerformance()` during render, so a second train in the same
  hundred shows its figures in the first frame instead of blinking
  through the loading state. It starts no request and changes no cache.
- **The window adapts.** The build picks the largest trailing window the
  state genuinely covers and names it: 30 days (≥27 covered), else 15
  (≥14), else 10 (all 10). Below that nothing is named and the panel
  says it is collecting, counting the days it holds inside the last ten.
- **Ten days is the floor, and it demands all ten.** A train calls at a
  station about once a day, so an n-day window yields at most n
  observations for it, and ten is exactly what a median or a percentage
  needs. A 7-day window could never reach it, and a 10-day window
  missing one day would top out at nine — both would have shown a
  real-looking window label above no figures. Do not lower this floor or
  add a shorter tier without revisiting MIN_SAMPLES — they are one
  decision seen from either end.
- Every window is measured over the **real trailing calendar days ending
  at the newest service day**, never over "whichever days we happen to
  have". Ten August days and one September day are not "the last 10
  days" — that state has a trailing-10 coverage of one.
- **Figures come only from the selected window's days.** A 30-day median
  relabelled "Last 7 days" would be a different number about a different
  fortnight. The days outside the window are not read at all.
- Selection depends only on which dates exist, which is one fact about
  the whole dataset, so it is decided **once at build time** and the
  aggregate carries one window's figures. Do not publish a variant per
  window: measured, that is 2.8× the payload for no added correctness.
- **Coverage and staleness are different questions and both must pass.**
  `g` says how old the newest included day is; `a` says which days are
  there. A day missing from the dataset is not a day a train did not run
  — a train that did not run contributes no observation and the sample
  count carries that, whereas a missing day removes every train's
  observations at once and reshapes the sample rather than shrinking it.
- The browser re-derives the window from `a` and **refuses any shard
  whose `w` its own dates do not support**. A shard with no `a` is
  unusable — never assume coverage.
- Identity is `(departure.trainNumber, stationPerformanceKey(station))`.
  The iRail train number is Infrabel's `TRAIN_NO`. Never key on
  `RELATION` or `RELATION_DIRECTION`: they describe the relation, not
  the run, and about 15% of train numbers change their label within a
  month.
- Station matching reuses `normalizeStationName()` and
  `STATION_ALIASES`. Do not build a second station-name system. An
  Infrabel stopping point that is not a known iRail passenger station is
  dropped, never guessed at — about 6% of rows are junctions, sidings,
  depots and freight points.
- Negative delays are **kept signed** at every stage. About a third of
  all observations are early; clamping them would bias every median
  upward.
- Only four source columns are retained: `DATDEP`, `TRAIN_NO`,
  `PTCAR_LG_NM_NL`, `DELAY_ARR`. Do not start keeping planned or actual
  datetime fields again — no published metric needs them.
- **The browser never contacts Infrabel**, never parses a CSV and never
  computes a median or a percentile. `src/services/punctuality.js`
  fetches one precomputed shard and picks one cell out of it.
- The shard follows from `departure.trainNumber` alone
  (`Math.floor(number / 100)`). No index request, no manifest lookup
  before the lookup.
- Nothing is fetched for a board row. The shard is requested only when
  Train Details opens, and is memoised for the session.
- Performance is **independent of the route**. It is keyed on the train
  number and the board's station, so it must not wait for `/vehicle`
  and must still render for a train that has no journey. Only the map
  waits for a route.
- Every failure resolves to `null`: a 404, a broken file, an unknown
  train, a station this train does not call at, or an aggregate more
  than seven days stale. Performance must never surface an error in the
  overlay, and must never break the row, the timeline or the map.
- Below `n = 10` the panel names the sample and says the data is
  insufficient. Rows collapse rather than showing a placeholder or a
  dash. Never pad the section back to three rows.
- The `< 6 minutes` threshold is a reporting convention, not something
  the dataset defines, so the UI prints it in words beside the
  percentage. It must stay visible text — never a `title` attribute,
  which is unreachable by keyboard and invisible on touch.
- It is a **disclosure inside the existing panel**, not a third view.
  It adds no layer to the Escape ladder and no second "back" control.
- All wording goes through `TEXT` in `App.jsx` in all four languages,
  like everything else.

## Performance data pipeline rules

- `main` contains **code and workflows only**. The rolling 30-day state
  and the generated shards live on the orphan `data` branch: no shared
  history, never merged, one force-replaced commit. Never commit the
  observations or the daily generated output into `main` — deleting a
  file later does not remove it from history.
- The `data` branch is replaced **only after** the ingest has been
  validated and the aggregate has been recomputed and checked. A failed
  ingest must leave the last good published state exactly as it is.
- Infrabel's D-1 dataset is **overwritten every morning**, so a day not
  collected is lost until the monthly file lands about a month later.
  That is why ingestion runs three times a day and why the run exits
  before downloading anything once the day is already in state.
- Ingest validation is not decoration. Implausible row, train or
  stopping-point counts, or a station match rate below its established
  level, must fail the run and publish nothing.
- The size-drift guard compares like with like: it is skipped when the
  selected window changed, because a window narrowing from 30 days to 7
  is *expected* to shrink the aggregate by most of its size, and
  guarding that would turn a self-healing coverage dip into a failing
  pipeline. It is also skipped when the previous output used a different
  schema.
- The output invariants in `validateOutput()` are checked on every path
  and can never be waived: shard placement, sample counts, figures
  agreeing with their thresholds in *both* directions, no null or
  non-finite value, no unexpected field. The size-drift check is the one
  heuristic, and only an explicit `--backfill` may exceed it — a
  backfill exists to fill a gap, so it may grow the aggregate, but never
  shrink it, and it skips nothing else.
- **Nothing is written until every check has passed.** Writing the
  shards before the drift check would leave a rejected build on disk and
  make it the baseline the next run compares against, so simply
  re-running a rejected build would accept it. The match rate is the
  silent-drift risk: it is the only thing that would let a rename in the
  station column quietly empty the board.
- `state/manifest.json` records which service days are present and which
  are missing. A gap is logged and repaired from the monthly file — it
  is never fabricated, and the website is never responsible for
  recovery.
- A push made with `GITHUB_TOKEN` does not trigger other workflows, so
  the ingest asks for the Pages deploy explicitly. Do not assume the
  push alone republishes the site.
- No PAT. The built-in token pushes within this repository and
  dispatches the deploy; keep the permissions at the minimum the two
  workflows already declare.

## URL rules

- The visible URL carries a readable station slug
  (`?station=gent-sint-pieters`), never a raw iRail id. Only use an id in
  the URL if a future requirement explicitly needs one.
- Slugs are derived from real iRail station metadata — `stationToSlug()`
  slugs `standardname`, which is identical in all four languages, so a
  link does not change meaning with the display language. Both language
  halves of a bilingual name resolve.
- A slug is resolved to a station by looking it up in the `/stations`
  list (`findStationBySlug()`). Never generate, infer or reconstruct an
  iRail id from a slug; canonical `station.id` stays the source of truth
  for every API request.
- `App.jsx` keeps the whole station object in state. Derive the display
  name, the API id and the slug from it — do not add parallel
  `stationId` / `stationName` / `stationSlug` state.
- History is native `history.pushState` plus a `popstate` listener. Do
  not add a router unless the app genuinely grows real routes.
- Update only the `station`, `to`, `train` and `dep` parameters via `URL` /
  `URLSearchParams`; leave every other query parameter untouched.
- `to=` is the direct-train filter's destination, and it is a slug on the
  same terms as `station=`: derived with `stationToSlug()`, resolved with
  `findStationBySlug()`, never an id and never reconstructed into one. An
  unresolvable `to=` is simply no filter, not an invented station.
- An open Train Details view is addressable as `train=<trainNumber>&dep=<scheduled
  Unix seconds>` next to `station` (and `to`, if set). Identity is the
  number **and** the exact scheduled time on the board of the station the
  URL names — never the number alone, never the delayed time. The link is
  one-shot: `pendingLink` is consumed by the first board tagged with that
  station's id, found or not, so a refresh never reopens a closed panel.
  A row click pushes an entry marked `history.state.trainDetails`; closing
  steps back over it, and a directly opened link is closed with
  `replaceState` instead. A departure not on the board opens nothing and
  shows one board-row-high notice above the first train; no request is
  made to look for it.
- Route filtering is direct trains only: a departure qualifies when its
  own `/vehicle` journey, sliced to the stops after this station, calls at
  the destination. Match on canonical station identity (`id`, then
  `standardname`), never on a destination-name substring.
- **The filter's candidates are every departure the current liveboard
  returned**, not a slice of them. How many rows the board can draw is a
  display question and has nothing to do with how many trains have to be
  checked; a count bound on the scan is indistinguishable from a wrong
  answer, so do not reintroduce one. Every lookup goes through
  `getStops()`, which reuses the same paced, de-duplicated journey cache
  the board's "via" list already fills, and each journey is committed as
  it lands so the filtered board fills in progressively.
- Matches are collected in liveboard order, so the order journeys happen
  to resolve in never reaches the screen.
- `getStops()` answers `ok` / `unavailable` / `failed`, and only `ok` is
  evidence. A train iRail has no journey for, or one whose lookup failed,
  is **unknown** — it may well be the direct train the user wants. A
  definitive `noDirect` requires every candidate to have come back `ok`:
  nothing pending and nothing unknown. Otherwise the board says it could
  not confirm (`noDirectUnconfirmed`), or shows the matches it did find
  with a quiet `someUnchecked` footnote. Never collapse unknown into "no".
- "Exhaustive" means exhaustive over the departures iRail's liveboard
  currently returns — roughly the next hour or two — never the whole day's
  timetable. Keep the UI wording free of horizon claims.
- The 30 s refresh re-evaluates the same candidates against the journey
  cache, so only genuinely new trains cost a request. Do not clear the
  journey cache when the filter is applied, changed or cleared: changing
  the destination re-runs the match over stop lists already in hand.
- There is **no count truncation on the route scan** — no `ROUTE_SCAN`
  constant, no "first N departures", no slice. If one is ever
  reintroduced, that is a bug. The visible row limit
  (`LAYOUTS.compact.rowsCap`, about 13) bounds only what is drawn.
- `/vehicle` future stops are the authoritative evidence: intermediate
  stops qualify, stops already passed do not, and a qualifying train may
  continue beyond the destination. `/connections` must never be
  substituted as the filtering source of truth.
- Results are progressive: each journey is committed as it lands, in
  liveboard order. A definitive "no direct departures" requires *every*
  candidate to have a definitive result.

## Kiosk mode rules

- Kiosk is URL-driven: active only when `kiosk=1`, read from the URL on
  start-up and on `popstate`. The `kiosk` state in `App.jsx` only mirrors
  the URL; never let it change without the URL changing too.
- Normal navigation edits `new URL(window.location.href)`, so `kiosk`
  survives station, `to=` and Train Details changes. Keep it that way.
- The canonical Share URL removes `kiosk`: it is a display preference,
  not part of a departure's identity.
- Kiosk never calls the Fullscreen API; the two stay separate actions.
- Escape exits kiosk only when no overlay is open. The cursor timer, its
  listeners, the `kiosk-idle` class and any Wake Lock sentinel are all
  released when kiosk ends or the app unmounts.

## Visual design rules

This application should look like a **railway information display**, not
a generic dashboard or SaaS application.

Avoid, inside the board:

- cards
- excessive rounded containers
- glassmorphism
- decorative gradients
- unnecessary shadows
- striped or alternating rows

The station selector overlay is allowed its own, more modern treatment
(blurred backdrop, soft surface, pill shapes) — it is an interaction
layer over the screen, not part of it. It introduces no new accent
colour: it reuses the board's white and title-bar blue.

The visual system, in short:

- a deep blue board surface with an SNCB-like blue title bar;
- white for the primary line, yellow for the destination and for
  attention on dark railway surfaces, red for delay and cancellation —
  that hierarchy is semantic, never decorative;
- the desktop compact board targets **about 13 visible departures**
  (`LAYOUTS.compact.rowsCap` in `App.jsx`); the phone uses its own
  compact stacked layout and scrolls instead of dropping trains;
- no generic SaaS or card redesign of the board, at any size.

## Persistence

Exactly three values are written to `localStorage`, and nothing else ever
is:

```text
lastStationSlug     the station last chosen from the picker
preferredLanguage   the language last picked from the title bar
favoriteStationSlugs  up to 5 station slugs, in the order they were starred
```

- Station resolution order on startup is **URL -> stored slug ->
  `DEFAULT_STATION`**. The address bar always wins.
- The stored slug is resolved through the same real `/stations` list as
  any other slug. A stored slug that matches nothing is ignored
  silently — the user never typed it.
- The slug remembered at session start is held in a ref, so a `popstate`
  to a history entry naming no station restores *that* station rather
  than whatever has been chosen since.
- The From -> To destination is **not** persisted; only the origin is.
- `favoriteStationSlugs` is a JSON array of canonical slugs, never
  translated names. It is validated on read — array, strings only, no
  duplicates, clamped to 5 — and resolved through `findStationBySlug()`
  like any other slug, so an unresolvable entry is simply not offered.
  A sixth favourite is refused; the five in hand are never replaced.
- Never persist railway data: no board, no journeys, no API cache.
- Every storage access is wrapped in try/catch. Private windows and
  blocked site data must fall back to the defaults without an error.

## Accessibility

- Every interactive control keeps `:hover`, `:focus-visible` and
  `:active` states. Never remove a focus outline without an equivalent
  replacement.
- Modal overlays (`StationModal`, `TrainDetailsModal`, `AboutModal`)
  trap focus, close on Escape, restore focus to a safe control on close,
  and `App.jsx` marks the obscured application content `inert` while any
  of them is open.
- Departure rows, the search field, the suggestion list and the title-bar
  menu are all keyboard-operable; rows carry concise localized names
  covering the journey's key details and status, not the destination
  alone.
- Announce user-triggered loading and failure states; keep the 30 s
  background polling quiet. The route-filter progress line says one
  steady sentence per state rather than a running count.
- Timeline state must be programmatic, not colour-only.
- Honour `prefers-reduced-motion`.
- Keep the document `lang` synchronized with the UI language, and aim for
  roughly 44px mobile hit areas where the measured layout permits.
- Prefer native semantics; do not add ARIA where native HTML suffices.

## Scope discipline

- When the architecture is uncertain, **audit the code first**. Do not
  document or change behaviour from memory.
- Make the smallest targeted fix that resolves the problem.
- No new dependencies without a stated reason.
- No broad refactors unless evidence justifies them.
- Preserve the existing architecture and the visual identity.

## Commands

```bash
npm install
npm run dev       # preflight launcher + Vite dev server
npm run dev:vite  # Vite alone
npm run build     # production bundle in dist/
npm run preview   # serve the production bundle

node scripts/data/build-rail-network.mjs   # regenerate the rail graph

node scripts/data/build-punctuality.mjs --daily           # ingest the published D-1 day
node scripts/data/build-punctuality.mjs --backfill 202608 # seed/repair from a monthly file
node scripts/data/build-punctuality.mjs --aggregate       # rebuild shards from state
```

The rail graph is regenerated by hand, not on install or build. Re-run it
when the Infrabel datasets change or when `normalizeStationName.js` or the
alias table changes, and commit the result.

There is no lint or test script configured. Do not invent one in
documentation; add it to `package.json` first if you add the tooling.

## Validation checklist

Before considering a change complete:

1. `npm run dev` starts and the board renders.
2. Real iRail data loads (departures, delays, platforms).
3. No React warnings or errors in the console.
4. The board still matches the reference layout at desktop sizes, and
   the folded phone layout is intact.
5. The station selector opens, searches, keyboard-navigates and selects.
6. The language menu still switches wording and data.
7. The From -> To filter still evaluates the whole liveboard, fills in
   progressively, and never claims "no direct train" while any candidate
   is pending or unknown.
8. Train Details opens without a second `/vehicle` request, and the map
   is still reached only through the dynamic import (check `dist/` for a
   stray `modulepreload` after touching that boundary).
9. `npm run build` succeeds.
10. No new dependencies were introduced.
11. No new CSS colours, breakpoints or one-off magic numbers outside the
    token system.
12. Performance still degrades to nothing on a 404, a malformed shard, an
    unknown train, an unknown station or a stale aggregate, and Train
    Details keeps working in every one of those cases.
13. The board still fetches no Performance shard; only opening a train
    does, and a second train in the same hundred reuses it.
