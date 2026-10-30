import { html, css, LitElement, unsafeCSS, PropertyValues, TemplateResult } from 'lit'
import { customElement, property, query, state } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import mapboxgl from 'mapbox-gl'
import type { GeoJSONSource, LayerSpecification, LngLatBoundsLike, Map as MapboxMap } from 'mapbox-gl'
// @ts-ignore - virtual import returns a string at build time
import mapboxCSS from 'mapbox-gl/dist/mapbox-gl.css'
// @ts-ignore - virtual import returns a string at build time
import carFrontSVG from '../icons/car-front.svg'
// @ts-ignore - virtual import returns a string at build time
import carTopSVG from '../icons/car-top.svg'
// @ts-ignore - virtual import returns a string at build time
import markerSVG from '../icons/marker.svg'
import type * as GeoJSON from 'geojson'
import tinycolor from 'tinycolor2'
import { MapConfiguration } from './definition-schema.js'

type Theme = {
    theme_name: string
    theme_object: any
}

type LayerType = 'circle' | 'symbol' | 'heatmap' | 'line'
type Row = { lon?: unknown; lat?: unknown; value?: unknown; pivot?: unknown }
type ValueRange = { count: number; min: number; max: number }

/** One map source: a series, or one pivot value of a series. */
type DataSet = {
    sourceId: string
    label: string
    type: LayerType
    color: string
    data: GeoJSON.FeatureCollection
    layers: LayerSpecification[]
    /** The layer specs as JSON: when it changes, the layers are rebuilt. */
    signature: string
}

/** A series' pivot color slots, with what identifies the series across updates. */
type SlotEntry = { owner: string; label: string; slots: Map<string, number> }

/** What syncDataLayers put on the current style for one source. */
type AppliedLayers = {
    type: LayerType
    signature: string
    layerIds: string[]
    /** false when Mapbox rejected a layer: not retried until the signature changes */
    complete: boolean
}

// Fallback only: the IronFlock UI passes the token for its environment through `accessToken`.
// This production token is URL-restricted to studio.ironflock.com.
const DEFAULT_ACCESS_TOKEN =
    // nosemgrep: generic.secrets.security.detected-jwt-token.detected-jwt-token -- a public Mapbox token (pk.), sent to every browser
    'pk.eyJ1IjoibWFya29wZSIsImEiOiJjbXB2Yjh2ankwMWUxMnNyM243aGFlNGxiIn0.BXax9rCajgo3Sn5MvAu7dQ'
const DEFAULT_STYLE = 'light-v11'
const LAYER_TYPES: LayerType[] = ['circle', 'symbol', 'heatmap', 'line']

// ECharts' default palette: the colors of series that do not set one, in series order.
const DEFAULT_COLORS = [
    '#5470c6',
    '#91cc75',
    '#fac858',
    '#ee6666',
    '#73c0de',
    '#3ba272',
    '#fc8452',
    '#9a60b4',
    '#ea7ccc'
]

// Colors for the pivot values after the first, which takes the series color: Tableau 10, then its
// lighter partners from Tableau 20 (greys left out, they vanish into the basemap).
const PIVOT_COLORS = [
    '#4e79a7',
    '#f28e2b',
    '#e15759',
    '#76b7b2',
    '#59a14f',
    '#edc948',
    '#b07aa1',
    '#ff9da7',
    '#9c755f',
    '#a0cbe8',
    '#ffbe7d',
    '#ff9d9a',
    '#86bcb6',
    '#8cd17d',
    '#f1ce63',
    '#d4a6c8',
    '#fabfd2',
    '#d7b5a6'
]

const HEATMAP_COLOR = [
    'interpolate',
    ['linear'],
    ['heatmap-density'],
    0,
    'rgba(0, 0, 255, 0)',
    0.1,
    'royalblue',
    0.3,
    'cyan',
    0.5,
    'lime',
    0.7,
    'yellow',
    1,
    'tomato'
]
const HEATMAP_LEGEND = 'linear-gradient(90deg, royalblue, cyan, lime, yellow, tomato)'

// Circle radius in px, area-proportional to the value within its series.
const MIN_RADIUS = 4
const MAX_RADIUS = 24
const DEFAULT_RADIUS = 8
const DEFAULT_HEATMAP_RADIUS = 30

// The icons ship inside the bundle. They are rasterised once at 48 px and registered with
// pixelRatio 2, so icon-size 1 draws them at 24 px. As SDF images they take the layer color.
const ICONS: Record<string, string> = { 'car-front': carFrontSVG, 'car-top': carTopSVG, marker: markerSVG }
// The pin's tip is its bottom edge; the cars sit centred on their position.
const ICON_ANCHORS: Record<string, 'bottom' | 'center'> = {
    'car-front': 'center',
    'car-top': 'center',
    marker: 'bottom'
}
const DEFAULT_ICON = 'car-front'
const ICON_PREFIX = 'widget-mapbox-'
const ICON_RASTER_SIZE = 48
const ICON_PIXEL_RATIO = 2

// "Basemap" when only tiles fail and the data still draws; "Map" when the style itself failed, which
// keeps the data off the map too.
// Each with a short form for narrow maps.
type Notice = { long: string; short: string }
const NOTICE_TEXT: Record<'401' | '403' | 'network' | 'style401' | 'style403' | 'styleNetwork', Notice> = {
    401: { long: 'Basemap unavailable: Mapbox rejected the access token', short: 'Basemap: token rejected' },
    403: {
        long: 'Basemap unavailable: the access token is not allowed on this site',
        short: 'Basemap: token not allowed here'
    },
    network: { long: 'Basemap unavailable: Mapbox cannot be reached', short: 'Basemap offline' },
    style401: { long: 'Map unavailable: Mapbox rejected the access token', short: 'Map: token rejected' },
    style403: {
        long: 'Map unavailable: the access token is not allowed on this site',
        short: 'Map: token not allowed here'
    },
    styleNetwork: {
        long: 'Map unavailable: Mapbox cannot be reached. Retrying…',
        short: 'Map offline, retrying…'
    }
}
// Retry delays for a style that failed to load (e.g. the network was down when the tile opened).
const STYLE_RETRY_SECONDS = [5, 15, 30, 60]
// Retry delays for basemap tiles that failed while the style was up.
const TILE_RETRY_SECONDS = [20, 40, 60]

let iconImages: Promise<Map<string, HTMLImageElement>> | undefined

function loadIcons(): Promise<Map<string, HTMLImageElement>> {
    iconImages ??= Promise.all(
        Object.entries(ICONS).map(
            ([name, svg]) =>
                new Promise<[string, HTMLImageElement] | undefined>((resolve) => {
                    const img = new Image(ICON_RASTER_SIZE, ICON_RASTER_SIZE)
                    img.onload = () => resolve([ICON_PREFIX + name, img])
                    img.onerror = () => {
                        console.error(`[widget-mapbox] Could not decode the ${name} icon`)
                        resolve(undefined)
                    }
                    // A blob: URL is same-origin, so the canvas Mapbox draws the icon on stays readable.
                    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
                })
        )
    ).then((entries) => new Map(entries.filter((e): e is [string, HTMLImageElement] => !!e)))
    return iconImages
}

function iconName(name: unknown): string {
    return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ICONS, name) ? name : DEFAULT_ICON
}

/** The last path segment of a style, e.g. 'dark-v11' for 'mapbox://styles/mapbox/dark-v11'. */
function styleId(style: string): string {
    return style.split('/').pop() ?? style
}

function isDarkStyle(style: string): boolean {
    return /dark|night|satellite/.test(styleId(style))
}

/** A finite number, also from a numeric string. null, '', booleans and NaN are not numbers here. */
function toNumber(v: unknown): number | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v)
        return Number.isFinite(n) ? n : undefined
    }
    return undefined
}

function positive(v: unknown): number | undefined {
    const n = toNumber(v)
    return n !== undefined && n > 0 ? n : undefined
}

function inRange(v: unknown, min: number, max: number): number | undefined {
    const n = toNumber(v)
    return n !== undefined && n >= min && n <= max ? n : undefined
}

/** A color Mapbox can parse (rgb/rgba), or undefined for '', unknown names and non-strings. */
function validColor(c: unknown): string | undefined {
    if (typeof c !== 'string' || !c.trim()) return undefined
    const color = tinycolor(c)
    return color.isValid() ? color.toRgbString() : undefined
}

/** What generated colors must stand out against: the land color of the basemap, roughly. */
function basemapGround(style: string): string {
    const id = styleId(style)
    return /night/.test(id) ? '#424d5c' : /dark|satellite/.test(id) ? '#292929' : '#f7f7f7'
}

/** Darkens (on light basemaps) or lightens (on dark ones) a generated color until it stands out. */
function readableOn(color: string, ground: string): string {
    const dark = tinycolor(ground).isDark()
    let c = tinycolor(color)
    for (let i = 0; i < 12 && tinycolor.readability(c, ground) < 2; i++) c = dark ? c.lighten(5) : c.darken(5)
    return c.toRgbString()
}

/** CIE L*a*b* of a color. */
function lab(color: string): [number, number, number] {
    const { r, g, b } = tinycolor(color).toRgb()
    const linear = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    const [R, G, B] = [linear(r), linear(g), linear(b)]
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
    const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047)
    const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722)
    const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883)
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** How different two colors look (CIEDE2000; about 2 is just noticeable, above 10 clearly different). */
function colorDistance(c1: string, c2: string): number {
    const [L1, a1, b1] = lab(c1)
    const [L2, a2, b2] = lab(c2)
    const rad = Math.PI / 180
    const Cbar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
    const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)))
    const a1p = (1 + G) * a1
    const a2p = (1 + G) * a2
    const C1p = Math.hypot(a1p, b1)
    const C2p = Math.hypot(a2p, b2)
    const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360)
    const h1p = hue(b1, a1p)
    const h2p = hue(b2, a2p)
    let dhp = 0
    if (C1p * C2p !== 0) {
        dhp = h2p - h1p
        if (dhp > 180) dhp -= 360
        else if (dhp < -180) dhp += 360
    }
    const dLp = L2 - L1
    const dCp = C2p - C1p
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad)
    const Lbp = (L1 + L2) / 2
    const Cbp = (C1p + C2p) / 2
    let hbp = h1p + h2p
    if (C1p * C2p !== 0) {
        if (Math.abs(h1p - h2p) > 180) hbp += hbp < 360 ? 360 : -360
        hbp /= 2
    }
    const T =
        1 -
        0.17 * Math.cos((hbp - 30) * rad) +
        0.24 * Math.cos(2 * hbp * rad) +
        0.32 * Math.cos((3 * hbp + 6) * rad) -
        0.2 * Math.cos((4 * hbp - 63) * rad)
    const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2))
    const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
    const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2)
    const Sc = 1 + 0.045 * Cbp
    const Sh = 1 + 0.015 * Cbp * T
    const Rt = -Math.sin(2 * dTheta * rad) * Rc
    return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh))
}

/** Candidate k for pivot colors: PIVOT_COLORS, then golden-angle hues around the base, made readable. */
function pivotCandidate(base: string, k: number, ground: string): string {
    if (k < PIVOT_COLORS.length) return readableOn(PIVOT_COLORS[k], ground)
    const { h, s, a } = tinycolor(base).toHsl()
    const n = k - PIVOT_COLORS.length + 1
    const hue = tinycolor({ h: (h + n * 137.508) % 360, s: Math.max(s, 0.6), l: [0.42, 0.62, 0.5][n % 3], a })
    return readableOn(hue.toRgbString(), ground)
}

/** Per series color and basemap: the pivot colors handed out so far. */
const pivotPalettes = new Map<string, { colors: string[]; next: number; rejected: number }>()

/**
 * The color of pivot slot n. Slot 0 is the series color. The other slots take candidates (after
 * readableOn, which can pull similar ones together) that stay clear of the series color and of every
 * color already given out; the spacing relaxes a step per 60 rejections, so any number of values works.
 */
function pivotColor(base: string, slot: number, ground: string): string {
    if (slot === 0) return base
    const key = `${base}|${ground}`
    let palette = pivotPalettes.get(key)
    if (!palette) pivotPalettes.set(key, (palette = { colors: [], next: 0, rejected: 0 }))
    while (palette.colors.length < slot) {
        const candidate = pivotCandidate(base, palette.next++, ground)
        const relax = Math.floor(palette.rejected / 60)
        if (
            colorDistance(candidate, base) >= 20 - relax &&
            palette.colors.every((c) => colorDistance(candidate, c) >= 12 - relax)
        ) {
            palette.colors.push(candidate)
        } else {
            palette.rejected++
        }
    }
    return palette.colors[slot - 1]
}

function wrapLongitude(lon: number): number {
    return ((((lon + 180) % 360) + 360) % 360) - 180
}

/** [lon, lat] of a row (lon wrapped into -180..180), or undefined without a usable fix. */
function position(row: Row): [number, number] | undefined {
    const lon = toNumber(row.lon)
    const lat = toNumber(row.lat)
    if (lon === undefined || lat === undefined || lat < -90 || lat > 90) return undefined
    // GPS receivers without a fix commonly report 0/0 ("Null Island").
    if (lon === 0 && lat === 0) return undefined
    return [wrapLongitude(lon), lat]
}

function valueRange(values: number[]): ValueRange {
    let min = Infinity
    let max = -Infinity
    for (const v of values) {
        if (v < min) min = v
        if (v > max) max = v
    }
    return { count: values.length, min, max }
}

/** Position of a value in the series' range, 0..1; 0 when there is no spread to measure. */
function normalized(value: number | undefined, range: ValueRange): number {
    if (value === undefined || !(range.max > range.min)) return 0
    return (value - range.min) / (range.max - range.min)
}

function circleRadius(value: number | undefined, range: ValueRange): number {
    if (value === undefined) return range.count ? MIN_RADIUS : DEFAULT_RADIUS
    // Non-negative data scales from zero; data with negative values scales over its range, so
    // -10 and +10 do not look alike.
    const t =
        range.min < 0
            ? range.max > range.min
                ? normalized(value, range)
                : 1
            : range.max > 0
              ? value / range.max
              : 0
    return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * Math.sqrt(t)
}

const valueFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
const smallValueFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 })
const tinyValueFormat = new Intl.NumberFormat(undefined, {
    notation: 'scientific',
    maximumSignificantDigits: 2
})

function formatValue(value: number | undefined): string {
    if (value === undefined) return ''
    const magnitude = Math.abs(value)
    if (magnitude < 1e-12) return valueFormat.format(0) // floating-point residue such as 0.1 + 0.2 - 0.3
    // Small readings keep their significant digits instead of showing 0: 0.0012, then 1.5E-7.
    if (magnitude < 1e-4) return tinyValueFormat.format(value)
    if (magnitude < 0.005) return smallValueFormat.format(value)
    const rounded = Math.round(value * 100) / 100
    return valueFormat.format(rounded === 0 ? 0 : rounded) // no "-0"
}

/** Bounds of every drawn position; a set straddling the antimeridian gets east > 180. */
function dataBounds(dataSets: DataSet[]): [[number, number], [number, number]] | undefined {
    const lons: number[] = []
    let south = 90
    let north = -90
    const add = ([lon, lat]: GeoJSON.Position) => {
        lons.push(wrapLongitude(lon))
        if (lat < south) south = lat
        if (lat > north) north = lat
    }
    for (const ds of dataSets) {
        for (const f of ds.data.features) {
            if (f.geometry.type === 'Point') add(f.geometry.coordinates)
            else if (f.geometry.type === 'LineString') f.geometry.coordinates.forEach(add)
        }
    }
    if (!lons.length) return undefined
    let west = Infinity
    let east = -Infinity
    let shiftedWest = Infinity
    let shiftedEast = -Infinity
    for (const lon of lons) {
        west = Math.min(west, lon)
        east = Math.max(east, lon)
        const shifted = lon < 0 ? lon + 360 : lon
        shiftedWest = Math.min(shiftedWest, shifted)
        shiftedEast = Math.max(shiftedEast, shifted)
    }
    if (shiftedEast - shiftedWest < east - west) {
        west = shiftedWest
        east = shiftedEast
    }
    return [
        [west, south],
        [east, north]
    ]
}

function textHalo(textColor: string): Record<string, unknown> {
    return {
        'text-halo-color': tinycolor(textColor).isDark() ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.6)',
        'text-halo-width': 1
    }
}

// Features are built with these properties; coalesce keeps a layer quiet if it briefly sees a
// feature built for another layer type.
const RADIUS = ['coalesce', ['get', 'radius'], DEFAULT_RADIUS]
const LABEL = ['coalesce', ['get', 'label'], '']

function circleLayers(id: string, color: string, config: Record<string, unknown>): LayerSpecification[] {
    const layers: any[] = [
        {
            id: `${id}:circle`,
            type: 'circle',
            source: id,
            paint: {
                'circle-color': color,
                'circle-radius': RADIUS,
                'circle-opacity': inRange(config['circle-opacity'], 0, 1) ?? 1,
                'circle-blur': inRange(config['circle-blur'], 0, 1) ?? 0
            }
        }
    ]
    const textSize = positive(config['text-size'])
    if (textSize) {
        const textColor = validColor(config['text-color']) ?? '#000'
        layers.push({
            id: `${id}:label`,
            type: 'symbol',
            source: id,
            layout: { 'text-field': LABEL, 'text-size': textSize, 'text-anchor': 'center' },
            paint: { 'text-color': textColor, ...textHalo(textColor) }
        })
    }
    return layers
}

function iconLayout(config: Record<string, unknown>): Record<string, unknown> {
    const name = iconName(config['icon-image'])
    return {
        'icon-image': ICON_PREFIX + name,
        'icon-size': positive(config['icon-size']) ?? 1,
        'icon-anchor': ICON_ANCHORS[name],
        // Every vehicle stays visible, and basemap labels give way to it.
        'icon-allow-overlap': true
    }
}

function symbolLayers(id: string, color: string, config: Record<string, unknown>): LayerSpecification[] {
    const icon = iconLayout(config)
    const iconSize = icon['icon-size'] as number
    const textSize = positive(config['text-size']) ?? 14
    const textColor = validColor(config['text-color']) ?? '#000'
    // The label goes below the position: below a centred icon, or just below a pin's tip.
    const gap = icon['icon-anchor'] === 'bottom' ? 2 : 12 * iconSize + 2
    return [
        {
            id: `${id}:symbol`,
            type: 'symbol',
            source: id,
            layout: {
                ...icon,
                'text-field': LABEL,
                'text-size': textSize,
                'text-anchor': 'top',
                'text-offset': [0, gap / textSize],
                'text-optional': true
            },
            paint: { 'icon-color': color, 'text-color': textColor, ...textHalo(textColor) }
        } as any
    ]
}

function heatmapLayers(id: string, config: Record<string, unknown>): LayerSpecification[] {
    const paint: Record<string, unknown> = {
        'heatmap-color': HEATMAP_COLOR,
        'heatmap-weight': ['coalesce', ['get', 'weight'], 1],
        'heatmap-radius': ['coalesce', ['get', 'radius'], DEFAULT_HEATMAP_RADIUS]
    }
    const intensity = toNumber(config['heatmap-intensity'])
    if (intensity !== undefined && intensity >= 0) paint['heatmap-intensity'] = intensity
    const opacity = inRange(config['heatmap-opacity'], 0, 1)
    if (opacity !== undefined) paint['heatmap-opacity'] = opacity
    return [{ id: `${id}:heatmap`, type: 'heatmap', source: id, paint } as any]
}

function lineLayers(id: string, color: string, config: Record<string, unknown>): LayerSpecification[] {
    const lineWidth = positive(config['line-width']) ?? 2
    const layers: any[] = [
        {
            id: `${id}:line`,
            type: 'line',
            source: id,
            filter: ['==', ['geometry-type'], 'LineString'],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-width': lineWidth, 'line-color': color }
        }
    ]
    if (typeof config['icon-image'] === 'string' && config['icon-image']) {
        // The icon marks the newest position, a Point feature of its own, so it also shows while
        // the vehicle is parked (a track of zero length is never drawn).
        layers.push({
            id: `${id}:icon`,
            type: 'symbol',
            source: id,
            filter: ['==', ['geometry-type'], 'Point'],
            layout: iconLayout(config),
            paint: { 'icon-color': color }
        })
    } else {
        // Without an icon, a vehicle that has not moved would show nothing at all: mark it with a dot.
        layers.push({
            id: `${id}:dot`,
            type: 'circle',
            source: id,
            filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'alone'], true]],
            paint: { 'circle-color': color, 'circle-radius': Math.max(3, lineWidth * 1.5) }
        })
    }
    return layers
}

@customElement('widget-mapbox-versionplaceholder')
export class WidgetMapbox extends LitElement {
    @property({ type: Object }) inputData?: MapConfiguration
    @property({ type: Object }) theme?: Theme
    /** Mapbox access token for the host's origin. The IronFlock UI passes the one for its environment. */
    @property({ type: String }) accessToken?: string

    @state() private dataSets: DataSet[] = []
    @state() private themeTitleColor?: string
    @state() private themeSubtitleColor?: string
    /** Shown instead of the map when it cannot be created at all. */
    @state() private mapError?: string
    /** Shown over the map while the basemap cannot be loaded. */
    @state() private mapNotice?: Notice
    /** Briefly shown when a plain wheel scrolls over the map. */
    @state() private gestureHint?: string

    @query('#map') private mapElement?: HTMLDivElement

    public version: string = 'versionplaceholder'
    private map?: MapboxMap
    private mapStyle?: string
    private mapToken?: string
    private styleReady: boolean = false
    private styleGeneration: number = 0
    private styleRetries: number = 0
    /** Sources this widget added to the current style, with the layers built for them. */
    private appliedLayers = new Map<string, AppliedLayers>()
    /** Per series position, the color slot of every pivot value seen, so a value keeps its color. */
    private pivotSlots = new Map<number, SlotEntry>()
    private hasFitted: boolean = false
    private userMoved: boolean = false
    private fitting: boolean = false
    private cooperative: boolean = false
    private noticeKind?: 'auth' | 'network'
    /** Basemap tiles (`sourceId/tileKey`) that failed and have not loaded since. */
    private failedTiles = new Set<string>()
    private lastTileFailure: number = 0
    private lastTileRetry: number = 0
    private tileRetries: number = 0
    private tileRetryDue: number = 0
    private warnedSecretToken: boolean = false
    private fitTimer?: ReturnType<typeof setTimeout>
    private destroyTimer?: ReturnType<typeof setTimeout>
    private styleRetryTimer?: ReturnType<typeof setTimeout>
    private tileRetryTimer?: ReturnType<typeof setTimeout>
    private hintTimer?: ReturnType<typeof setTimeout>
    private loggedErrors = new Set<string>()
    private resizeObserver = new ResizeObserver(() => this.onResize())
    private onOnline = () => {
        // A style that failed to load is retried now rather than at its backoff (up to 60 s).
        if (this.map && !this.styleReady && this.mapNotice === NOTICE_TEXT.styleNetwork) this.reloadStyle()
        if (this.failedTiles.size) this.scheduleTileRetry(0)
    }

    connectedCallback() {
        super.connectedCallback()
        clearTimeout(this.destroyTimer)
        window.addEventListener('online', this.onOnline)
        // Back after a DOM move or a re-attach: observe again, and rebuild the map if it was released.
        if (this.hasUpdated) {
            if (this.mapElement) this.resizeObserver.observe(this.mapElement)
            if (!this.map) {
                this.createMap()
                this.autoFit()
            }
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback()
        window.removeEventListener('online', this.onOnline)
        this.resizeObserver.disconnect()
        clearTimeout(this.fitTimer)
        // Release the map and its WebGL context once the element has really left the DOM. A move
        // reconnects it within the same task, which cancels this.
        clearTimeout(this.destroyTimer)
        this.destroyTimer = setTimeout(() => {
            if (!this.isConnected) this.destroyMap()
        })
    }

    protected willUpdate(changedProperties: PropertyValues<this>) {
        if (changedProperties.has('theme') || !this.hasUpdated) this.registerTheme(this.theme)
        if (changedProperties.has('inputData')) {
            this.dataSets = this.transformInputData()
            // Nothing to show: whatever comes next is framed like the first data.
            if (!this.dataSets.length) {
                this.hasFitted = false
                this.userMoved = false
            }
        }
    }

    protected firstUpdated() {
        const element = this.mapElement
        if (element) {
            this.resizeObserver.observe(element)
            element.addEventListener('wheel', (event) => this.onWheel(event), {
                capture: true,
                passive: false
            })
            element.addEventListener('touchstart', () => this.updateTouchMode(), {
                capture: true,
                passive: true
            })
        }
        this.createMap()
    }

    protected updated(changedProperties: PropertyValues<this>) {
        // Map work runs after render, so a map error can never hold back the legend or header.
        if (!this.map) {
            // A map that could not be created gets another try with a different token.
            if (this.mapError && this.effectiveToken() !== this.mapToken) this.createMap()
            return
        }
        if (this.effectiveToken() !== this.mapToken) {
            this.createMap()
            this.autoFit()
            return
        }
        if (this.effectiveStyle() !== this.mapStyle) {
            this.setMapStyle()
            return
        }
        if (changedProperties.has('inputData')) {
            this.syncDataLayers()
            this.autoFit()
        }
    }

    registerTheme(theme?: Theme) {
        this.themeTitleColor = `var(--re-text-color, ${theme?.theme_object?.title?.textStyle?.color || 'inherit'})`
        this.themeSubtitleColor = `var(--re-text-color, ${theme?.theme_object?.title?.subtextStyle?.color || theme?.theme_object?.title?.textStyle?.color || 'inherit'})`
    }

    private effectiveToken(): string {
        const token = this.accessToken
        if (!token) return DEFAULT_ACCESS_TOKEN
        if (token.startsWith('sk.')) {
            // Mapbox refuses secret tokens in the browser, and would throw from the Map constructor.
            if (!this.warnedSecretToken) {
                this.warnedSecretToken = true
                console.warn('[widget-mapbox] Ignoring a secret (sk.) access token; maps need a public one.')
            }
            return DEFAULT_ACCESS_TOKEN
        }
        return token
    }

    private effectiveStyle(): string {
        const style = this.inputData?.style
        return typeof style === 'string' && style ? style : DEFAULT_STYLE
    }

    private styleUrl(style: string): string {
        return style.includes('://') ? style : `mapbox://styles/mapbox/${style}`
    }

    /**
     * The slot entry for the series at `index`: its own from the last update; that of the same series
     * if it moved here from another position (a reorder or delete in the editor); its own again if
     * the label changed in place but values seen before are back (a data-driven label); otherwise a
     * fresh one, as a new mount would give. `owner` is the series' type and color: a different one is
     * another series.
     */
    private slotEntry(
        index: number,
        owner: string,
        label: string,
        previous: Map<number, SlotEntry>,
        labels: string[],
        keys: string[],
        taken: Set<SlotEntry>
    ): SlotEntry {
        const usable = (e?: SlotEntry): e is SlotEntry => !!e && !taken.has(e) && e.owner === owner
        const own = previous.get(index)
        if (usable(own) && own.label === label) return own
        if (label) {
            for (const [j, e] of previous) {
                if (j !== index && usable(e) && e.label === label && labels[j] !== label) return e
            }
        }
        if (usable(own) && (!keys.length || keys.some((key) => own.slots.has(key)))) return own
        return { owner, label, slots: new Map() }
    }

    /** Colors per pivot value: a value keeps the slot it got when first seen, through data gaps. */
    private pivotColors(entry: SlotEntry, base: string, keys: string[], ground: string): string[] {
        const { slots } = entry
        // A series that never had pivot values shows its color; '' otherwise takes a slot like any value.
        if (keys.length === 1 && keys[0] === '' && slots.size === 0) return [base]
        for (const key of keys) if (!slots.has(key)) slots.set(key, slots.size)
        return keys.map((key) => pivotColor(base, slots.get(key)!, ground))
    }

    /** Builds one DataSet per series and pivot value. Pure with respect to inputData: nothing is mutated. */
    private transformInputData(): DataSet[] {
        const series = this.inputData?.dataseries
        if (!Array.isArray(series)) return []
        const ground = basemapGround(this.effectiveStyle())
        const dataSets: DataSet[] = []
        const labelOf = (ds: any) => (ds?.label === undefined || ds?.label === null ? '' : String(ds.label))
        const labels = series.map(labelOf)
        const previousSlots = this.pivotSlots
        const takenSlots = new Set<SlotEntry>()
        this.pivotSlots = new Map()

        series.forEach((ds, index) => {
            if (!ds || typeof ds !== 'object') return
            const type = LAYER_TYPES.includes(ds.type as LayerType) ? (ds.type as LayerType) : 'circle'
            // The config of the series' own type; a leftover config of another type is ignored.
            const config = ((
                {
                    circle: ds.circleConfig,
                    symbol: ds.symbolConfig,
                    heatmap: ds.heatmapConfig,
                    line: ds.lineConfig
                } as Record<LayerType, unknown>
            )[type] ?? {}) as Record<string, unknown>
            const label = labels[index]
            const baseColor =
                validColor(ds.color) ?? readableOn(DEFAULT_COLORS[index % DEFAULT_COLORS.length], ground)
            const latest = Math.floor(positive(ds.latestValues) ?? 0)

            // Rows without a usable position are skipped first, so latestValues counts drawable rows.
            // Grouping by pivot value keeps each group's order (the host delivers oldest first).
            const groups = new Map<string, { row: Row; position: [number, number] }[]>()
            for (const row of Array.isArray(ds.data) ? (ds.data as Row[]) : []) {
                if (!row || typeof row !== 'object') continue
                const p = position(row)
                if (!p) continue
                const key = row.pivot === undefined || row.pivot === null ? '' : String(row.pivot)
                let rows = groups.get(key)
                if (!rows) groups.set(key, (rows = []))
                rows.push({ row, position: p })
            }
            const keys = [...groups.keys()].sort()
            const shown = keys.map((key) => {
                const rows = groups.get(key)!
                return latest ? rows.slice(-latest) : rows
            })

            const values: number[] = []
            for (const rows of shown) {
                for (const { row } of rows) {
                    const v = toNumber(row.value)
                    if (v !== undefined) values.push(v)
                }
            }
            const range = valueRange(values)
            const owner = JSON.stringify([type, typeof ds.color === 'string' ? ds.color : null])
            const slotEntry = this.slotEntry(index, owner, label, previousSlots, labels, keys, takenSlots)
            slotEntry.label = label
            takenSlots.add(slotEntry)
            this.pivotSlots.set(index, slotEntry)
            const colors = this.pivotColors(slotEntry, baseColor, keys, ground)
            const heatmapRadius = positive(config['heatmap-radius']) ?? DEFAULT_HEATMAP_RADIUS

            keys.forEach((key, i) => {
                // Identity is the series' position: a label may be data-driven and change on every update.
                const sourceId = `input:${index}:${key}`
                const color = colors[i]
                const features: GeoJSON.Feature[] = []

                if (type === 'line') {
                    // Keep the track continuous across the antimeridian (179 → 181 rather than → -179).
                    const coordinates: [number, number][] = []
                    for (const {
                        position: [lon, lat]
                    } of shown[i]) {
                        const previous = coordinates[coordinates.length - 1]
                        let unwrapped = lon
                        if (previous) {
                            while (unwrapped - previous[0] > 180) unwrapped -= 360
                            while (unwrapped - previous[0] < -180) unwrapped += 360
                        }
                        coordinates.push([unwrapped, lat])
                    }
                    // Mapbox draws longitudes within ±540 only: anchor the newest position in -180..180,
                    // so a track that went round the globe loses its oldest laps rather than its newest.
                    const shift = -Math.round(coordinates[coordinates.length - 1][0] / 360) * 360
                    if (shift) for (const c of coordinates) c[0] += shift
                    const [first] = coordinates
                    const moving = coordinates.some(([lon, lat]) => lon !== first[0] || lat !== first[1])
                    if (moving) {
                        features.push({
                            type: 'Feature',
                            geometry: { type: 'LineString', coordinates },
                            properties: {}
                        })
                    }
                    features.push({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: coordinates[coordinates.length - 1] },
                        properties: { alone: !moving }
                    })
                } else {
                    for (const { row, position: p } of shown[i]) {
                        const value = toNumber(row.value)
                        const properties =
                            type === 'heatmap'
                                ? {
                                      weight:
                                          range.max > range.min && value !== undefined
                                              ? 1 + 2 * normalized(value, range)
                                              : 1,
                                      radius: heatmapRadius * (1 + normalized(value, range))
                                  }
                                : { label: formatValue(value), radius: circleRadius(value, range) }
                        features.push({
                            type: 'Feature',
                            geometry: { type: 'Point', coordinates: p },
                            properties
                        })
                    }
                }

                const layers =
                    type === 'circle'
                        ? circleLayers(sourceId, color, config)
                        : type === 'symbol'
                          ? symbolLayers(sourceId, color, config)
                          : type === 'heatmap'
                            ? heatmapLayers(sourceId, config)
                            : lineLayers(sourceId, color, config)

                dataSets.push({
                    sourceId,
                    label: key ? (label ? `${key} - ${label}` : key) : label,
                    type,
                    color,
                    data: { type: 'FeatureCollection', features },
                    layers,
                    signature: JSON.stringify(layers)
                })
            })
        })
        return dataSets
    }

    private createMap() {
        const container = this.mapElement
        // Nothing to draw into while detached; connectedCallback creates the map on attach.
        if (!container || !this.isConnected) return
        this.destroyMap()
        this.mapStyle = this.effectiveStyle()
        this.mapToken = this.effectiveToken()
        this.mapError = undefined
        this.cooperative = false
        // Mapbox expects an empty container; a previous map can leave elements behind.
        container.replaceChildren()
        let map: MapboxMap
        try {
            map = new mapboxgl.Map({
                container,
                accessToken: this.mapToken,
                style: this.styleUrl(this.mapStyle),
                // The globe some styles default to hides everything on its far side.
                projection: 'mercator',
                center: [8.68417, 50.11552],
                zoom: 1.8
            })
        } catch (error) {
            container.replaceChildren()
            const message = String((error as Error)?.message ?? error).replace(
                /access_token=[^&\s]+/g,
                'access_token=…'
            )
            console.error('[widget-mapbox] Could not create the map:', message)
            this.mapError = /webgl/i.test(message)
                ? 'The map could not be created. It needs WebGL 2, which this browser or device does not provide.'
                : `The map could not be created: ${message}`
            return
        }
        this.map = map
        // Mapbox's wheel zoom stays off: onWheel zooms with ctrl/⌘ and lets a plain wheel scroll the page.
        map.scrollZoom.disable()
        map.addControl(new mapboxgl.NavigationControl(), 'top-right')
        map.addControl(new mapboxgl.ScaleControl({ maxWidth: 80, unit: 'metric' }), 'bottom-left')
        map.on('error', (event: any) => this.onMapError(event))
        // A basemap tile that had failed and has now loaded means the network is back: clear the
        // notice, and soon fetch the other failed tiles, which Mapbox would leave empty until the
        // camera moves. Any other basemap tile load may also mean the network is back (or come from
        // Mapbox's cache): forget failed tiles that are gone, and bring a retry forward, at most every 10 s.
        map.on('data', (event: any) => {
            const key = event.dataType === 'source' ? this.tileKey(event) : undefined
            if (!key || event.tile.state !== 'loaded' || !this.failedTiles.size) return
            if (this.failedTiles.delete(key)) {
                this.tileRetries = 0
                if (this.noticeKind === 'network') this.setNotice(undefined)
            } else {
                this.pruneFailedTiles()
            }
            if (this.failedTiles.size && Date.now() - this.lastTileRetry > 10_000) this.scheduleTileRetry(1)
        })
        // Layers go in on 'style.load', not 'load': 'load' waits for the basemap tiles and never
        // fires while they fail, which would keep the data off the map as well.
        map.on('style.load', () => this.onStyleLoad(map))
        // A camera change counts as the user's when an input event drove it. Mapbox's own handling
        // of window resizes also attaches its event, so those are excluded.
        map.on('movestart', (event: any) => {
            const type = event.originalEvent?.type
            if (type && !/^(resize|orientationchange|fullscreenchange)$/.test(type)) this.markUserMoved()
        })
        for (const type of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart', 'boxzoomstart'] as const) {
            map.on(type, (event: any) => {
                if (event.originalEvent || !this.fitting) this.markUserMoved()
            })
        }
    }

    private destroyMap() {
        clearTimeout(this.fitTimer)
        clearTimeout(this.styleRetryTimer)
        clearTimeout(this.tileRetryTimer)
        this.tileRetryTimer = undefined
        try {
            this.map?.remove()
        } catch (error) {
            console.warn('[widget-mapbox] Could not remove the map:', error)
        }
        this.map = undefined
        this.styleReady = false
        this.styleGeneration++
        this.styleRetries = 0
        this.appliedLayers.clear()
        this.hasFitted = false
        this.userMoved = false
        this.failedTiles.clear()
        this.tileRetries = 0
        this.setNotice(undefined)
    }

    private setMapStyle() {
        if (!this.map) return
        this.mapStyle = this.effectiveStyle()
        this.styleRetries = 0
        this.setNotice(undefined)
        this.reloadStyle()
    }

    private reloadStyle() {
        if (!this.map || !this.mapStyle) return
        clearTimeout(this.styleRetryTimer)
        // The old style's tiles go with it.
        clearTimeout(this.tileRetryTimer)
        this.tileRetryTimer = undefined
        this.failedTiles.clear()
        this.styleReady = false
        this.styleGeneration++
        this.appliedLayers.clear()
        // diff: false rebuilds the style, which fires 'style.load' again. A diffed update would
        // silently drop the data layers and never announce the new style.
        // (The typings demand every option; at runtime the rest default to the map's current ones.)
        this.map.setStyle(this.styleUrl(this.mapStyle), { diff: false } as any)
    }

    private async onStyleLoad(map: MapboxMap) {
        if (map !== this.map) return
        const generation = ++this.styleGeneration
        this.styleReady = false
        this.styleRetries = 0
        this.appliedLayers.clear()
        const icons = await loadIcons()
        if (map !== this.map || generation !== this.styleGeneration) return
        try {
            for (const [id, image] of icons) {
                if (!map.hasImage(id)) map.addImage(id, image, { sdf: true, pixelRatio: ICON_PIXEL_RATIO })
            }
            this.addBuildingLayer(map)
        } catch (error) {
            console.error('[widget-mapbox] Could not prepare the style:', error)
        }
        this.styleReady = true
        if (this.mapNotice === NOTICE_TEXT.styleNetwork) this.setNotice(undefined)
        this.syncDataLayers()
        this.autoFit()
    }

    private setNotice(kind?: 'auth' | 'network', notice?: Notice) {
        const appeared = !!notice && !this.mapNotice
        this.noticeKind = kind
        this.mapNotice = notice
        // The notice covers the top of the map: refit, so no point hides under it.
        if (
            appeared &&
            this.hasFitted &&
            (this.inputData?.follow || !this.userMoved) &&
            !this.gestureActive()
        ) {
            this.fitToData()
        }
    }

    private onMapError(event: any) {
        const error = event?.error
        const status = typeof error?.status === 'number' ? error.status : undefined
        // Network errors carry no status, and mapbox-gl appends the request URL (token included)
        // to their message.
        const raw = String(error?.message ?? error ?? '')
        const url = typeof error?.url === 'string' ? error.url : (raw.match(/https?:\/\/\S+/)?.[0] ?? '')
        const message = raw.replace(/\s*https?:\/\/\S+/g, '').trim()
        // Before the style has loaded, a failure of the style document itself (not its sprite or glyphs),
        // or one without status or URL (the style response broke off or did not parse).
        const styleFailure =
            !this.styleReady && (/\/styles\/v1\/[^/?]+\/[^/?]+(\?|$)/.test(url) || (!status && !url))

        if (status === 401 || status === 403) {
            this.setNotice(
                'auth',
                NOTICE_TEXT[
                    styleFailure ? (status === 401 ? 'style401' : 'style403') : status === 401 ? '401' : '403'
                ]
            )
        } else if (styleFailure) {
            // Without its style the map shows nothing at all, data included: say so, and try again later.
            if (this.noticeKind !== 'auth') this.setNotice('network', NOTICE_TEXT.styleNetwork)
            const delay = STYLE_RETRY_SECONDS[Math.min(this.styleRetries++, STYLE_RETRY_SECONDS.length - 1)]
            clearTimeout(this.styleRetryTimer)
            this.styleRetryTimer = setTimeout(() => this.reloadStyle(), delay * 1000)
        } else {
            // A basemap tile that failed without a status (network) or with a server error. 404 is a
            // normal missing tile; sprite and glyph failures carry no tile.
            const key = this.tileKey(event)
            if (key && (!status || status >= 500)) {
                this.failedTiles.add(key)
                this.lastTileFailure = Date.now()
                // Distinct tiles, so one tile reported twice is not an outage.
                if (this.failedTiles.size >= 3 && !this.noticeKind)
                    this.setNotice('network', NOTICE_TEXT.network)
                this.scheduleTileRetry(
                    TILE_RETRY_SECONDS[Math.min(this.tileRetries, TILE_RETRY_SECONDS.length - 1)]
                )
            }
        }

        // One line per kind of failure, not one per tile, and never the token.
        const key = status ? `HTTP ${status}` : message || 'Unknown map error'
        if (this.loggedErrors.has(key)) return
        this.loggedErrors.add(key)
        const shownUrl = url.replace(/access_token=[^&\s]+/g, 'access_token=…')
        console.error(`[widget-mapbox] ${key}${shownUrl ? ` for ${shownUrl}` : ''}`)
    }

    /** `sourceId/tileKey` of the basemap tile an error or data event is about, if any. */
    private tileKey(event: any): string | undefined {
        const sourceId = event?.sourceId
        const key = event?.tile?.tileID?.key
        if (!sourceId || key === undefined || String(sourceId).startsWith('input:')) return undefined
        return `${sourceId}/${key}`
    }

    /** Retries the failed basemap tiles after `seconds` (sooner if already due sooner). */
    private scheduleTileRetry(seconds: number) {
        // Mapbox's workers hand a failed tile's error back for 3 s, so an earlier retry is wasted.
        const wait = Math.max(seconds, 3.5 - (Date.now() - this.lastTileFailure) / 1000)
        const due = Date.now() + wait * 1000
        if (this.tileRetryTimer && this.tileRetryDue <= due) return
        clearTimeout(this.tileRetryTimer)
        this.tileRetryDue = due
        this.tileRetryTimer = setTimeout(() => {
            this.tileRetryTimer = undefined
            this.retryBasemapTiles()
        }, wait * 1000)
    }

    /** The tiles of the basemap source caches: `sourceId/tileKey`, cache, key and state. */
    private basemapTiles(): { id: string; cache: any; key: string; state: string }[] {
        const result: { id: string; cache: any; key: string; state: string }[] = []
        for (const cache of (this.map as any)?.style?.getSourceCaches?.() ?? []) {
            // Caches are named 'other:composite', 'symbol:composite' …; events name the source itself.
            const sourceId = String(cache?.getSource?.()?.id ?? '')
            if (!sourceId || sourceId.startsWith('input:')) continue
            for (const [key, tile] of Object.entries<any>(cache._tiles ?? {})) {
                result.push({ id: `${sourceId}/${key}`, cache, key, state: String(tile?.state) })
            }
        }
        return result
    }

    /**
     * Forgets failed tiles that have loaded or are gone (the camera moved on). Tiles still errored or
     * being fetched again stay failed until they load.
     */
    private pruneFailedTiles() {
        const pending = new Set(
            this.basemapTiles()
                .filter((t) => ['errored', 'loading', 'expired', 'reloading'].includes(t.state))
                .map((t) => t.id)
        )
        for (const key of this.failedTiles) if (!pending.has(key)) this.failedTiles.delete(key)
        if (!this.failedTiles.size) {
            this.tileRetries = 0
            if (this.noticeKind === 'network') this.setNotice(undefined)
        }
    }

    /** Fetches the failed basemap tiles again, the way Mapbox refreshes tiles past their lifetime. */
    private retryBasemapTiles() {
        const map = this.map as any
        if (!map || !this.styleReady || !this.failedTiles.size) return
        this.tileRetries++
        this.lastTileRetry = Date.now()
        // Only the errored tiles: source.reload() would drop every tile, blanking the basemap (and
        // offline, losing the tiles still shown). _reloadTile and _tiles are internal, hence the guards.
        for (const { cache, key, state } of this.basemapTiles()) {
            if (state !== 'errored' || typeof cache._reloadTile !== 'function') continue
            cache._reloadTile(+key, 'expired')
            // 'expired' counts as having data, so Mapbox would drop the parent tile that covers the
            // area while the request runs: mark it as loading instead.
            const tile = cache._tiles?.[key]
            if (tile?.state === 'expired') tile.state = 'loading'
        }
        this.pruneFailedTiles()
        map.triggerRepaint()
    }

    /** True while the user drags or pinches the map: a camera fit now would end the gesture. */
    private gestureActive(): boolean {
        const map = this.map as any
        return !!(map?.dragPan?.isActive?.() || map?.touchZoomRotate?.isActive?.())
    }

    private markUserMoved() {
        this.userMoved = true
        if (!this.inputData?.follow) clearTimeout(this.fitTimer)
    }

    /** Ctrl/⌘ + wheel (and a trackpad pinch, which sends ctrlKey) zooms; a plain wheel scrolls the page. */
    private onWheel(event: WheelEvent) {
        const map = this.map
        if (!map || !this.dataSets.length) return
        if (!event.ctrlKey && !event.metaKey) {
            this.showGestureHint()
            return
        }
        event.preventDefault() // no page zoom
        clearTimeout(this.hintTimer)
        this.gestureHint = undefined
        const pixels = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1)
        // Saturating and continuous: a ~100 px mouse notch zooms a third of a level, small trackpad
        // pinch steps a little each, and no single event more than half a level.
        const magnitude = Math.abs(pixels)
        const delta = -Math.sign(pixels) * (magnitude / (100 + 2 * magnitude))
        const container = map.getCanvasContainer()
        const rect = container.getBoundingClientRect()
        const scale = container.offsetWidth / rect.width || 1 // CSS-transformed ancestors
        const around = map.unproject([
            (event.clientX - rect.left) * scale,
            (event.clientY - rect.top) * scale
        ])
        map.easeTo({ zoom: map.getZoom() + delta, around, duration: 0 }, { originalEvent: event })
    }

    private showGestureHint() {
        const mac = /Mac|iPhone|iPad/.test(navigator.userAgent)
        this.gestureHint = `Use ${mac ? '⌘' : 'Ctrl'} + scroll to zoom the map`
        clearTimeout(this.hintTimer)
        this.hintTimer = setTimeout(() => (this.gestureHint = undefined), 1200)
    }

    /** Touch: one finger pans, unless the page around the map can scroll; then one finger scrolls it. */
    private updateTouchMode() {
        const map = this.map
        if (!map) return
        const cooperative = this.inScrollableContext()
        if (cooperative === this.cooperative) return
        this.cooperative = cooperative
        // dragPan adds or removes Mapbox's two-finger hint on enable/disable, per the flag.
        map.dragPan.disable()
        map.setCooperativeGestures(cooperative)
        map.dragPan.enable()
        // Mapbox keeps a removed hint element and never re-adds it; put it back after a mode cycle.
        const hint: HTMLElement | undefined = (map as any).dragPan?._touchPan?._alertContainer
        if (cooperative && hint && !hint.isConnected) map.getContainer().appendChild(hint)
    }

    private inScrollableContext(): boolean {
        const up = (n: Element): Element | null =>
            n.assignedSlot ??
            n.parentElement ??
            ((n.getRootNode() as ShadowRoot).host as Element | undefined) ??
            null
        for (let el: Element | null = up(this); el; el = up(el)) {
            if (el === document.documentElement || el === document.body) break
            const s = getComputedStyle(el)
            if (
                (/auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight) ||
                (/auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth)
            ) {
                return true
            }
        }
        const root = document.scrollingElement
        const html = document.documentElement
        const body = document.body
        if (!root || !body) return false
        const htmlOverflow = getComputedStyle(html).overflowY
        const bodyOverflow = getComputedStyle(body).overflowY
        // With html's overflow set, body is a scroll container of its own...
        if (
            htmlOverflow !== 'visible' &&
            /auto|scroll/.test(bodyOverflow) &&
            body.scrollHeight > body.clientHeight + 1
        ) {
            return true
        }
        // ...otherwise body's overflow is the viewport's.
        if (/hidden|clip/.test(htmlOverflow !== 'visible' ? htmlOverflow : bodyOverflow)) return false
        // Phones size 100vh to the viewport without the browser toolbar, so a 100vh page "overflows"
        // clientHeight by the toolbar; only count content taller than that.
        const probe = document.createElement('div')
        probe.style.cssText =
            'position:fixed;top:0;width:0;height:100vh;visibility:hidden;pointer-events:none'
        document.documentElement.append(probe)
        const largeViewport = probe.getBoundingClientRect().height
        probe.remove()
        return root.scrollHeight > Math.max(root.clientHeight, largeViewport) + 1
    }

    private onResize() {
        const map = this.map
        const element = this.mapElement
        if (!map || !element?.clientWidth || !element.clientHeight) return
        map.resize()
        if (!this.hasFitted) {
            this.fitToData() // first real size: frame the data right away
            return
        }
        // Refit only while following, or before the user has moved the map themselves.
        if (this.inputData?.follow || !this.userMoved) {
            clearTimeout(this.fitTimer)
            this.fitTimer = setTimeout(() => {
                if ((this.inputData?.follow || !this.userMoved) && !this.gestureActive()) this.fitToData()
            }, 300)
        }
    }

    /** Fits the view on the first data, and on every update when follow is on. */
    private autoFit() {
        if (!(this.inputData?.follow || !this.hasFitted)) return
        // Not while the user drags or pinches: the fit would end the gesture, and the browser would
        // take the rest of the swipe as a page scroll. The next update fits again.
        if (!this.gestureActive()) this.fitToData()
    }

    private fitToData() {
        const map = this.map
        if (!map) return
        const container = map.getContainer()
        const width = container.clientWidth
        const height = container.clientHeight
        if (!width || !height) return // hidden: the resize observer fits once it has a size
        const bounds = dataBounds(this.dataSets)
        if (!bounds) return
        // The layout may have changed in this very render (e.g. the legend grew) before the
        // resize observer has told Mapbox, which would fit to the old size.
        const canvas = map.getCanvas()
        if (canvas.clientWidth !== width || canvas.clientHeight !== height) map.resize()
        const [[west, south], [east, north]] = bounds
        const singlePoint = east - west < 1e-7 && north - south < 1e-7
        const pad = Math.min(32, Math.floor(Math.min(width, height) / 8))
        this.fitting = true
        try {
            map.fitBounds(bounds as LngLatBoundsLike, {
                maxZoom: singlePoint ? 14 : 18,
                // keep points out from under the notice bar
                // (a narrow map wraps the notice to two lines; a short one cannot spare it all)
                padding: {
                    top:
                        pad +
                        Math.min(
                            this.mapNotice ? (width < 480 ? 44 : 28) : 0,
                            Math.max(0, height - 2 * pad - 48)
                        ),
                    bottom: pad,
                    left: pad,
                    right: pad
                },
                duration: 100
            })
            this.hasFitted = true
        } catch (error) {
            console.warn('[widget-mapbox] Could not fit the view to the data:', error)
        } finally {
            this.fitting = false
        }
    }

    /** Brings the style's sources and layers in line with dataSets: adds, updates and removes. */
    private syncDataLayers() {
        const map = this.map
        if (!map || !this.styleReady) return
        const removeLayers = (ids: Iterable<string>) => {
            for (const id of ids) if (map.getLayer(id)) map.removeLayer(id)
        }
        try {
            const wanted = new Map(this.dataSets.map((ds) => [ds.sourceId, ds]))
            for (const [sourceId, applied] of [...this.appliedLayers]) {
                // Gone, or now of another type: a fresh source keeps the old features out of the new layers.
                if (wanted.get(sourceId)?.type === applied.type) continue
                removeLayers(applied.layerIds)
                if (map.getSource(sourceId)) map.removeSource(sourceId)
                this.appliedLayers.delete(sourceId)
            }

            this.dataSets.forEach((ds, index) => {
                const source = map.getSource(ds.sourceId) as GeoJSONSource | undefined
                if (source) source.setData(ds.data)
                else map.addSource(ds.sourceId, { type: 'geojson', data: ds.data })

                const applied = this.appliedLayers.get(ds.sourceId)
                if (applied?.signature === ds.signature) {
                    // Unchanged. Rebuild only if a layer went missing that had been accepted before.
                    if (!applied.complete || applied.layerIds.every((id) => map.getLayer(id))) return
                }
                // New series, or its config/color changed: rebuild its layers in place.
                removeLayers(new Set([...(applied?.layerIds ?? []), ...ds.layers.map((l) => l.id)]))
                this.appliedLayers.set(ds.sourceId, {
                    type: ds.type,
                    signature: '',
                    layerIds: [],
                    complete: false
                })
                const beforeId = this.firstLayerAfter(map, index)
                for (const layer of ds.layers) map.addLayer(layer, beforeId)
                this.appliedLayers.set(ds.sourceId, {
                    type: ds.type,
                    signature: ds.signature,
                    layerIds: ds.layers.map((l) => l.id),
                    complete: ds.layers.every((l) => map.getLayer(l.id))
                })
            })
        } catch (error) {
            console.error('[widget-mapbox] Could not update the map layers:', error)
        }
    }

    /** The first layer of a later series, so layers stack in series order however they were added. */
    private firstLayerAfter(map: MapboxMap, index: number): string | undefined {
        for (const ds of this.dataSets.slice(index + 1)) {
            const id = this.appliedLayers.get(ds.sourceId)?.layerIds.find((layerId) => map.getLayer(layerId))
            if (id) return id
        }
        return undefined
    }

    private addBuildingLayer(map: MapboxMap) {
        const id = styleId(this.mapStyle ?? '')
        if (map.getLayer('3d-buildings') || /^satellite/.test(id)) return
        const style = map.getStyle()
        const composite = style?.sources?.composite as { url?: string } | undefined
        if (!composite?.url?.includes('mapbox-streets')) return
        // Insert the layer beneath the first label layer.
        const labelLayerId = style.layers?.find(
            (l: any) => l.type === 'symbol' && l.layout?.['text-field']
        )?.id
        map.addLayer(
            {
                id: '3d-buildings',
                source: 'composite',
                'source-layer': 'building',
                filter: ['==', 'extrude', 'true'],
                type: 'fill-extrusion',
                minzoom: 14,
                paint: {
                    'fill-extrusion-color': isDarkStyle(id) ? '#2e3236' : '#aaa',
                    // use an 'interpolate' expression to add a smooth transition effect to the
                    // buildings as the user zooms in
                    'fill-extrusion-height': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        14,
                        0,
                        14.05,
                        ['get', 'height']
                    ],
                    'fill-extrusion-base': [
                        'interpolate',
                        ['linear'],
                        ['zoom'],
                        14,
                        0,
                        14.05,
                        ['get', 'min_height']
                    ],
                    'fill-extrusion-opacity': 0.6
                }
            } as any,
            labelLayerId
        )
    }

    static styles = [
        unsafeCSS(mapboxCSS),
        css`
            :host {
                display: block;
                font-family: sans-serif;
                box-sizing: border-box;
                margin: auto;
            }

            .paging:not([active]) {
                display: none !important;
            }

            header {
                display: flex;
                flex-wrap: wrap;
                margin: 0 0 16px 0;
                gap: 6px 24px;
                justify-content: space-between;
                align-items: flex-start;
            }
            h3 {
                margin: 0;
                max-width: 300px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            p {
                margin: 10px 0 0 0;
                max-width: 300px;
                font-size: 14px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                line-height: 17px;
            }

            .wrapper {
                display: flex;
                flex-direction: column;
                box-sizing: border-box;
                padding: 16px;
                height: 100%;
                width: 100%;
                /* lets the legend cap its height relative to the tile (cqh) */
                container-type: size;
            }

            .map-area {
                position: relative;
                flex: 1;
                min-height: 0;
            }

            /* Always laid out, so Mapbox measures the real size even while there is no data. */
            #map {
                position: absolute;
                inset: 0;
            }
            #map[empty] {
                visibility: hidden;
            }
            /*
             * Let the browser scroll the page from a one-finger swipe in both touch modes. Where the
             * page cannot scroll, Mapbox's touchmove handler still claims the pan and pinch. Otherwise
             * the first swipe after a mode change is lost, as touch-action is fixed when a touch starts.
             */
            #map .mapboxgl-canvas-container.mapboxgl-touch-drag-pan,
            #map .mapboxgl-canvas-container.mapboxgl-touch-drag-pan .mapboxgl-canvas {
                touch-action: pan-x pan-y;
            }

            .title {
                white-space: nowrap;
                min-width: 0;
                max-width: 100%;
            }

            .legend {
                display: flex;
                flex: 1 1 160px;
                flex-wrap: wrap;
                gap: 6px 12px;
                min-width: 0;
                max-height: clamp(18px, 22cqh, 80px);
                overflow-y: auto;
            }

            .label {
                display: flex;
                align-items: center;
                font-size: 14px;
                gap: 8px;
                min-width: 0;
                max-width: 100%;
            }
            .label > div:last-child {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .swatch {
                flex: none;
                width: 24px;
                height: 12px;
            }

            .no-data {
                position: absolute;
                inset: 0;
                font-size: 20px;
                display: flex;
                text-align: center;
                align-items: center;
                justify-content: center;
            }

            .map-error {
                position: absolute;
                inset: 0;
                box-sizing: border-box;
                padding: 8px;
                overflow: auto;
                font-size: 14px;
                display: flex;
                text-align: center;
                overflow-wrap: anywhere;
            }
            /* margin: auto centres the text but keeps its start reachable when it overflows */
            .map-error > span {
                margin: auto;
            }

            .notice,
            .hint {
                position: absolute;
                left: 50%;
                transform: translateX(-50%);
                width: max-content;
                box-sizing: border-box;
                padding: 4px 10px;
                border-radius: 4px;
                font-size: 12px;
                text-align: center;
                pointer-events: none;
            }
            .notice {
                top: 8px;
                /* between the left edge and the zoom buttons, centred, at most two lines */
                left: 8px;
                right: 50px;
                transform: none;
                width: fit-content;
                margin-inline: auto;
                /* a border instead of vertical padding keeps a clamped third line from peeking out */
                padding: 0 10px;
                border-block: 4px solid rgba(255, 255, 255, 0.85);
                background: rgba(255, 255, 255, 0.85);
                background-clip: padding-box;
                display: -webkit-box;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 2;
                overflow: hidden;
                color: #333;
            }
            .hint {
                top: 50%;
                translate: 0 -50%;
                max-width: calc(100% - 16px);
                /* above Mapbox's controls (z-index 2) on tiny tiles */
                z-index: 3;
                color: #fff;
                background: rgba(0, 0, 0, 0.6);
            }

            .notice .short {
                display: none;
            }
            /* Narrow tiles (a map under ~260 px): the short notice text. */
            @container (max-width: 292px) {
                .notice .long {
                    display: none;
                }
                .notice .short {
                    display: inline;
                }
            }

            /* Very short tiles: a tighter header leaves more room for the map. */
            @container (max-height: 140px) {
                header {
                    margin-bottom: 8px;
                }
                p {
                    display: none;
                }
            }
        `
    ]

    render(): TemplateResult {
        const noData = !this.dataSets.length
        const showLegend = !!this.inputData?.showLegend && !noData
        const hasTitle = !!(this.inputData?.title || this.inputData?.subTitle)
        return html`
            <div class="wrapper" style="color: ${this.themeTitleColor}">
                <header class="paging" ?active=${hasTitle || showLegend}>
                    <div class="title paging" ?active=${hasTitle}>
                        <h3 class="paging" ?active=${this.inputData?.title}>${this.inputData?.title}</h3>
                        <p
                            class="paging"
                            ?active=${this.inputData?.subTitle}
                            style="color: ${this.themeSubtitleColor}"
                        >
                            ${this.inputData?.subTitle}
                        </p>
                    </div>
                    <div class="legend paging" ?active=${showLegend}>
                        ${repeat(
                            this.dataSets,
                            (ds) => ds.sourceId,
                            (ds) => html`
                                <div class="label" title=${ds.label}>
                                    <div
                                        class="swatch"
                                        style="background: ${ds.type === 'heatmap'
                                            ? HEATMAP_LEGEND
                                            : ds.color}"
                                    ></div>
                                    <div>${ds.label}</div>
                                </div>
                            `
                        )}
                    </div>
                </header>
                <div class="map-area">
                    <div id="map" ?empty=${noData || !!this.mapError}></div>
                    <div class="paging no-data" ?active=${noData && !this.mapError}>No Data</div>
                    <div class="paging map-error" ?active=${this.mapError}><span>${this.mapError}</span></div>
                    <div class="paging notice" ?active=${this.mapNotice && !noData}>
                        <span class="long">${this.mapNotice?.long}</span
                        ><span class="short">${this.mapNotice?.short}</span>
                    </div>
                    <div class="paging hint" ?active=${this.gestureHint && !noData}>${this.gestureHint}</div>
                </div>
            </div>
        `
    }
}
