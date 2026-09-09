import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'

import { BASEMAPS, getBasemapStyle, type Basemap } from './basemap'
import {
  DEFAULT_FILTER,
  DEFAULT_OPACITY,
  FILL_ID,
  ORIGIN_MODES,
  OUTLINE_ID,
  POPUP_MAX_ITEMS,
  SOURCES,
  SOURCE_ID,
  buildLayers,
  filterExpr,
  legendFor,
  popupHtml,
  type FilterState,
  type OriginCounts,
  type PopupItem,
} from './layers'
import {
  CONTOUR_LINE_ID,
  CONTOUR_SOURCE,
  CONTOUR_TEXT_ID,
  DEM_HILLSHADE,
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
import {
  loadEventIndex,
  monthLabel,
  readEventParam,
  writeEventParam,
  type EventIndex,
  type FloodEvent,
} from './events'
import { createEventPicker, type EventPicker } from './eventPicker'
import { applyThemeAttr, initialTheme, type Theme } from './theme'
import './style.css'

// ---- 状態 ----

let theme: Theme = initialTheme()
let base: Basemap = 'pale'
applyThemeAttr(theme)

let sinsuiOn = true
let opacity = DEFAULT_OPACITY
const filter: FilterState = { ...DEFAULT_FILTER }

let hillshadeOn = true
let hillshadeMethod: HillshadeMethod = 'igor'
let hillshadeExag = HILLSHADE_PRESETS.igor.exaggeration
let terrainOn = false
let terrainExag = 1
let contoursOn = false

/**
 * DEM タイルの配信方式。
 *
 * 画面から選ばせていたが、浸水履歴を読むうえで配信方式の違いに意味はなく
 * （見た目は同じで、PMTiles 方式は 705GB のアーカイブへの範囲読みで遅い）、
 * 操作を迷わせるだけだった。既定の TileJSON に固定し、切り分けが必要なときだけ
 * `?dem=zxy` / `?dem=pmtiles` で差し替える。
 */
const demMode: DemMode = ((): DemMode => {
  const q = new URLSearchParams(location.search).get('dem')
  return q === 'zxy' || q === 'pmtiles' || q === 'tilejson' ? q : 'tilejson'
})()

let index: EventIndex | null = null

const isMobile = window.matchMedia('(max-width: 640px)').matches
const DEBUG = new URLSearchParams(location.search).has('debug')

/** `?event=` で復元するイベント。索引を読み終えてから適用する。 */
const initialEvent = readEventParam()
/**
 * 起動時に位置ハッシュ（#ズーム/緯度/経度）が付いていたか。
 * MapLibre は生成後に自分でハッシュを書くため、地図を作る前に見ておく必要がある。
 * ハッシュがあるなら位置は明示的に共有されたものなので、`?event=` の復元で
 * 勝手に範囲へ寄せない。
 */
const hadPositionHash = location.hash.length > 1

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
  // 3D地形を有効にすると、視線を倒すほど地平線の先まで表示範囲に入り、
  // 要求されるタイルが一気に増える。浸水域のタイルは広域で 1 枚 500KB 近くあり、
  // 85 度まで倒せると数百枚に膨らんで描画が止まる。起伏が読めれば十分なので抑える。
  maxPitch: 70,
  // 地図位置を URL の #ズーム/緯度/経度 に反映（共有・リロード時の位置維持）
  hash: true,
  attributionControl: false,
  // 保持タイル数を明示的に抑える。既定（512枚）だと、3D地形で視線を倒したときに
  // 500KB 級の浸水域タイルを大量に抱えてメモリを使い切り、GC で描画が止まる。
  // モバイルは GPU/メモリがさらに限られるため強めに絞る。逼迫すると WebGL
  // コンテキストが失われ地図がまるごと消えるため、その圧も下げる。
  maxTileCacheSize: isMobile ? 24 : 96,
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

/**
 * HUD に出す「画面中央付近に描かれている浸水域の件数」。
 *
 * 引数なしの queryRenderedFeatures は表示範囲の全地物を返す。広域では
 * 数千件の大きなポリゴンが対象になり、1回で数百ミリ秒かかる。以前これを
 * render ごとに呼んでいたため、?debug を付けると地図が固まっていた。
 * 「描画されているか」を見るのが目的なので、中央の小さな箱だけを見る。
 */
const CENTER_PROBE_PX = 80

function centerFeatureCount(): number {
  if (!map.getLayer(FILL_ID)) return -1
  const { width, height } = map.getCanvas()
  const cx = width / (window.devicePixelRatio || 1) / 2
  const cy = height / (window.devicePixelRatio || 1) / 2
  const h = CENTER_PROBE_PX / 2
  try {
    return map.queryRenderedFeatures(
      [
        [cx - h, cy - h],
        [cx + h, cy + h],
      ],
      { layers: [FILL_ID] },
    ).length
  } catch {
    return -2
  }
}

function renderHud(): void {
  if (!DEBUG || !hudEl) return
  const rendered = centerFeatureCount()
  hudEl.innerHTML =
    `<b>build ${__BUILD_TIME__}</b><br>` +
    `zoom ${map.getZoom().toFixed(1)} · pitch ${map.getPitch().toFixed(0)} · base ${base}<br>` +
    `dem ${demMode} · hillshade ${hillshadeOn} · terrain ${terrainOn} · contours ${contoursOn}<br>` +
    `mobile ${isMobile} · ctxLost ${ctxLostCount}<br>` +
    `中央${CENTER_PROBE_PX}pxの浸水域: ${rendered}<br>` +
    `<u>log</u><br>${diagLog.join('<br>')}`
}

function initHud(): void {
  if (!DEBUG) return
  hudEl = document.createElement('div')
  hudEl.id = 'diag-hud'
  document.body.append(hudEl)
  renderHud()
  // render ごとではなく idle で更新する。地物の数え上げは安くないため、
  // 描画のたびに走らせると診断が原因で地図が重くなる。
  map.on('idle', renderHud)
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
 * スタイルが読み込み中なら、落ち着いてから実行する。
 *
 * `isStyleLoaded()` が false のときに黙って何もしないと、押したトグルが
 * 反映されないまま終わる（背景やテーマを切り替えた直後がこれに当たる）。
 * 状態は先に更新されているので、idle で同じ関数を呼べば追いつく。
 */
function whenStyleReady(fn: () => void): void {
  if (map.isStyleLoaded()) fn()
  else map.once('idle', fn)
}

/**
 * 自前レイヤーの積み順（下から）:
 *   背景地図 → 陰影起伏 → 浸水域（塗り・輪郭）→ 等高線 → 背景地図のラベル
 *
 * 等高線を浸水域の上に置くのは、浸水域を透かして地形の高低を追えるようにするため。
 *
 * 各グループは「自分より上にあるグループの先頭」の手前に差し込む。こうすると
 * 陰影起伏や等高線を切り替えても浸水域のレイヤーに触らずに済む。以前は毎回
 * 全部外して積み直していたため、地形のトグルを押すたびに 14,585 件の
 * 浸水域が再構築され、そのあいだ画面が止まっていた。
 */
function beforeIdFor(group: 'hillshade' | 'sinsui' | 'contour'): string | undefined {
  const labels = labelBeforeId()
  const contour = map.getLayer(CONTOUR_LINE_ID) ? CONTOUR_LINE_ID : labels
  if (group === 'contour') return labels
  if (group === 'sinsui') return contour
  return map.getLayer(FILL_ID) ? FILL_ID : contour
}

/** 陰影起伏。算出方法ごとに paint プリセットが変わるため、貼り直しで差し替える。 */
function applyHillshade(): void {
  whenStyleReady(() => {
    removeLayer(HILLSHADE_ID)
    if (!hillshadeOn) {
      removeSource(DEM_HILLSHADE)
      return
    }
    if (!map.getSource(DEM_HILLSHADE)) map.addSource(DEM_HILLSHADE, demSourceSpec(demMode))
    map.addLayer(hillshadeLayer(hillshadeMethod, hillshadeExag), beforeIdFor('hillshade'))
  })
}

/** 浸水域。色の式はテーマで変わるため、テーマ切替と背景切替のあとだけ貼り直す。 */
function applySinsuiLayers(): void {
  whenStyleReady(() => {
    removeLayer(OUTLINE_ID)
    removeLayer(FILL_ID)
    if (!map.getSource(SOURCE_ID)) map.addSource(SOURCE_ID, SOURCES[SOURCE_ID])
    const before = beforeIdFor('sinsui')
    for (const spec of buildLayers({ theme, filter, opacity })) {
      map.addLayer(
        {
          ...spec,
          layout: {
            ...(spec as { layout?: object }).layout,
            visibility: sinsuiOn ? 'visible' : 'none',
          },
        } as maplibregl.LayerSpecification,
        before,
      )
    }
  })
}

function applyContours(): void {
  whenStyleReady(() => {
    removeLayer(CONTOUR_TEXT_ID)
    removeLayer(CONTOUR_LINE_ID)
    if (!contoursOn) {
      removeSource(CONTOUR_SOURCE)
      return
    }
    if (!map.getSource(CONTOUR_SOURCE)) map.addSource(CONTOUR_SOURCE, contourSourceSpec())
    for (const spec of contourLayers(theme)) map.addLayer(spec, beforeIdFor('contour'))
  })
}

/** 3D地形。陰影起伏とは別ソースにするのが MapLibre の推奨。 */
function applyTerrain(): void {
  whenStyleReady(() => {
    if (terrainOn) {
      if (!map.getSource(DEM_TERRAIN)) map.addSource(DEM_TERRAIN, demSourceSpec(demMode))
      map.setTerrain({ source: DEM_TERRAIN, exaggeration: terrainExag })
      // 視線を倒すと地平線の先が見える。sky を出さないとそこが背景色のままになる。
      map.setSky({})
    } else {
      map.setTerrain(null)
      // setTerrain(null) の直後はまだソースが参照されているため、次のフレームで外す
      requestAnimationFrame(() => {
        if (!terrainOn) removeSource(DEM_TERRAIN)
      })
    }
  })
}

/** 全グループを積み直す。背景スタイルを差し替えたあとに使う。 */
function applyLayers(): void {
  applyHillshade()
  applySinsuiLayers()
  applyContours()
  applyTerrain()
}

// ---- 浸水域の軽い更新 ----
//
// 目的ごとに分ける。setFilter はそのレイヤーの読み込み済みタイルを作り直させる
// ため、14,585 件の浸水域では重い。不透明度スライダーを動かすたびに呼んでいた
// ため、ドラッグ中に画面が固まっていた。

/** 絞り込み（成因・イベント）。重い操作なので、絞り込みが変わったときだけ呼ぶ。 */
function applyFilter(): void {
  if (!map.getLayer(FILL_ID)) return
  const f = filterExpr(filter) as never
  map.setFilter(FILL_ID, f)
  map.setFilter(OUTLINE_ID, f)
}

function applyVisibility(): void {
  if (!map.getLayer(FILL_ID)) return
  const v = sinsuiOn ? 'visible' : 'none'
  map.setLayoutProperty(FILL_ID, 'visibility', v)
  map.setLayoutProperty(OUTLINE_ID, 'visibility', v)
}

function applyOpacity(): void {
  if (!map.getLayer(FILL_ID)) return
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
  applyVisibility()
})

const opacityEl = el<HTMLInputElement>('sinsui-opacity')
const opacityValEl = el('sinsui-opacity-val')
opacityEl.addEventListener('input', () => {
  opacity = Number(opacityEl.value)
  opacityValEl.textContent = `${Math.round(opacity * 100)}%`
  applyOpacity()
})

// ---- 色分けと凡例 ----

const legendEl = el<HTMLUListElement>('legend')

/**
 * 凡例と件数バッジに出す、いま絞り込んでいる範囲の件数。
 *
 * タイルからは見えている範囲しか数えられないため、イベント索引から積算する。
 * 索引の `count_typhoon` / `count_other` は build_events.py が地図側と同じ規則で
 * 数えたもの（1ファイルに両方の成因が混在するイベントがあるため個別に持っている）。
 */
function counts(): OriginCounts & { total: number } {
  let typhoon = 0
  let other = 0
  for (const e of index?.events ?? []) {
    if (filter.src && filter.src !== e.src) continue
    typhoon += e.count_typhoon
    other += e.count_other
  }
  const shown =
    filter.origin === 'typhoon' ? typhoon : filter.origin === 'other' ? other : typhoon + other
  return { typhoon, other, total: shown }
}

function renderLegend(): void {
  // 読み込み前は色だけを出し、「0件」と誤読させない
  const c = index ? counts() : null
  const items = legendFor(filter.origin, theme, c ?? undefined)
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

const originModesEl = el('origin-modes')
function buildOriginModes(): void {
  originModesEl.replaceChildren(
    ...ORIGIN_MODES.map(({ key, label }) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = label
      btn.dataset.mode = key
      btn.setAttribute('aria-pressed', String(key === filter.origin))
      btn.addEventListener('click', () => {
        if (filter.origin === key) return
        filter.origin = key
        for (const b of originModesEl.querySelectorAll<HTMLButtonElement>('button')) {
          b.setAttribute('aria-pressed', String(b.dataset.mode === filter.origin))
        }
        renderLegend()
        // 色の意味は変えず、絞り込みだけを差し替える
        applyFilter()
      })
      return btn
    }),
  )
}

// ---- 水害イベント ----

const eventZoomEl = el<HTMLButtonElement>('event-zoom')
const eventNoteEl = el('event-note')
let picker: EventPicker | null = null

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
  // 成因は件数で示す。1イベントに両方が混在するものがあるため「台風性かどうか」の
  // 二択では表せない（例: 1961年6月は大雨と台風第6号が同じファイルに入っている）。
  const origin =
    e.count_other === 0
      ? '台風'
      : e.count_typhoon === 0
        ? '大雨・その他'
        : `台風${e.count_typhoon.toLocaleString('ja-JP')}件 + 大雨・その他${e.count_other.toLocaleString('ja-JP')}件`
  const parts = [
    `${e.year ?? '????'}年${monthLabel(e.month)}`,
    origin,
    `計${e.count.toLocaleString('ja-JP')}件`,
    e.src,
  ]
  eventNoteEl.textContent = parts.join(' · ')
  eventZoomEl.disabled = false
}

function selectEvent(src: string | null): void {
  filter.src = src
  writeEventParam(src)
  renderEventNote()
  renderLegend()
  applyFilter()
}

function buildEventPicker(idx: EventIndex): void {
  picker = createEventPicker({
    input: el<HTMLInputElement>('event-input'),
    list: el<HTMLUListElement>('event-list'),
    clearBtn: el<HTMLButtonElement>('event-clear'),
    events: idx.events,
    onSelect: selectEvent,
  })
}

/** 選んだイベントの範囲へ寄せる。パネルの下に隠れないよう左側を広く取る。 */
function zoomToEvent(e: FloodEvent): void {
  const [west, south, east, north] = e.bounds
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding: isMobile ? 24 : { top: 40, bottom: 40, left: 360, right: 40 }, maxZoom: 15 },
  )
}

eventZoomEl.addEventListener('click', () => {
  const e = selectedEvent()
  if (e) zoomToEvent(e)
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
  applyHillshade()
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
  applyHillshade()
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

  if (!terrainOn) {
    // 傾きを戻すのは地形を外したあと。順序を逆にすると、平面へ戻る途中の
    // フレームでも地形メッシュを描き続けることになる。
    applyTerrain()
    if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: 600 })
    return
  }

  // 地形メッシュの生成・DEMタイルの取得・カメラの傾けを同時に走らせると、
  // その間フレームが落ちて操作が固まったように見える。地形が落ち着いてから傾ける。
  // 自分で戻した角度を勝手に上書きしないよう、水平のときだけ触る。
  applyTerrain()
  if (map.getPitch() === 0) {
    map.once('idle', () => {
      if (terrainOn && map.getPitch() === 0) map.easeTo({ pitch: 55, duration: 600 })
    })
  }
})

// setTerrain は地形メッシュを作り直す。スライダーの1目盛りごとに呼ぶと
// ドラッグ中に描画が追いつかないため、1フレームに1回へ束ねる。
let terrainExagScheduled = false
terrainExagEl.addEventListener('input', () => {
  terrainExag = Number(terrainExagEl.value)
  terrainExagValEl.textContent = terrainExag.toFixed(2)
  if (!terrainOn || terrainExagScheduled) return
  terrainExagScheduled = true
  requestAnimationFrame(() => {
    terrainExagScheduled = false
    if (terrainOn && map.getSource(DEM_TERRAIN)) {
      map.setTerrain({ source: DEM_TERRAIN, exaggeration: terrainExag })
    }
  })
})

const contoursOnEl = el<HTMLInputElement>('contours-on')
contoursOnEl.addEventListener('change', () => {
  contoursOn = contoursOnEl.checked
  applyContours()
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

/**
 * ホバーでカーソルを変える（マウス環境のみ）。
 *
 * mousemove は1秒に何十回も飛ぶ。浸水域は頂点数の多い大きなポリゴンが
 * 何重にも重なっているため、そのたびに地物取得を走らせると地図の描画が
 * 追いつかず、マウスを動かしているあいだ固まったように見える。
 * 1フレームに1回へ束ね、カメラが動いているあいだは見送る
 * （ドラッグ・ズーム中にカーソル形状を知る意味はない）。
 */
if (window.matchMedia('(hover: hover)').matches) {
  let pending: maplibregl.Point | null = null
  let scheduled = false

  const check = (): void => {
    scheduled = false
    const point = pending
    pending = null
    if (!point || map.isMoving() || map.isZooming() || map.isRotating()) return
    const ids = queryLayers()
    const hit = ids.length > 0 && map.queryRenderedFeatures(point, { layers: ids }).length > 0
    map.getCanvas().style.cursor = hit ? 'pointer' : ''
  }

  map.on('mousemove', (ev) => {
    pending = ev.point
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(check)
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
buildOriginModes()
renderLegend()
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
    buildEventPicker(idx)

    // `?event=` の復元。索引が来るまで対象イベントの実在を確かめられないため、
    // ここで初めて適用する。知らない値が来たらクエリごと捨てる。
    const restored = initialEvent && idx.events.find((e) => e.src === initialEvent)
    if (restored) {
      picker?.setSelected(restored.src)
      selectEvent(restored.src)
      // 位置ハッシュ付きのリンクは位置が明示されているので、そちらを尊重する
      if (!hadPositionHash) zoomToEvent(restored)
    } else {
      if (initialEvent) diag(`?event= のイベントが見つからない: ${initialEvent}`)
      writeEventParam(null)
    }

    renderLegend()
    renderEventNote()
  })
  .catch((err: unknown) => {
    diag(`events.json を読めない: ${String(err)}`)
    eventNoteEl.textContent =
      'イベント索引を読み込めませんでした（絞り込みは年と台風性のみ利用できます）。'
    const input = el<HTMLInputElement>('event-input')
    input.disabled = true
    input.placeholder = 'イベント索引を読み込めませんでした'
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
    applyLayers()
  },
  false,
)

map.on('error', (ev) => {
  const msg = (ev && (ev as unknown as { error?: Error }).error?.message) || 'map error'
  diag(`error: ${msg}`)
})

// デバッグ/外部連携用にマップを公開
;(window as unknown as { __map: maplibregl.Map }).__map = map
