# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` - Bundle `src/widget-mapbox.ts` to `dist/widget-mapbox.js` via Rollup (ESM, with sourcemaps; copies `icons/` into `dist/`).
- `npm run watch` - Rollup watch mode (rebuild on change).
- `npm start` - Runs `watch` and `@web/dev-server` concurrently; opens `demo/index.html` (served from repo root, see `web-dev-server.config.mjs`).
- `npm run types` - Regenerate `src/definition-schema.d.ts` from `src/definition-schema.json` (`json2ts`). Run after editing the schema.
- `npm run release` — `npm version patch`: preflight guards (on `main`, clean tree, not behind `origin/main`, generated files current, build passes), then the bump and a `dist/` rebuild (the `version` hook, so the local build registers the new tag), then commit, bare-semver tag, `git push --follow-tags`, then waits on the CI run and fails if the npm publish fails. `npm run release:minor` / `release:major` for other bumps.
- `npm run link` / `npm run unlink` - Link/unlink against a sibling `../RESWARM/frontend` checkout for in-app testing.
- `npm run cors` - Updates GCS CORS for `gs://reswarm-images` (used to host the demo's `ObjectRandomizer.js`).

There is no test runner and no `lint` / `format` script in `package.json` (the README mentions them, but they don't exist). Node `>=24.9.0` is required.

## Architecture

This repo produces a single LitElement web component published as `@ironflock/widget-mapbox`, consumed by the IronFlock/RESWARM dashboard platform.

### Versioned custom element tag

The component is registered as `widget-mapbox-versionplaceholder` in `src/widget-mapbox.ts`. At build time, Rollup's `@rollup/plugin-replace` substitutes `versionplaceholder` with the current `package.json` version everywhere it appears (the `@customElement` decorator argument, the `version` instance field, and CSS bundle ids). The host app picks the tag matching the installed version, so multiple widget versions can coexist on one page. The demo demonstrates this pattern with `unsafeStatic(\`widget-mapbox-${packageJson.version}\`)`.

### Platform contract: `inputData` + `theme`

The widget exposes two reactive `@property({ type: Object })` inputs:

- `inputData` - shape defined by `src/definition-schema.json` (the source of truth); `src/definition-schema.d.ts` is generated from it. The schema is rich (titles, descriptions, `order`, `dataDrivenDisabled`, `enum`, color flags) because the IronFlock dashboard renders configuration UIs directly from it. Update the JSON, then run `npm run types`.
- `theme` - `{ theme_name, theme_object }`. CSS custom properties `--re-text-color` and `--re-tile-background-color` take precedence over `theme_object` values (see `registerTheme`). These are not snapshotted: `registerTheme()` stores a `var(--re-…, <theme value>)` chain, so a change to the host property repaints the tile live without the widget being told.

`update(changedProperties)` re-runs `transformInputData()` and `syncDataLayers()` on every `inputData` change, and re-creates the map only when `inputData.style` changes.

### Data pipeline

`MapConfiguration.dataseries[]` -> `transformInputData()` pivots each series by the `pivot` field of its points, derives a monochromatic palette (`tinycolor`) per pivot bucket, optionally trims to `latestValues`, and emits internal `DataSet`s. `createGEOJson()` turns each `DataSet` into a `FeatureCollection` (Points for `circle`/`symbol`/`heatmap`, a single `LineString` for `line`). `syncDataLayers()` diffs `dataSources` against the live Mapbox map and adds/updates/removes sources and layers via `addCircleLayer` / `addSymbolLayer` / `addHeatmapLayer` / `addTrackLayer`. `fitBounds()` runs after data changes when `inputData.follow` is enabled.

### Mapbox specifics

- `mapboxgl.accessToken` is hardcoded in the constructor.
- `mapbox-gl/dist/mapbox-gl.css` is imported as a string (Rollup `rollup-plugin-string` matches `\.css$`) and injected via `unsafeCSS` inside the component's `static styles`, so styles stay scoped to the shadow root.
- `icons/` (car-front, car-top, marker SVGs) is copied to `dist/icons` by `rollup-plugin-copy` and loaded as map images for the `symbol` layer. Icon color variants are generated at runtime by recoloring SVGs.
- A `ResizeObserver` on the map container debounces `map.resize()` + `fitBounds()` (300ms).

### Build pipeline

Single Rollup config (`rollup.config.js`): `replace` (version) -> `string` (CSS as string) -> `typescript` -> `nodeResolve` -> `commonjs` -> `babel` (bundled helpers) -> `copy` (icons). Output is a single ESM bundle; `package.json` `main` points to `dist/widget-mapbox.js`, `types` to `dist/src/widget-mapbox.d.ts`.

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
