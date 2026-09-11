import type { FillLayerSpecification, VectorSourceSpecification } from 'maplibre-gl'

/**
 * Mapterhorn の DEM 被覆（どの地点をどのソースの DEM が覆っているか）。
 *
 * 地形タイル自体は terrarium の標高値だけで、出典やメッシュサイズは埋め込まれていない。
 * 一方、段彩を「微地形 0〜5m」まで狭めたとき実際に窪地が出るかは、その地域の DEM の
 * 細かさで決まる。Mapterhorn が日本について持つのは基盤地図情報 DEM の 1m（部分的）/
 * 5m（平野部中心）/ 10m（全国）で、10m メッシュの地域では 10m 格子より細かい凹凸は
 * 元データに無い。画面上は同じように色が塗られるので、利用者には区別がつかない。
 *
 * Mapterhorn の Coverage ページが使っている被覆ベクトルタイル（各ソースの GeoTIFF を
 * 実データ範囲でポリゴン化したもの）を透明な塗りで載せ、`queryRenderedFeatures` で
 * 地点に重なるソースを集める。合成は「細かいソース優先で穴を粗いソースで埋める」規則
 * なので、**重なるソースのうち最も細かいものが、その地点で使われている DEM** になる。
 *
 * 実測（2026-09）: 江東・能登・北アルプス・人吉の z14 タイルには jpdem1a が入り、
 * 十勝は jpdem5a まで。どこにも jpdem10b と glo30 が敷かれている。
 */

export const COVERAGE_URL = 'https://single-archive-tiles.mapterhorn.com/coverage.json'
export const COVERAGE_SOURCE = 'dem-coverage'
export const COVERAGE_ID = 'dem-coverage'
export const COVERAGE_SOURCE_LAYER = 'coverage'

/** 被覆ポリゴンの `source` 属性の値 → メッシュサイズと名称。 */
export interface DemInfo {
  /** ソースの識別子（attribution.json の `source`）。 */
  code: string
  /** 水平分解能（m）。attribution.json の `resolution`。 */
  resolution: number
  /** 表示名。 */
  name: string
}

/**
 * 日本を覆うソースだけを持つ。値は https://download.mapterhorn.com/attribution.json 。
 * 表に無いソース（外国の DEM）が返ったときはコードをそのまま出す。
 */
const DEM_SOURCES: Record<string, Omit<DemInfo, 'code'>> = {
  jpdem1a: { resolution: 1, name: '基盤地図情報 DEM1A' },
  jpdem5a: { resolution: 5, name: '基盤地図情報 DEM5A' },
  jpdem5b: { resolution: 5, name: '基盤地図情報 DEM5B' },
  jpdem5c: { resolution: 5, name: '基盤地図情報 DEM5C' },
  jpdem10a: { resolution: 10, name: '基盤地図情報 DEM10A' },
  jpdem10b: { resolution: 10, name: '基盤地図情報 DEM10B' },
  // 全球の下敷き。日本の基盤地図情報が無いところ（海上や国外）で出る
  glo30: { resolution: 30, name: 'Copernicus GLO-30' },
}

export function demInfo(code: string): DemInfo {
  const known = DEM_SOURCES[code]
  return known ? { code, ...known } : { code, resolution: Number.NaN, name: code }
}

/**
 * 地点に重なるソースのうち最も細かいもの。分解能が分からないソースは後ろに回す。
 * 何も重なっていなければ null（被覆タイルが未読込か、被覆の外）。
 */
export function finestDem(codes: Iterable<string>): DemInfo | null {
  let best: DemInfo | null = null
  for (const code of new Set(codes)) {
    const info = demInfo(code)
    if (!best) {
      best = info
      continue
    }
    const a = Number.isNaN(info.resolution) ? Number.POSITIVE_INFINITY : info.resolution
    const b = Number.isNaN(best.resolution) ? Number.POSITIVE_INFINITY : best.resolution
    if (a < b) best = info
  }
  return best
}

/** 「1m メッシュ（基盤地図情報 DEM1A）」の形。 */
export function demLabel(info: DemInfo): string {
  if (Number.isNaN(info.resolution)) return info.name
  return `${info.resolution}m メッシュ（${info.name}）`
}

/**
 * その細かさで微地形が読めるかの一言。段彩のレンジを狭めても凹凸が出ないのは
 * 「窪地が無い」のではなく「DEM が粗い」のだと分かるようにする。
 */
export function demHint(info: DemInfo): string {
  const r = info.resolution
  if (Number.isNaN(r)) return ''
  if (r <= 1) return '数十cm〜数mの窪地まで読める'
  if (r <= 5) return '5m 格子より細かい凹凸は元データに無い'
  if (r <= 10) return '10m 格子より細かい凹凸は元データに無い。微地形レンジでも窪地は出ない'
  return '日本の基盤地図情報 DEM の範囲外（海上など）'
}

export function coverageSourceSpec(): VectorSourceSpecification {
  return { type: 'vector', url: COVERAGE_URL }
}

/**
 * 透明な塗り。描画には出さず、地点に重なるソースを問い合わせるためだけに置く。
 * `visibility: none` にすると queryRenderedFeatures の対象から外れるので、
 * 不透明度 0 で見えなくする。
 */
export function coverageLayer(): FillLayerSpecification {
  return {
    id: COVERAGE_ID,
    type: 'fill',
    source: COVERAGE_SOURCE,
    'source-layer': COVERAGE_SOURCE_LAYER,
    paint: { 'fill-color': '#000000', 'fill-opacity': 0 },
  }
}
