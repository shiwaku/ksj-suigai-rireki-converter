import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'

import { BASEMAPS, getBasemapStyle, type Basemap } from './basemap'
import {
  COLOR_MODES,
  DEFAULT_FILTER,
  DEFAULT_OPACITY,
  FILL_ID,
  OUTLINE_ID,
  POPUP_MAX_ITEMS,
  SOURCES,
  SOURCE_ID,
  YEAR_BINS,
  YEAR_MAX,
  YEAR_MIN,
  buildLayers,
  filterExpr,
  legendFor,
  popupHtml,
  type ColorMode,
  type FilterState,
  type PopupItem,
} from './layers'
import {
  CONTOUR_LINE_ID,
  CONTOUR_SOURCE,
  CONTOUR_TEXT_ID,
  DEM_HILLSHADE,
  DEM_MODES,
  DEM_TERRAIN,
  HILLSHADE_ID,
  HILLSHADE_METHODS,
  HILLSHADE_PRESETS,
  contourLayers,
  contourSourceSpec,
  demSourceSpec,
  hillshadeLayer,
  registerTerrainProtocols,
  type DemMode,
  type HillshadeMethod,
} from './terrain'
import { eventLabel, loadEventIndex, monthLabel, type EventIndex, type FloodEvent } from './events'
import { applyThemeAttr, initialTheme, type Theme } from './theme'
import './style.css'

// ---- 状態 ----

let theme: Theme = initialTheme()
let base: Basemap = 'pale'
applyThemeAttr(theme)

let sinsuiOn = true
let colorMode: ColorMode = 'year'
let opacity = DEFAULT_OPACITY
const filter: FilterState = { ...DEFAULT_FILTER }

let hillshadeOn = true
let hillshadeMethod: HillshadeMethod = 'igor'
let hillshadeExag = HILLSHADE_PRESETS.igor.exaggeration
let terrainOn = false
let terrainExag = 1
let contoursOn = false
let demMode: DemMode = 'tilejson'

let index: EventIndex | null = null

const isMobile = window.matchMedia('(max-width: 640px)').matches
const DEBUG = new URLSearchParams(location.search).has('debug')

// ---- プロトコル（地図の生成前に一度だけ） ----

const protocol = new Protocol()
maplibregl.addProtocol('pmtiles', protocol.tile)
registerTerrainProtocols(maplibregl)

// ---- 地図 ----

const map = new maplibregl.Map({
  container: 'map',
  style: await getBasemapStyle(base, theme),
  // 全 60 イベントの外接範囲（近畿〜中部）の中心。
  center: [137.856, 35.408],
  zoom: 7,
  minZoom: 4,
  maxZoom: 18,
  maxPitch: 85,
  // 地図位置を URL の #ズーム/緯度/経度 に反映（共有・リロード時の位置維持）
  hash: true,
  attributionControl: false,
  // モバイルはGPU/メモリが限られるため保持タイル数と描画解像度を絞る。
  // 逼迫すると WebGL コンテキストが失われ地図がまるごと消えるため、その圧を下げる。
  maxTileCacheSize: isMobile ? 24 : undefined,
  pixelRatio: isMobile ? Math.min(window.devicePixelRatio || 1, 2) : undefined,
})

map.addControl(
  new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }),
  'top-right',
)
map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: false },
    fitBoundsOptions: { maxZoom: 16 },
    trackUserLocation: true,
    showUserLocation: true,
  }),
  'top-right',
)
map.addControl(new maplibregl.FullscreenControl(), 'top-right')
map.addControl(new maplibregl.ScaleControl({ maxWidth: 200, unit: 'metric' }), 'bottom-left')
map.addControl(new maplibregl.AttributionControl({ compact: true }))

// ---- 診断（?debug で画面表示。実機での原因切り分け用） ----

const diagLog: string[] = []
let ctxLostCount = 0
let hudEl: HTMLElement | null = null

function diag(msg: string): void {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`
  diagLog.push(line)
  if (diagLog.length > 8) diagLog.shift()
  console.log('[diag]', line)
  renderHud()
}

function renderHud(): void {
  if (!DEBUG || !hudEl) return
  let rendered = -1
  try {
    if (map.getLayer(FILL_ID)) rendered = map.queryRenderedFeatures({ layers: [FILL_ID] }).length
  } catch {
    rendered = -2
  }
  hudEl.innerHTML =
    `<b>build ${__BUILD_TIME__}</b><br>` +
    `zoom ${map.getZoom().toFixed(1)} · pitch ${map.getPitch().toFixed(0)} · base ${base}<br>` +
    `dem ${demMode} · hillshade ${hillshadeOn} · terrain ${terrainOn} · contours ${contoursOn}<br>` +
    `mobile ${isMobile} · ctxLost ${ctxLostCount}<br>` +
    `rendered sinsui features: ${rendered}<br>` +
    `<u>log</u><br>${diagLog.join('<br>')}`
}

function initHud(): void {
  if (!DEBUG) return
  hudEl = document.createElement('div')
  hudEl.id = 'diag-hud'
  document.body.append(hudEl)
  renderHud()
  map.on('render', () => {
    if (map.areTilesLoaded()) renderHud()
  })
}

// ---- レイヤーの投入 ----
//
// 背景スタイルを差し替えると自前のレイヤーは全部消えるため、切替のたびに貼り直す。
// 貼り直しと個別の更新で同じ関数を使い、状態からの再構築1本にまとめている。

/** 自前のレイヤーID。背景スタイル側のレイヤーと見分けるために使う。 */
const OWN_LAYER_IDS = new Set([
  FILL_ID,
  OUTLINE_ID,
  HILLSHADE_ID,
  CONTOUR_LINE_ID,
  CONTOUR_TEXT_ID,
])

/**
 * 背景地図の最初のラベル（symbol）レイヤーのID。
 * 自前のレイヤーはこの手前に差し込み、地名・注記が浸水域や陰影の下に隠れないようにする。
 * 写真・白図の背景にはラベルが無いため undefined（最前面に積む）。
 */
function labelBeforeId(): string | undefined {
  const layers = map.getStyle()?.layers ?? []
  return layers.find((l) => l.type === 'symbol' && !OWN_LAYER_IDS.has(l.id))?.id
}

function removeLayer(id: string): void {
  if (map.getLayer(id)) map.removeLayer(id)
}

function removeSource(id: string): void {
  if (map.getSource(id)) map.removeSource(id)
}

/**
 * 現在の状態からレイヤーを組み直す。
 *
 * 積み順（下から）: 背景地図 → 陰影起伏 → 浸水域（塗り・輪郭）→ 等高線 → 背景地図のラベル。
 * 等高線を浸水域の上に置くのは、浸水域を透かして地形の高低を追えるようにするため。
 */
function applyLayers(): void {
  if (!map.isStyleLoaded()) return
  const before = labelBeforeId()

  // 一度すべて外してから積み直す。個別に差分を当てるより、
  // 積み順と有無の組み合わせを取り違える余地が少ない。
  for (const id of [CONTOUR_TEXT_ID, CONTOUR_LINE_ID, OUTLINE_ID, FILL_ID, HILLSHADE_ID]) {
    removeLayer(id)
  }

  if (hillshadeOn) {
    if (!map.getSource(DEM_HILLSHADE)) map.addSource(DEM_HILLSHADE, demSourceSpec(demMode))
    map.addLayer(hillshadeLayer(hillshadeMethod, hillshadeExag), before)
  } else {
    removeSource(DEM_HILLSHADE)
  }

  if (!map.getSource(SOURCE_ID)) map.addSource(SOURCE_ID, SOURCES[SOURCE_ID])
  for (const spec of buildLayers({ mode: colorMode, theme, filter, opacity })) {
    map.addLayer(
      {
        ...spec,
        layout: { ...(spec as { layout?: object }).layout, visibility: sinsuiOn ? 'visible' : 'none' },
      } as maplibregl.LayerSpecification,
      before,
    )
  }

  if (contoursOn) {
    if (!map.getSource(CONTOUR_SOURCE)) map.addSource(CONTOUR_SOURCE, contourSourceSpec())
    for (const spec of contourLayers(theme)) map.addLayer(spec, before)
  } else {
    removeSource(CONTOUR_SOURCE)
  }

  applyTerrain()
}

/** 3D地形。陰影起伏とは別ソースにするのが MapLibre の推奨。 */
function applyTerrain(): void {
  if (!map.isStyleLoaded()) return
  if (terrainOn) {
    if (!map.getSource(DEM_TERRAIN)) map.addSource(DEM_TERRAIN, demSourceSpec(demMode))
    map.setTerrain({ source: DEM_TERRAIN, exaggeration: terrainExag })
  } else {
    map.setTerrain(null)
    // setTerrain(null) の直後はまだソースが参照されているため、次のフレームで外す
    requestAnimationFrame(() => {
      if (!terrainOn) removeSource(DEM_TERRAIN)
    })
  }
}

/** 浸水域だけの軽い更新（絞り込み・不透明度・表示切替）。 */
function applySinsui(): void {
  if (!map.getLayer(FILL_ID)) return
  const f = filterExpr(filter) as never
  for (const id of [FILL_ID, OUTLINE_ID]) {
    map.setFilter(id, f)
    map.setLayoutProperty(id, 'visibility', sinsuiOn ? 'visible' : 'none')
  }
  map.setPaintProperty(FILL_ID, 'fill-opacity', opacity)
  map.setPaintProperty(OUTLINE_ID, 'line-opacity', Math.min(1, opacity + 0.3))
}

// ラスタ（写真）↔ベクタ（標準地図）の切替では diff 適用が効かないため diff:false で
// 完全に再構築する。setStyle 直後は isStyleLoaded() が旧スタイルで true を返して
// 競合するため、新スタイルが落ち着く idle を待ってから貼り直す。
async function reloadStyle(): Promise<void> {
  map.setStyle(await getBasemapStyle(base, theme), { diff: false })
  map.once('idle', () => applyLayers())
}

// ---- ヘッダのボタン ----

const themeBtn = document.getElementById('theme-btn') as HTMLButtonElement
const renderThemeBtn = (): void => {
  themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙'
}
themeBtn.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark'
  applyThemeAttr(theme)
  renderThemeBtn()
  renderLegend()
  void reloadStyle()
})

const panel = document.getElementById('panel') as HTMLElement
const collapseBtn = document.getElementById('collapse-btn') as HTMLButtonElement
const renderCollapseBtn = (): void => {
  collapseBtn.textContent = panel.classList.contains('collapsed') ? '▾' : '▴'
}
collapseBtn.addEventListener('click', () => {
  panel.classList.toggle('collapsed')
  renderCollapseBtn()
})

// ---- 浸水実績 ----

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const sinsuiOnEl = el<HTMLInputElement>('sinsui-on')
sinsuiOnEl.addEventListener('change', () => {
  sinsuiOn = sinsuiOnEl.checked
  applySinsui()
})

const opacityEl = el<HTMLInputElement>('sinsui-opacity')
const opacityValEl = el('sinsui-opacity-val')
opacityEl.addEventListener('input', () => {
  opacity = Number(opacityEl.value)
  opacityValEl.textContent = `${Math.round(opacity * 100)}%`
  applySinsui()
})

// ---- 色分けと凡例 ----

const legendEl = el<HTMLUListElement>('legend')

/**
 * 凡例の件数は、いま絞り込んでいる範囲の件数を出す。
 * タイルからは見えている範囲しか数えられないため、イベント索引から積算する。
 */
function counts(): { bins: number[]; typhoon: number; other: number; total: number } {
  const bins = new Array(YEAR_BINS.length + 1).fill(0) as number[]
  let typhoon = 0
  let other = 0
  let total = 0
  for (const e of index?.events ?? []) {
    if (!matchesFilter(e)) continue
    total += e.count
    if (e.typhoon) typhoon += e.count
    else other += e.count
    const y = e.year ?? 0
    let bin = 0
    while (bin < YEAR_BINS.length && y >= YEAR_BINS[bin]) bin++
    bins[bin] += e.count
  }
  return { bins, typhoon, other, total }
}

function matchesFilter(e: FloodEvent): boolean {
  const y = e.year ?? 0
  if (y < filter.yearFrom || y > filter.yearTo) return false
  if (filter.typhoonOnly && !e.typhoon) return false
  if (filter.src && filter.src !== e.src) return false
  return true
}

function renderLegend(): void {
  // 件数はイベント索引から積算する。読み込み前は色だけを出し、
  // 「0件」と誤読させない。
  const c = index ? counts() : null
  const items = legendFor(colorMode, theme, c?.bins)
  if (c) {
    if (colorMode === 'typhoon') {
      items[0].count = c.typhoon
      items[1].count = c.other
    } else if (colorMode === 'plain') {
      items[0].count = c.total
    }
  }
  legendEl.replaceChildren(
    ...items.map((it) => {
      const li = document.createElement('li')
      const sw = document.createElement('span')
      sw.className = 'sw'
      sw.style.background = it.color
      const label = document.createElement('span')
      label.className = 'lg-label'
      label.textContent = it.label
      li.append(sw, label)
      if (it.count !== undefined) {
        const n = document.createElement('span')
        n.className = 'lg-count'
        n.textContent = `${it.count.toLocaleString('ja-JP')}件`
        li.append(n)
      }
      return li
    }),
  )
  el('feature-count').textContent = c ? `${c.total.toLocaleString('ja-JP')}件` : '–'
}

const colorModesEl = el('color-modes')
function buildColorModes(): void {
  colorModesEl.replaceChildren(
    ...COLOR_MODES.map(({ key, label }) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = label
      btn.dataset.mode = key
      btn.setAttribute('aria-pressed', String(key === colorMode))
      btn.addEventListener('click', () => {
        if (colorMode === key) return
        colorMode = key
        for (const b of colorModesEl.querySelectorAll<HTMLButtonElement>('button')) {
          b.setAttribute('aria-pressed', String(b.dataset.mode === colorMode))
        }
        renderLegend()
        // 色の式そのものが変わるためレイヤーを組み直す
        applyLayers()
      })
      return btn
    }),
  )
}

// ---- 期間 ----

const yearFromEl = el<HTMLInputElement>('year-from')
const yearToEl = el<HTMLInputElement>('year-to')
const yearReadoutEl = el('year-readout')

function renderYearReadout(): void {
  yearReadoutEl.textContent = `${filter.yearFrom} – ${filter.yearTo} 年`
}

function onYearInput(): void {
  let from = Number(yearFromEl.value)
  let to = Number(yearToEl.value)
  // つまみが交差したら、いま動かしたほうを優先して他方を寄せる
  if (from > to) {
    if (document.activeElement === yearFromEl) to = from
    else from = to
    yearFromEl.value = String(from)
    yearToEl.value = String(to)
  }
  filter.yearFrom = from
  filter.yearTo = to
  renderYearReadout()
  renderLegend()
  applySinsui()
}
yearFromEl.addEventListener('input', onYearInput)
yearToEl.addEventListener('input', onYearInput)

el<HTMLButtonElement>('year-reset').addEventListener('click', () => {
  filter.yearFrom = YEAR_MIN
  filter.yearTo = YEAR_MAX
  yearFromEl.value = String(YEAR_MIN)
  yearToEl.value = String(YEAR_MAX)
  renderYearReadout()
  renderLegend()
  applySinsui()
})

const typhoonOnlyEl = el<HTMLInputElement>('typhoon-only')
typhoonOnlyEl.addEventListener('change', () => {
  filter.typhoonOnly = typhoonOnlyEl.checked
  renderLegend()
  applySinsui()
})

// ---- 水害イベント ----

const eventSelectEl = el<HTMLSelectElement>('event-select')
const eventZoomEl = el<HTMLButtonElement>('event-zoom')
const eventNoteEl = el('event-note')

function selectedEvent(): FloodEvent | null {
  if (!filter.src) return null
  return index?.events.find((e) => e.src === filter.src) ?? null
}

function renderEventNote(): void {
  const e = selectedEvent()
  if (!e) {
    eventNoteEl.textContent = index
      ? `全${index.events.length}イベント / ${index.features.toLocaleString('ja-JP')}件。`
      : ''
    eventZoomEl.disabled = true
    return
  }
  const parts = [
    `${e.year ?? '????'}年${monthLabel(e.month)}`,
    e.typhoon ? '台風性' : '豪雨・その他',
    `${e.count.toLocaleString('ja-JP')}件`,
    e.src,
  ]
  eventNoteEl.textContent = parts.join(' · ')
  eventZoomEl.disabled = false
}

function buildEventSelect(idx: EventIndex): void {
  for (const e of idx.events) {
    const opt = document.createElement('option')
    opt.value = e.src
    opt.textContent = eventLabel(e)
    eventSelectEl.append(opt)
  }
}

eventSelectEl.addEventListener('change', () => {
  filter.src = eventSelectEl.value || null
  renderEventNote()
  renderLegend()
  applySinsui()
})

eventZoomEl.addEventListener('click', () => {
  const e = selectedEvent()
  if (!e) return
  const [west, south, east, north] = e.bounds
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding: isMobile ? 24 : { top: 40, bottom: 40, left: 360, right: 40 }, maxZoom: 15 },
  )
})

// ---- 地形（Mapterhorn） ----

const hillshadeOnEl = el<HTMLInputElement>('hillshade-on')
const hillshadeOptsEl = el('hillshade-opts')
const hillshadeMethodEl = el<HTMLSelectElement>('hillshade-method')
const hillshadeExagEl = el<HTMLInputElement>('hillshade-exag')
const hillshadeExagValEl = el('hillshade-exag-val')

hillshadeOnEl.addEventListener('change', () => {
  hillshadeOn = hillshadeOnEl.checked
  hillshadeOptsEl.hidden = !hillshadeOn
  applyLayers()
})

for (const { key, label } of HILLSHADE_METHODS) {
  const opt = document.createElement('option')
  opt.value = key
  opt.textContent = label
  hillshadeMethodEl.append(opt)
}
hillshadeMethodEl.value = hillshadeMethod
hillshadeMethodEl.addEventListener('change', () => {
  hillshadeMethod = hillshadeMethodEl.value as HillshadeMethod
  // 算出方法ごとに見え方の落ち着く強調が違うため、プリセット値へ戻す
  hillshadeExag = HILLSHADE_PRESETS[hillshadeMethod].exaggeration
  hillshadeExagEl.value = String(hillshadeExag)
  hillshadeExagValEl.textContent = hillshadeExag.toFixed(2)
  applyLayers()
})

hillshadeExagEl.addEventListener('input', () => {
  hillshadeExag = Number(hillshadeExagEl.value)
  hillshadeExagValEl.textContent = hillshadeExag.toFixed(2)
  if (map.getLayer(HILLSHADE_ID)) {
    map.setPaintProperty(HILLSHADE_ID, 'hillshade-exaggeration', hillshadeExag)
  }
})

const terrainOnEl = el<HTMLInputElement>('terrain-on')
const terrainOptsEl = el('terrain-opts')
const terrainExagEl = el<HTMLInputElement>('terrain-exag')
const terrainExagValEl = el('terrain-exag-val')

terrainOnEl.addEventListener('change', () => {
  terrainOn = terrainOnEl.checked
  terrainOptsEl.hidden = !terrainOn
  // 真上から見たままでは起伏が分からないため、初回は視点を倒す。
  // 自分で戻した角度を勝手に上書きしないよう、水平のときだけ触る。
  if (terrainOn && map.getPitch() === 0) map.easeTo({ pitch: 55, duration: 600 })
  if (!terrainOn && map.getPitch() > 0) map.easeTo({ pitch: 0, duration: 600 })
  applyTerrain()
})

terrainExagEl.addEventListener('input', () => {
  terrainExag = Number(terrainExagEl.value)
  terrainExagValEl.textContent = terrainExag.toFixed(2)
  if (terrainOn) map.setTerrain({ source: DEM_TERRAIN, exaggeration: terrainExag })
})

const contoursOnEl = el<HTMLInputElement>('contours-on')
contoursOnEl.addEventListener('change', () => {
  contoursOn = contoursOnEl.checked
  applyLayers()
})

const demModeEl = el<HTMLSelectElement>('dem-mode')
for (const { key, label } of DEM_MODES) {
  const opt = document.createElement('option')
  opt.value = key
  opt.textContent = label
  demModeEl.append(opt)
}
demModeEl.value = demMode
demModeEl.addEventListener('change', () => {
  demMode = demModeEl.value as DemMode
  // ソース定義そのものが変わるので、いったん外してから積み直す
  map.setTerrain(null)
  removeLayer(HILLSHADE_ID)
  removeSource(DEM_HILLSHADE)
  removeSource(DEM_TERRAIN)
  applyLayers()
  diag(`DEM 配信方式を ${demMode} に切替`)
})

// ---- 背景地図スイッチャー（右下） ----

class BasemapControl implements maplibregl.IControl {
  private el!: HTMLElement
  onAdd(): HTMLElement {
    this.el = document.createElement('div')
    this.el.className = 'maplibregl-ctrl basemap-switch'
    for (const { key, label } of BASEMAPS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = label
      btn.dataset.base = key
      btn.setAttribute('aria-selected', String(key === base))
      btn.addEventListener('click', () => setBase(key))
      this.el.append(btn)
    }
    return this.el
  }
  onRemove(): void {
    this.el.remove()
  }
  sync(): void {
    for (const btn of this.el.querySelectorAll<HTMLButtonElement>('button')) {
      btn.setAttribute('aria-selected', String(btn.dataset.base === base))
    }
  }
}
const basemapCtrl = new BasemapControl()
map.addControl(basemapCtrl, 'bottom-right')

function setBase(next: Basemap): void {
  if (next === base) return
  base = next
  basemapCtrl.sync()
  void reloadStyle()
}

// ---- ホバーとポップアップ ----

// 塗りだけを対象にする。輪郭も対象にすると同じ地物が2回返る。
const queryLayers = (): string[] =>
  sinsuiOn && map.getLayer(FILL_ID) ? [FILL_ID] : []

if (window.matchMedia('(hover: hover)').matches) {
  map.on('mousemove', (ev) => {
    const ids = queryLayers()
    const hit = ids.length > 0 && map.queryRenderedFeatures(ev.point, { layers: ids }).length > 0
    map.getCanvas().style.cursor = hit ? 'pointer' : ''
  })
}

let popup: maplibregl.Popup | null = null
map.on('click', (ev) => {
  const ids = queryLayers()
  const feats = ids.length ? map.queryRenderedFeatures(ev.point, { layers: ids }) : []
  if (!feats.length) return

  // タイル境界をまたぐ浸水域は、タイルごとに1回ずつ返る。属性が完全に一致する
  // ものは1件にまとめてこれを抑える。元データの id が属性に残っているため、
  // 隣接する別の地物が潰れることはない。
  const seen = new Set<string>()
  const items: PopupItem[] = []
  for (const f of feats) {
    const props = (f.properties ?? {}) as Record<string, unknown>
    const key = JSON.stringify(props)
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ props })
  }

  if (popup) {
    const old = popup
    popup = null
    old.remove()
  }
  const p = new maplibregl.Popup({ closeButton: true, maxWidth: '340px' })
    .setLngLat(ev.lngLat)
    .setHTML(popupHtml(items.slice(0, POPUP_MAX_ITEMS), items.length))
    .addTo(map)
  p.on('close', () => {
    if (popup === p) popup = null
  })
  popup = p
})

// ---- 初期化 ----

const buildEl = document.getElementById('build-ver')
if (buildEl) buildEl.textContent = `build: ${__BUILD_TIME__}`

renderThemeBtn()
buildColorModes()
renderLegend()
renderYearReadout()
renderEventNote()
opacityValEl.textContent = `${Math.round(opacity * 100)}%`
hillshadeExagValEl.textContent = hillshadeExag.toFixed(2)
terrainExagValEl.textContent = terrainExag.toFixed(2)
hillshadeOptsEl.hidden = !hillshadeOn
terrainOptsEl.hidden = !terrainOn
// スマホでは初期状態でパネルを畳んで地図を広く見せる
if (isMobile) panel.classList.add('collapsed')
renderCollapseBtn()

map.on('load', applyLayers)
initHud()

// イベント索引はタイルとは別に読む。読めなくても地図と絞り込みは動くので、
// 失敗しても地図全体は落とさず、件数と一覧だけ諦める。
loadEventIndex()
  .then((idx) => {
    index = idx
    buildEventSelect(idx)
    renderLegend()
    renderEventNote()
  })
  .catch((err: unknown) => {
    diag(`events.json を読めない: ${String(err)}`)
    eventNoteEl.textContent = 'イベント索引を読み込めませんでした（絞り込みは年と台風性のみ利用できます）。'
    eventSelectEl.disabled = true
  })

// WebGL コンテキスト消失からの復帰。3D地形を有効にするとGPU負荷が上がり、
// iOS Safari 等ではメモリ逼迫でコンテキストが失われて地図が戻らないことがある。
const canvas = map.getCanvas()
canvas.addEventListener(
  'webglcontextlost',
  (ev) => {
    // preventDefault しないと自動復帰イベントが発火しない
    ev.preventDefault()
    ctxLostCount++
    diag('WebGL context lost')
  },
  false,
)
canvas.addEventListener(
  'webglcontextrestored',
  () => {
    diag('WebGL context restored → relayering')
    if (map.isStyleLoaded()) applyLayers()
    else map.once('idle', applyLayers)
  },
  false,
)

map.on('error', (ev) => {
  const msg = (ev && (ev as unknown as { error?: Error }).error?.message) || 'map error'
  diag(`error: ${msg}`)
})

// デバッグ/外部連携用にマップを公開
;(window as unknown as { __map: maplibregl.Map }).__map = map
