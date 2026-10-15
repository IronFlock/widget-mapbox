# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` - Bundle `src/widget-mapbox.ts` to `dist/widget-mapbox.js` via Rollup (ESM, with sourcemaps; the `icons/` SVGs are inlined into the bundle, and `src/definition-schema.d.ts` is copied next to the emitted typings).
- `npm run watch` - Rollup watch mode (rebuild on change).
- `npm start` - Runs `watch` and `@web/dev-server` concurrently; opens `demo/index.html` (served from repo root, see `web-dev-server.config.mjs`). The demo loads the built `dist/` bundle, and the built-in token only works on studio.ironflock.com: open `/demo/?token=<token>` with a token that allows localhost (e.g. studio's `.env.development` one) to see tiles.
- `npm run types` - Regenerate `src/definition-schema.d.ts` from `src/definition-schema.json` (`json2ts`). Run after editing the schema.
- `npm run release` — `npm version patch`: preflight guards (on `main`, clean tree, not behind `origin/main`, generated files current, build passes), then the bump and a `dist/` rebuild (the `version` hook, so the local build registers the new tag), then commit, bare-semver tag, `git push --follow-tags`, then waits on the CI run and fails if the npm publish fails. `npm run release:minor` / `release:major` for other bumps.
- `npm run link` / `npm run unlink` - Link/unlink against a sibling `../RESWARM/frontend` checkout for in-app testing.
- `npm run cors` - Updates GCS CORS for `gs://reswarm-images` (used to host the demo's `ObjectRandomizer.js`).

There is no test runner and no `lint` / `format` script in `package.json`. Node `>=24.9.0` is required.

## Architecture

This repo produces a single LitElement web component published as `@ironflock/widget-mapbox`, consumed by the IronFlock/RESWARM dashboard platform.

### Versioned custom element tag

The component is registered as `widget-mapbox-versionplaceholder` in `src/widget-mapbox.ts`. At build time, Rollup's `@rollup/plugin-replace` substitutes `versionplaceholder` with the current `package.json` version everywhere it appears (the `@customElement` decorator argument and the `version` instance field). The host app picks the tag matching the installed version, so multiple widget versions can coexist on one page. The demo demonstrates this pattern with `unsafeStatic(\`widget-mapbox-${packageJson.version}\`)`.

### Platform contract: `inputData` + `theme` + `accessToken`

The widget exposes three reactive properties:

- `inputData` - shape defined by `src/definition-schema.json` (the source of truth); `src/definition-schema.d.ts` is generated from it. The schema is rich (titles, descriptions, `order`, `dataDrivenDisabled`, `enum`, color flags) because the IronFlock dashboard renders configuration UIs directly from it. Update the JSON, then run `npm run types`. The widget never mutates `inputData`.
- `theme` - `{ theme_name, theme_object }`. The CSS custom property `--re-text-color` takes precedence over `theme_object` values (see `registerTheme`). These are not snapshotted: `registerTheme()` stores a `var(--re-…, <theme value>)` chain, so a change to the host property repaints the tile live without the widget being told. The widget paints no background of its own: studio's `widget-item` already paints `--re-tile-background-color` on the tile, and painting it again here composited a translucent tile colour twice. Series colors do not come from the theme: the basemap, not the tile background, is what they must stand out against. Series without a color take the ECharts default palette in series order, adjusted for contrast with the basemap.
- `accessToken` - the Mapbox token for the page's origin. Studio's `widget-item.ts` passes `VITE_MAPBOX_TOKEN` (a different token per environment: appliances serve the UI from their own origin). Without it the widget falls back to the hardcoded production token, which Mapbox only accepts on `https://studio.ironflock.com`. A change of token recreates the map.

`willUpdate()` rebuilds the `DataSet`s from `inputData`; `updated()` then does the map work, so a Mapbox error can never stop the legend or header from rendering. A style change calls `map.setStyle(url, { diff: false })`. A diffed update would drop the data layers without firing `style.load`.

### Data pipeline

`transformInputData()` turns `dataseries[]` into one `DataSet` per series and pivot value. The layer config is the one matching the series' `type` (default `{}`); configs of other types are ignored. Rows without a usable position are dropped first: `lon`/`lat` must be finite (numeric strings are accepted), `|lat| <= 90`, and not exactly 0/0 (a GPS receiver without a fix); longitudes are wrapped into -180..180. `value` is optional. `latestValues` then keeps the last N drawable rows per pivot group (the host delivers rows oldest first). A series or pivot value with nothing drawable gets no `DataSet` (no legend entry); with nothing drawable at all the tile shows No Data and the next data is framed afresh. Each `DataSet` carries its GeoJSON (circle radius, heatmap weight/radius and the formatted label are precomputed per feature, so paint expressions are plain `['get', …]` lookups with `coalesce` fallbacks), its Mapbox layer specs, and a `signature` (the specs as JSON). A `line` series gets a `LineString` (only with two distinct positions, its longitudes unwrapped across ±180) plus a `Point` for its newest position: that carries the icon, or a dot when there is no icon and the vehicle has not moved.

`syncDataLayers()` reconciles the style with the `DataSet`s: it removes sources (and their layers) that are gone, `setData`s the rest, and rebuilds a series' layers whenever its signature changes, so color, type and config edits apply live. A source whose series changes type is replaced, so the new layers never see the old features. Sources are keyed by series index and pivot value (`input:<index>:<pivot>`), not by label: a label can be data-driven and change on every update. Layers stack in series order (`firstLayerAfter`). Each pivot value takes a color slot when first seen (`pivotSlots`, rebuilt per update by `slotEntry()`: a series keeps its slots through data gaps, takes them along when it moves to another index (editor reorder or delete, found by label), and keeps them when only its label changed but values seen before are back; another type or color, or a new label with all-new values, starts over, as a fresh mount would): slot 0 is the series color, the next slots come from `pivotColor()`, which walks `PIVOT_COLORS` (Tableau 10 and its light partners) and then golden-angle hues, adjusted for contrast with the basemap (`readableOn`), and accepts a candidate only if it stays clear of the series color and of every color already given out (CIEDE2000 ≥ 20 and ≥ 12, relaxed a step per 60 rejections). `basemapGround()` gives the color they must stand out against (night styles use their land color). A value therefore keeps its color while others come and go.

The camera fits the data once, then on every update with `follow`, and on resize only with `follow` or before the user has moved the map. `projection: 'mercator'` overrides the globe some styles default to.

### Mapbox specifics

- Sources and layers go in on `style.load`, not `load`: `load` waits for basemap tiles and never fires while they fail (e.g. a token not allowed on the origin), which would keep the data off the map too. A style that fails to load (Mapbox unreachable when the tile opens) is retried after 5, 15, 30, then every 60 s.
- Map problems show a notice over the map, with a short form on narrow tiles (container query): "Map unavailable" when the style document itself failed (nothing draws, data included), "Basemap unavailable" when only tiles fail (the data still draws). 401/403 stay. A failed style is retried after 5, 15, 30, then every 60 s, or at once on the window `online` event, and its notice clears when a style loads. A tile notice appears at 3 distinct failed basemap tiles (`failedTiles`, keyed `sourceId/tileKey`; failures without status or with 5xx, never 404, sprites or glyphs) and clears when one of them loads again or none is left (`pruneFailedTiles`, which keeps tiles still errored or being fetched).
- Failed basemap tiles are re-requested in place (`retryBasemapTiles`: each errored tile of a basemap source cache gets `_reloadTile(key, 'expired')` and is then marked 'loading', since 'expired' counts as having data and Mapbox would drop the covering parent tile meanwhile). Never `source.reload()`: it drops every tile, so the basemap blinks, offline it loses the tiles still showing, and its tile loads looked like recovery and re-armed the retry once a second. Retries back off 20/40/60 s, never come sooner than 3.5 s after the last failure (Mapbox's workers hand a failed tile's error back for 3 s), and come early after the window `online` event, when a failed tile loads, or (at most every 10 s) when any basemap tile loads. Source caches are named `other:composite`, `symbol:composite` …: match them by `getSource().id`. `_reloadTile` and `_tiles` are internal to the bundled mapbox-gl, so check them again when upgrading it.
- With `follow`, no refit happens while the user drags or pinches (`gestureActive()`), whether the trigger is a data update, a resize or a notice appearing: the fit would end the gesture and hand the swipe to the browser. The next update fits.
- `mapbox-gl/dist/mapbox-gl.css` and the `icons/*.svg` are imported as strings (Rollup `rollup-plugin-string`). The CSS is injected via `unsafeCSS` inside the component's `static styles`, so styles stay scoped to the shadow root. The icons are decoded once per page through blob URLs and registered per style as SDF images (`widget-mapbox-<name>`), so `icon-color` paints them in the series color.
- `disconnectedCallback` releases the map (and its WebGL context) once the element has really left the DOM; `connectedCallback` re-observes and rebuilds it after a re-attach. A DOM move (disconnect + reconnect in one task) keeps the map.
- Gestures: Mapbox's `scrollZoom` stays disabled; `onWheel` zooms on ctrl/⌘ + wheel or a trackpad pinch (which sends `ctrlKey`) and shows a short hint on a plain wheel, which scrolls the page. Toggling `scrollZoom` per event broke Mapbox's handler state, so don't. On touch, one finger pans the map, unless the page around it can scroll: then, decided per touch (`updateTouchMode`, with the toggle sequence `dragPan.disable()` → `setCooperativeGestures()` → `dragPan.enable()`), Mapbox's cooperative gestures make one finger scroll the page and two move the map. The canvas keeps `touch-action: pan-x pan-y` in both modes, so the switch takes effect on the same touch. The Mapbox logo and attribution are shown, as Mapbox's terms require.

### Build pipeline

Single Rollup config (`rollup.config.js`): `replace` (version) -> `string` (CSS and SVG as strings) -> `typescript` -> `nodeResolve` -> `commonjs` -> `babel` (bundled helpers) -> `copy-schema-types`. Output is a single ESM bundle; `package.json` `main` points to `dist/widget-mapbox.js`, `types` to `dist/src/widget-mapbox.d.ts`. That declaration file imports `./definition-schema.js`, which tsc never emits for a hand-maintained `.d.ts`, so `copy-schema-types` copies `src/definition-schema.d.ts` next to it. The bundle includes `lit`, `mapbox-gl` and `tinycolor2`. `mapbox-gl` and `tinycolor2` are devDependencies; `lit` stays in `dependencies` only because the published typings import it.

### Release flow

`npm run release` bumps the patch version and pushes the tag; the empty tag prefix comes from `tag-version-prefix=""` in `.npmrc`. `.github/workflows/build-publish.yml` triggers on any tag push, runs `npm ci`, `npm run build`, then `npm publish --access public` via npm trusted publishing (OIDC — no `NPM_TOKEN`) and creates a GitHub Release. The bare numeric tag is what the workflow expects.

## `aiSelection` in `src/definition-schema.json`

The schema root carries an `aiSelection` block next to `title` and `description`. It is **not** JSON Schema and describes no config field — it exists so the IronFlock AI's Widget Builder can pick the right widget for a given shape of data, using knowledge only the widget author has:

```jsonc
"aiSelection": {
  "dataShape": "…what columns this widget consumes and what each one means…",
  "useWhen":   ["…a situation, naming the properties that express it…"],
  "notFor":    ["…a situation this widget is wrong for, naming the widget to use instead…"]
}
```

It is inert everywhere else, and must stay that way: `json2ts` ignores it (the generated `.d.ts` is byte-identical with and without it), the dashboard config editor renders only `schema.properties`, and the AI service's `validate_widget` validates *configs* against the schema, skipping unknown Draft-7 keywords.

When maintaining it:

- `notFor` is the high-value half and the part plain descriptions always omit. Every entry must name the widget that *should* be used, or it rejects without routing.
- Write for an LLM with no other documentation: describe the visible result and the user's intent, not the implementation.
- Prefer entries that discriminate against a *neighbouring* widget. Generic rejections are cheap; the ones that pay are those an author could plausibly get wrong.
- The `notFor` lists are a set across all `widget-*` repos and are meant to be reciprocal — if this widget routes to another for some case, that widget should usually route back for the converse. Changing one side is a cue to check the other.
- Update it whenever a property changes what this widget can *do*, not just how it looks.
