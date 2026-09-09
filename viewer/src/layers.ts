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

// ---- 成因（台風性 / 大雨・その他） ----
//
// 浸水域は年をまたいで何枚も重なるため、地図に持たせられる区別は多くない。
// 年代の階級で塗ると、重なった部分が「どの年代でもない濁った色」になって
// 階級の意味が消えるうえ、単一イベントを選ぶと凡例のほとんどが 0 件で並ぶ。
// 代わりに、水害の読み方として意味のある「台風性か、大雨・その他か」の2値だけを
// 色に持たせ、同じセグメントで絞り込みも兼ねる。
//
// 色は判別が検証済みのカテゴリ配色の1・2枠（青・オレンジ）。全ペアの色覚特性
// シミュレーション下の分離と、地図面に対するコントラストを満たす。
// 絞り込みで片方だけを表示しても色の意味は変えない（色は対象に従い、状態に従わない）。

const ORIGIN_COLORS: Record<Theme, { typhoon: string; other: string }> = {
  light: { typhoon: '#eb6834', other: '#2a78d6' },
  dark: { typhoon: '#d95926', other: '#3987e5' },
}

export type OriginMode = 'all' | 'typhoon' | 'other'

export const ORIGIN_MODES: { key: OriginMode; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'typhoon', label: '台風' },
  { key: 'other', label: '大雨・その他' },
]

/**
 * 成因が台風性かを判定する式。
 *
 * 災害名（`disastName`）に「台風」を含むものを台風性とする。名称が無い 37 件は
 * 元ファイル名の `_t` サフィックス（`typhoon_file`）で補う。
 *
 * ファイル名のフラグだけで判定すると、1ファイルに「大雨」と「台風第6号」が
 * 混在する 1961_06_s36 を取り違える（17件）。災害名はレコード単位なのでそこまで分かれる。
 *
 * `typhoon_file` は真偽値属性だが、MVT では 0/1 で来る実装もあるため to-boolean を通す。
 * scripts/build_events.py の `is_typhoon()` が同じ規則を実装しており、凡例の件数は
 * そちらが書き出した索引から数えている。**片方だけ変えると地図と凡例が食い違う。**
 */
const isTyphoonExpr = (): unknown => [
  'case',
  // 名称が空なら（null も coalesce で空に寄る）ファイル名のフラグで補う
  ['==', ['coalesce', ['get', 'disastName'], ''], ''],
  ['to-boolean', ['get', 'typhoon_file']],
  ['>=', ['index-of', '台風', ['coalesce', ['get', 'disastName'], '']], 0],
]

/** 凡例に並べる1項目。 */
export interface LegendItem {
  color: string
  label: string
  /** 該当件数（分かるものだけ）。 */
  count?: number
}

export interface OriginCounts {
  typhoon: number
  other: number
}

export function legendFor(
  origin: OriginMode,
  theme: Theme,
  counts?: OriginCounts,
): LegendItem[] {
  const c = ORIGIN_COLORS[theme]
  const typhoon: LegendItem = { color: c.typhoon, label: '台風', count: counts?.typhoon }
  const other: LegendItem = { color: c.other, label: '大雨・その他', count: counts?.other }
  switch (origin) {
    case 'all':
      return [typhoon, other]
    case 'typhoon':
      return [typhoon]
    case 'other':
      return [other]
  }
}

/** 塗り色の式。成因の絞り込み状態にかかわらず、色の意味は常に同じ。 */
const colorExpr = (theme: Theme): unknown => {
  const c = ORIGIN_COLORS[theme]
  return ['case', isTyphoonExpr(), c.typhoon, c.other]
}

// ---- 絞り込み ----

export interface FilterState {
  /** 成因。'all' なら両方を色で描き分ける。 */
  origin: OriginMode
  /** 単一イベント（元 Shapefile 名）に絞る。null なら全イベント。 */
  src: string | null
}

export const DEFAULT_FILTER: FilterState = { origin: 'all', src: null }

/**
 * 絞り込み式。既定（絞り込みなし）でも `all` を返すのは、レイヤーの filter を
 * 付け外しするとスタイル差分の適用で取りこぼしが出るため（常に同じ形にしておく）。
 * 引数ゼロの `["all"]` は真。
 */
export function filterExpr(f: FilterState): unknown {
  const parts: unknown[] = []
  if (f.origin === 'typhoon') parts.push(isTyphoonExpr())
  if (f.origin === 'other') parts.push(['!', isTyphoonExpr()])
  if (f.src) parts.push(['==', ['get', 'src_file'], f.src])
  return ['all', ...parts]
}

// ---- レイヤー ----

export const FILL_ID = 'sinsui_fill'
export const OUTLINE_ID = 'sinsui_outline'

/**
 * 塗りの既定不透明度。
 *
 * 浸水域は同じ場所で重なる（実測で中央値2枚・最大6枚）。同一レイヤー内の
 * 重なりはアルファが積算されるため、合成後の不透明度は 1-(1-a)^n になる。
 * a=0.6 では2枚重なるだけで 0.84、3枚で 0.94 に達し、そこから 1.0 まで
 * 上げても見た目が変わらない（スライダーの上半分が死ぬ）。
 * 積算後にちょうど背景が透ける 0.35 を既定にする。
 */
export const DEFAULT_OPACITY = 0.35

/** 輪郭を描き始めるズーム。これ未満は塗りだけ（理由は OUTLINE_ID のレイヤー定義）。 */
export const OUTLINE_MINZOOM = 9

export interface LayerOptions {
  theme: Theme
  filter: FilterState
  opacity: number
}

/**
 * 浸水実績のレイヤー。塗りと輪郭の2枚。
 * 輪郭を塗りと同色の不透明で描くことで、重なって混色した内側でも境界が読める。
 */
export function buildLayers(o: LayerOptions): LayerSpecification[] {
  const color = colorExpr(o.theme)
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
      // 広域では輪郭は 0.4px の毛のようになり、面を埋めるだけで境界を示さない。
      // にもかかわらず 14,585 件ぶんの線を組み立てて描くコストはかかるため、
      // 境界が意味を持つズームから出す（既定表示の z7 では塗りだけになる）。
      minzoom: OUTLINE_MINZOOM,
      filter: filterExpr(filter) as never,
      paint: {
        'line-color': color as never,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 1.4] as never,
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
 * 既定の見た目（成因で塗り分け・絞り込みなし）を静的なスタイルとして書き出せるようにする。
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
      ...buildLayers({ theme, filter: DEFAULT_FILTER, opacity: DEFAULT_OPACITY }),
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
