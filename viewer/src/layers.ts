import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl'
import type { Theme } from './theme'

/**
 * 浸水実績のベクトルタイル (PMTiles) の配信元。
 * 既定は同じ GitHub Pages 上の変換結果。焼き直したタイルを push 前に確認したい
 * 場合は `VITE_PMTILES_URL` でローカルの配信先に差し替える。
 *   VITE_PMTILES_URL=http://localhost:8080/sinsui_all.pmtiles npm run dev
 */
const PMTILES_URL =
  import.meta.env.VITE_PMTILES_URL ??
  'https://shiwaku.github.io/ksj-suigai-rireki-converter/output/sinsui_all.pmtiles'

/** convert.py が `layer="sinsui"` で書き出しているタイル内レイヤー名。 */
const SOURCE_LAYER = 'sinsui'

export const SOURCE_ID = 'sinsui'

/** convert.py の MINZOOM / MAXZOOM と対になっている。 */
export const TILE_MINZOOM = 4
export const TILE_MAXZOOM = 14

const SINSUI_ATTRIBUTION =
  '出典: <a href="https://nlftp.mlit.go.jp/ksj/" target="_blank" rel="noopener">国土数値情報（水害履歴・浸水実績）国土交通省</a>を加工して作成'

export const SOURCES: Record<string, SourceSpecification> = {
  [SOURCE_ID]: {
    type: 'vector',
    url: `pmtiles://${PMTILES_URL}`,
    attribution: SINSUI_ATTRIBUTION,
  },
}

// ---- 年代の配色 ----
//
// 年は順序を持つ量なので、色は「単一色相の明→暗」の順序尺度で表す（虹色は使わない）。
// 元データは 1896〜2019 年の 60 イベント。連続の内挿ではなく5区分の階級にしたのは、
// 凡例で年代を読み取れるようにするため。
//
// 階級ごとの色は青ランプから採り、順序尺度の検証（単一色相・明度単調・隣接段の
// 明度差 >= 0.06・最も背景に近い段が地図面に対して 2:1 以上）を通した組み合わせ。
// ライトは薄→濃、ダークは背景に沈まないよう濃→薄で、どちらも「新しい年ほど目立つ」。
// 段を入れ替えるときは配色の検証をやり直すこと。

/** 階級の下限（この値以上が次の階級）。build_events.py の YEAR_BINS と対になっている。 */
export const YEAR_BINS = [1950, 1970, 1980, 2000]

/** 凡例に出す階級ラベル。YEAR_BINS から機械的に作ると「〜1949」が作れないため持つ。 */
export const YEAR_BIN_LABELS = ['1896–1949', '1950–1969', '1970–1979', '1980–1999', '2000–2019']

const YEAR_COLORS: Record<Theme, string[]> = {
  light: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'],
  dark: ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#cde2fb'],
}

/** 台風性か否かの2値。カテゴリ配色の1・2枠（青・オレンジ）。 */
const TYPHOON_COLORS: Record<Theme, { typhoon: string; other: string }> = {
  light: { typhoon: '#eb6834', other: '#2a78d6' },
  dark: { typhoon: '#d95926', other: '#3987e5' },
}

/** 色分けなしの単色。年代や成因を問わず「浸水したかどうか」だけを見るとき用。 */
const PLAIN_COLOR: Record<Theme, string> = { light: '#2a78d6', dark: '#3987e5' }

export type ColorMode = 'year' | 'typhoon' | 'plain'

export const COLOR_MODES: { key: ColorMode; label: string }[] = [
  { key: 'year', label: '年代' },
  { key: 'typhoon', label: '台風性' },
  { key: 'plain', label: '単色' },
]

/** 凡例に並べる1項目。 */
export interface LegendItem {
  color: string
  label: string
  /** 該当件数（分かるものだけ）。 */
  count?: number
}

export function legendFor(mode: ColorMode, theme: Theme, binCounts?: number[]): LegendItem[] {
  switch (mode) {
    case 'year':
      return YEAR_BIN_LABELS.map((label, i) => ({
        color: YEAR_COLORS[theme][i],
        label,
        count: binCounts?.[i],
      }))
    case 'typhoon':
      return [
        { color: TYPHOON_COLORS[theme].typhoon, label: '台風性' },
        { color: TYPHOON_COLORS[theme].other, label: '豪雨・その他' },
      ]
    case 'plain':
      return [{ color: PLAIN_COLOR[theme], label: '浸水実績' }]
  }
}

/**
 * 塗り色の式。
 *
 * event_year はファイル名から付けた整数属性。タイル化の過程で欠けても
 * 落ちないよう coalesce で 0 に寄せる（最古の階級に入る）。
 * typhoon_file は真偽値属性だが、MVT では 0/1 で来る実装もあるため to-boolean を通す。
 */
function colorExpr(mode: ColorMode, theme: Theme): unknown {
  switch (mode) {
    case 'year': {
      const c = YEAR_COLORS[theme]
      const expr: unknown[] = [
        'step',
        ['coalesce', ['to-number', ['get', 'event_year']], 0],
        c[0],
      ]
      YEAR_BINS.forEach((edge, i) => expr.push(edge, c[i + 1]))
      return expr
    }
    case 'typhoon': {
      const c = TYPHOON_COLORS[theme]
      return ['case', ['to-boolean', ['get', 'typhoon_file']], c.typhoon, c.other]
    }
    case 'plain':
      return PLAIN_COLOR[theme]
  }
}

// ---- 絞り込み ----

export interface FilterState {
  /** 表示する年の下限・上限（両端を含む）。 */
  yearFrom: number
  yearTo: number
  /** 台風性のイベントだけに絞る。 */
  typhoonOnly: boolean
  /** 単一イベント（元 Shapefile 名）に絞る。null なら全イベント。 */
  src: string | null
}

export const YEAR_MIN = 1896
export const YEAR_MAX = 2019

export const DEFAULT_FILTER: FilterState = {
  yearFrom: YEAR_MIN,
  yearTo: YEAR_MAX,
  typhoonOnly: false,
  src: null,
}

/**
 * 絞り込み式。年の範囲は常に効かせ、台風性とイベント指定は指定時だけ加える。
 * 既定値でも `all` を返すのは、レイヤーの filter を付け外しすると
 * スタイル差分の適用で取りこぼしが出るため（常に同じ形にしておく）。
 */
export function filterExpr(f: FilterState): unknown {
  const year = ['coalesce', ['to-number', ['get', 'event_year']], 0]
  const parts: unknown[] = [
    ['>=', year, f.yearFrom],
    ['<=', year, f.yearTo],
  ]
  if (f.typhoonOnly) parts.push(['to-boolean', ['get', 'typhoon_file']])
  if (f.src) parts.push(['==', ['get', 'src_file'], f.src])
  return ['all', ...parts]
}

// ---- レイヤー ----

export const FILL_ID = 'sinsui_fill'
export const OUTLINE_ID = 'sinsui_outline'

/** 塗りの既定不透明度。浸水域は年をまたいで重なるため、下が透けるくらいに抑える。 */
export const DEFAULT_OPACITY = 0.6

export interface LayerOptions {
  mode: ColorMode
  theme: Theme
  filter: FilterState
  opacity: number
}

/**
 * 浸水実績のレイヤー。塗りと輪郭の2枚。
 * 輪郭を塗りと同色の不透明で描くことで、重なって混色した内側でも境界が読める。
 */
export function buildLayers(o: LayerOptions): LayerSpecification[] {
  const color = colorExpr(o.mode, o.theme)
  const filter = o.filter
  return [
    {
      id: FILL_ID,
      type: 'fill',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      minzoom: TILE_MINZOOM,
      filter: filterExpr(filter) as never,
      paint: {
        'fill-color': color as never,
        'fill-opacity': o.opacity,
        'fill-antialias': true,
      },
    },
    {
      id: OUTLINE_ID,
      type: 'line',
      source: SOURCE_ID,
      'source-layer': SOURCE_LAYER,
      minzoom: TILE_MINZOOM,
      filter: filterExpr(filter) as never,
      paint: {
        'line-color': color as never,
        // 広域では輪郭が面を埋めてしまうため、ズームに応じて細く始める
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 10, 0.8, 14, 1.4] as never,
        'line-opacity': Math.min(1, o.opacity + 0.3),
      },
    },
  ]
}

// ---- 静的スタイルの書き出し ----

/**
 * 浸水実績だけで完結する MapLibre スタイル。
 *
 * ビューワは背景地図・テーマ・絞り込みを実行時に組み替えるためレイヤーを
 * コードで作っているが、そのままでは QGIS や Maputnik に渡せない。
 * 既定の見た目（年代色・絞り込みなし）を静的なスタイルとして書き出せるようにする。
 * 呼び出しは scripts/export-style.mjs から。
 */
export function buildStyle(theme: Theme = 'light'): StyleSpecification {
  return {
    version: 8,
    name: `水害履歴・浸水実績（${theme === 'dark' ? 'ダーク' : 'ライト'}）`,
    metadata: {
      'ksj-suigai-rireki:generated-by': 'viewer/scripts/export-style.mjs',
      'ksj-suigai-rireki:source': 'viewer/src/layers.ts の buildStyle()',
      'ksj-suigai-rireki:note':
        '生成物。直接編集せず viewer/src/layers.ts を直して書き出し直すこと。',
    },
    sources: SOURCES,
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': theme === 'dark' ? '#14161a' : '#ffffff' },
      },
      ...buildLayers({
        mode: 'year',
        theme,
        filter: DEFAULT_FILTER,
        opacity: DEFAULT_OPACITY,
      }),
    ],
  }
}

// ---- ポップアップ ----

const ATTR_LABELS: Record<string, string> = {
  id: 'ID',
  code: '種別コード',
  name: '種別',
  date: '発生年月日（原データ）',
  date_iso: '発生年月日',
  source: '出典資料',
  disastName: '災害名',
  event_year: 'イベント年',
  event_month: 'イベント月',
  era_label: '元号ラベル',
  typhoon_file: '台風性（ファイル名由来）',
  src_file: '元ファイル',
}

/** 表示順。原データの属性を先に、変換で付けた属性を後に置く。 */
const ATTR_ORDER = [
  'disastName',
  'date_iso',
  'name',
  'code',
  'source',
  'event_year',
  'event_month',
  'era_label',
  'typhoon_file',
  'date',
  'id',
  'src_file',
]

export interface PopupItem {
  props: Record<string, unknown>
}

/** 1回のクリックで表示する地物数の上限。これを超えた分は件数だけ知らせる。 */
export const POPUP_MAX_ITEMS = 12

const escapeHtml = (v: unknown): string =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

const formatValue = (key: string, v: unknown): string => {
  if (key === 'typhoon_file') return v === true || v === 1 || v === 'true' ? 'はい' : 'いいえ'
  return escapeHtml(v)
}

/**
 * クリック時のポップアップ本文。重なっている浸水域をすべて並べる。
 * 浸水実績は年をまたいで何枚も重なるため、1件だけ返して終わりにはしない。
 */
export function popupHtml(items: PopupItem[], total = items.length): string {
  const row = (key: string, v: unknown): string =>
    `<tr><th>${escapeHtml(ATTR_LABELS[key] ?? key)}</th><td>${formatValue(key, v)}</td></tr>`

  const section = (item: PopupItem): string => {
    const props = item.props
    const keys = [
      ...ATTR_ORDER.filter((k) => k in props),
      ...Object.keys(props).filter((k) => !ATTR_ORDER.includes(k)),
    ]
    const rows = keys
      .filter((k) => props[k] !== null && props[k] !== undefined && props[k] !== '')
      .map((k) => row(k, props[k]))
      .join('')
    const head =
      items.length > 1
        ? `<h4 class="pop-item-head">${escapeHtml(
            props.disastName ?? props.date_iso ?? props.src_file ?? '浸水域',
          )}</h4>`
        : ''
    return `<section class="pop-item">${head}<table class="pop-tbl">${rows}</table></section>`
  }

  const head =
    items.length > 1
      ? `${total}件の浸水域${total > items.length ? `（うち${items.length}件を表示）` : ''}`
      : '浸水実績'
  return `<div class="pop"><div class="pop-head">${escapeHtml(head)}</div><div class="pop-body">${items
    .map(section)
    .join('')}</div></div>`
}
