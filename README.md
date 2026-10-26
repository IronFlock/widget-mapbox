# @ironflock/widget-mapbox

A Mapbox map widget for IronFlock dashboards: positions as circles, icons, a density heatmap or tracks, with an optional legend and auto-follow. It is a single Lit web component.

## Installation

```bash
npm i @ironflock/widget-mapbox
```

## Usage

The element's tag carries the package version (`widget-mapbox-<version>`), so several versions can coexist on one page. Build the tag from the installed package's version, as the demo does:

```js
import '@ironflock/widget-mapbox/dist/widget-mapbox.js'
import { render } from 'lit'
import { html, unsafeStatic } from 'lit/static-html.js'

const tag = unsafeStatic(`widget-mapbox-${pkg.version}`) // pkg: the package's package.json
render(html`<${tag} .inputData=${data} .theme=${theme} .accessToken=${token}></${tag}>`, container)
```

Give the element a size (it fills its height, which must be definite), and set its properties from JavaScript. `pkg` is the package's `package.json` (e.g. `import pkg from '@ironflock/widget-mapbox/package.json' with { type: 'json' }`, or fetch it as the demo does), and `lit` must be available to your code, as it is to the widget's typings.

- `inputData`: the configuration and data, as described by [`src/definition-schema.json`](src/definition-schema.json)
- `theme`: `{ theme_name, theme_object }` (an ECharts theme). The CSS custom properties `--re-text-color` and `--re-tile-background-color` override it.
- `accessToken`: the Mapbox access token for the page's origin. Without it the widget uses the IronFlock production token, which only works on studio.ironflock.com.

## Development

```bash
npm start          # rollup watch + web-dev-server, opens demo/index.html
npm run build      # dist/widget-mapbox.js
npm run types      # regenerate src/definition-schema.d.ts after editing the schema
just release-patch # release pull request (see CLAUDE.md)
```

The demo loads the built bundle from `dist/`. Map tiles need a token that allows localhost: open `/demo/?token=<token>`.
