import { Protocol } from 'pmtiles'
import mlcontour from 'maplibre-contour'
import type {
  LayerSpecification,
  RasterDEMSourceSpecification,
  VectorSourceSpecification,
} from 'maplibre-gl'

/**
 * Mapterhorn の全球地形タイル（terrarium エンコードの標高ラスタ）を
 * 陰影起伏 / 3D地形 / 等高線として重ねる。
 *
 * 実装は shiwaku/mapterhorn-viewer（Mapterhorn 公式サンプルを統合したもの）に倣う。
 * 浸水実績は地形の低いところに集まるため、背景地図の等高線より濃い間隔で
 * 起伏が読めると氾濫の広がりを追いやすい。
 */

export const TILEJSON_URL = 'https://tiles.mapterhorn.com/tilejson.json'
export const ZXY_TEMPLATE = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
export const PMTILES_BASE = 'https://download.mapterhorn.com'

export const MAPTERHORN_ATTRIBUTION =
  '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">© Mapterhorn</a>'

/** DEM タイルのネイティブズーム（z13〜z17 のアーカイブがある）。これより先は overzoom。 */
const DEM_MAX_ZOOM = 17

/** DEM タイルの配信方式。Mapterhorn 公式サンプルの3通りに対応する。 */
export type DemMode = 'tilejson' | 'zxy' | 'pmtiles'

export const DEM_MODES: { key: DemMode; label: string }[] = [
  { key: 'tilejson', label: 'TileJSON' },
  { key: 'zxy', label: 'ZXY' },
  { key: 'pmtiles', label: 'PMTiles' },
]

/** MapLibre 5.6 の陰影起伏の算出方法。 */
export type HillshadeMethod = 'igor' | 'standard' | 'basic' | 'combined' | 'multidirectional'

export const HILLSHADE_METHODS: { key: HillshadeMethod; label: string }[] = [
  { key: 'standard', label: 'standard（既定）' },
  { key: 'igor', label: 'igor（やわらか）' },
  { key: 'basic', label: 'basic' },
  { key: 'combined', label: 'combined' },
  { key: 'multidirectional', label: 'multidirectional' },
]

/** multidirectional の配列指定は 5.6 の paint 型に無いため緩く持つ。 */
type HillshadePaint = Record<string, unknown>

/**
 * 算出方法ごとの paint プリセット。値は Mapterhorn / MapLibre の公式サンプル由来。
 * exaggeration はその方法を選んだときに UI が読み込む初期値で、その後はスライダーが上書きする。
 */
export const HILLSHADE_PRESETS: Record<
  HillshadeMethod,
  { exaggeration: number; paint: HillshadePaint }
> = {
  igor: {
    exaggeration: 0.2,
    paint: {
      'hillshade-highlight-color': 'rgb(255, 255, 228)',
      'hillshade-shadow-color': 'rgb(114, 124, 131)',
    },
  },
  standard: {
    exaggeration: 0.5,
    paint: { 'hillshade-shadow-color': '#473B24' },
  },
  basic: { exaggeration: 0.5, paint: {} },
  combined: { exaggeration: 0.5, paint: {} },
  multidirectional: {
    exaggeration: 0.5,
    paint: {
      'hillshade-highlight-color': ['#FF4000', '#FFFF00', '#40FF00', '#00FF80'],
      'hillshade-shadow-color': ['#00BFFF', '#0000FF', '#BF00FF', '#FF0080'],
      'hillshade-illumination-direction': [270, 315, 0, 45],
      'hillshade-illumination-altitude': [30, 30, 30, 30],
    },
  },
}

// MapLibre は陰影起伏と3D地形で raster-dem ソースを分けることを推奨している。
export const DEM_HILLSHADE = 'dem-hillshade'
export const DEM_TERRAIN = 'dem-terrain'
export const CONTOUR_SOURCE = 'contours'

export const HILLSHADE_ID = 'hillshade'
/** 等高線を描き始めるズーム。 */
export const CONTOUR_MINZOOM = 10
/** 標高の数字を描き始めるズーム。 */
export const CONTOUR_TEXT_MINZOOM = 12

export const CONTOUR_LINE_ID = 'contour-lines'
export const CONTOUR_TEXT_ID = 'contour-text'

/**
 * MapLibre 名前空間のうち、ここで必要な部分だけ。
 * addProtocol のシグネチャは maplibre-gl と maplibre-contour で型が噛み合わないため、
 * 上流サンプルと同じく緩く受ける（実体は maplibregl 名前空間そのもの）。
 */
interface MaplibreLike {
  addProtocol(name: string, fn: (...args: any[]) => any): void
}

let demSource: InstanceType<typeof mlcontour.DemSource> | null = null

/**
 * PMTiles ルーティングと maplibre-contour の DEM デコーダを登録する。
 * 地図の生成前に一度だけ呼ぶ。
 */
export function registerTerrainProtocols(maplibre: MaplibreLike): void {
  // `mapterhorn://{z}/{x}/{y}` を planet アーカイブ（z<=12）か対応する z6 アーカイブ
  // （z>=13）へ振り分け、download.mapterhorn.com への Range Request で読む。
  const protocol = new Protocol({ metadata: true, errorOnMissingTile: true })
  maplibre.addProtocol('mapterhorn', (async (params: { url: string }, abortController: unknown) => {
    const [z, x, y] = params.url.replace('mapterhorn://', '').split('/').map(Number)
    const name = z <= 12 ? 'planet' : `6-${x >> (z - 6)}-${y >> (z - 6)}`
    const url = `pmtiles://${PMTILES_BASE}/${name}.pmtiles/${z}/${x}/${y}.webp`
    const response = (await protocol.tile(
      { ...params, url } as never,
      abortController as never,
    )) as { data: unknown }
    if (response.data === null) throw new Error(`Tile z=${z} x=${x} y=${y} not found.`)
    return response
  }) as never)

  // DemSource は DEM タイルを自前の HTTP で取るため MapLibre のプロトコルを経由できない。
  // したがって等高線は配信方式の選択にかかわらず常に ZXY エンドポイントを読む。
  demSource = new mlcontour.DemSource({
    url: ZXY_TEMPLATE,
    encoding: 'terrarium',
    // 上流サンプルと同じ 12。ここを深くすると等高線をより細かく刻めるが、
    // 生成するセグメント数が跳ね上がり、3D地形と併用したときに描画が追いつかない。
    maxzoom: 12,
    worker: true,
  })
  demSource.setupMaplibre(maplibre as never)
}

/** 選んだ配信方式の raster-dem ソース定義。 */
export function demSourceSpec(mode: DemMode): RasterDEMSourceSpecification {
  switch (mode) {
    case 'tilejson':
      // encoding / tileSize は TileJSON 側の記述に従う。
      return { type: 'raster-dem', url: TILEJSON_URL, attribution: MAPTERHORN_ATTRIBUTION }
    case 'zxy':
      return {
        type: 'raster-dem',
        tiles: [ZXY_TEMPLATE],
        encoding: 'terrarium',
        tileSize: 512,
        maxzoom: DEM_MAX_ZOOM,
        attribution: MAPTERHORN_ATTRIBUTION,
      }
    case 'pmtiles':
      return {
        type: 'raster-dem',
        tiles: ['mapterhorn://{z}/{x}/{y}'],
        encoding: 'terrarium',
        tileSize: 512,
        maxzoom: DEM_MAX_ZOOM,
        attribution: MAPTERHORN_ATTRIBUTION,
      }
  }
}

/** DEM から生成した等高線のベクトルソース。 */
export function contourSourceSpec(): VectorSourceSpecification {
  if (!demSource) throw new Error('registerTerrainProtocols() を先に呼ぶこと')
  return {
    type: 'vector',
    tiles: [
      demSource.contourProtocolUrl({
        // [補助間隔, 主曲線間隔]（m）。
        //
        // 当初は低平地の氾濫域を読むため z15 で 10m / 50m まで刻んでいたが、
        // 起伏の小さい平野では 10m 刻みが延々と蛇行する線になり、1タイルあたりの
        // セグメント数が跳ね上がる。3D地形と併用すると描画が追いつかなくなるため、
        // 上流サンプルの範囲に戻し、最深部だけ 1 段細かくする。
        thresholds: {
          11: [200, 1000],
          13: [100, 500],
          14: [20, 100],
        },
        elevationKey: 'ele',
        levelKey: 'level',
        contourLayer: 'contours',
        buffer: 1,
        overzoom: 2,
      }),
    ],
    // DemSource の maxzoom(12) + overzoom(2)。これより深いズームは overzoom で見る。
    maxzoom: 14,
    attribution: MAPTERHORN_ATTRIBUTION,
  }
}

export function hillshadeLayer(
  method: HillshadeMethod,
  exaggeration: number,
): LayerSpecification {
  return {
    id: HILLSHADE_ID,
    type: 'hillshade',
    source: DEM_HILLSHADE,
    paint: {
      'hillshade-method': method,
      'hillshade-exaggeration': exaggeration,
      ...HILLSHADE_PRESETS[method].paint,
    },
  } as unknown as LayerSpecification
}

/** 等高線。文字色はテーマで振り、淡色地図とダーク背景の両方で読めるようにする。 */
export function contourLayers(theme: 'light' | 'dark'): LayerSpecification[] {
  const line = theme === 'dark' ? 'rgb(196, 148, 84)' : 'rgb(184, 129, 51)'
  const text = theme === 'dark' ? 'rgb(222, 180, 120)' : 'rgb(140, 97, 36)'
  const halo = theme === 'dark' ? 'rgba(10,12,16,0.85)' : 'rgba(255,255,255,0.9)'
  return [
    {
      id: CONTOUR_LINE_ID,
      type: 'line',
      source: CONTOUR_SOURCE,
      'source-layer': 'contours',
      // 広域では線が詰まって地形が読めないうえ、生成コストだけがかかる
      minzoom: CONTOUR_MINZOOM,
      paint: {
        'line-color': line,
        'line-width': ['match', ['get', 'level'], 1, 1, 0.5] as never,
        'line-opacity': 0.8,
      },
    },
    {
      id: CONTOUR_TEXT_ID,
      type: 'symbol',
      source: CONTOUR_SOURCE,
      'source-layer': 'contours',
      // 標高の数字は文字配置の計算が要る。読める大きさになるズームまで出さない。
      minzoom: CONTOUR_TEXT_MINZOOM,
      // 主曲線だけに標高を振る。補助曲線にも振ると平野で数字が埋まる。
      filter: ['==', ['get', 'level'], 1] as never,
      layout: {
        'symbol-placement': 'line',
        'text-size': 11,
        'text-field': ['concat', ['number-format', ['get', 'ele'], {}], 'm'] as never,
        'text-font': ['NotoSansJP-Regular'],
      },
      paint: {
        'text-color': text,
        'text-halo-color': halo,
        'text-halo-width': 1.5,
      },
    },
  ]
}
