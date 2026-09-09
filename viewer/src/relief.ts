import type { LayerSpecification, RasterSourceSpecification } from 'maplibre-gl'
import { MAPTERHORN_ATTRIBUTION, ZXY_TEMPLATE } from './terrain'

/**
 * 段彩図（標高を色で塗り分けたラスタ）。陰影起伏の下に敷いて陰影段彩図にする。
 *
 * MapLibre には標高を直接色に写すレイヤーが無いため、DEM タイルを取得して
 * ピクセルごとに標高を読み、色に置き換えたラスタタイルを返すカスタムプロトコルで
 * 実現する。方式は国土地理院の点群タイル閲覧サイト
 * （gsi-cyberjapan/3dpc-3dtiles）の実装に倣う。
 *
 * ピクセル走査の実装は下記に由来する:
 *   Copyright 2024 全国Ｑ地図管理者 / MIT license
 *   https://github.com/qchizu/qchizu_maplibre/blob/main/LISENCE.md
 * 参照元は GSI 独自エンコードの標高タイルを対象にしているが、ここでは
 * Mapterhorn の terrarium タイルを読む。色の引き当てはルックアップテーブルに
 * 置き換えている（理由は lut() のコメント）。
 */

export const RELIEF_SOURCE = 'relief'
export const RELIEF_ID = 'relief'
export const RELIEF_PROTOCOL = 'relief'

/** 段彩の既定不透明度。背景地図の地名や水系が透ける程度に抑える。 */
export const DEFAULT_RELIEF_OPACITY = 0.55

/**
 * 標高の色。国土地理院の点群タイル閲覧サイトの既定値（全国Ｑ地図由来）。
 *
 * `from` は「全国」レンジでその色を割り当てる標高の下限（m）。日本の地形図で
 * 見慣れた「低地は青緑 → 平野は緑 → 山地は黄〜茶 → 高山は白」の配色。
 */
const TINTS: { from: number; color: [number, number, number] }[] = [
  { from: -10, color: [83, 135, 148] },
  { from: 0, color: [83, 135, 148] },
  { from: 1, color: [0, 204, 204] },
  { from: 10, color: [128, 215, 255] },
  { from: 30, color: [191, 255, 191] },
  { from: 60, color: [117, 255, 117] },
  { from: 140, color: [73, 179, 2] },
  { from: 300, color: [255, 255, 0] },
  { from: 600, color: [253, 164, 32] },
  { from: 900, color: [217, 109, 0] },
  { from: 1100, color: [163, 87, 10] },
  { from: 1500, color: [148, 107, 64] },
  { from: 2000, color: [143, 132, 122] },
  { from: 2500, color: [187, 181, 175] },
  { from: 3000, color: [230, 229, 227] },
  { from: 4000, color: [255, 255, 255] },
]

type Stop = { from: number; color: [number, number, number] }

// ---- 標高レンジ ----
//
// 「全国」の配色は -10〜4000m を16段で塗る。山地を含む広域では正しいが、
// 低地の内水浸水の原因を読むには使えない。標高 0〜10m の氾濫平野は 2 段に
// 収まってしまい、内水を溜める微小な窪地（数十cm〜数mの凹み）が現れない。
//
// そこでレンジを選べるようにし、指定レンジでは16色を等間隔に引き伸ばす。
// 0〜5m なら 1 段あたり約 33cm になり、微地形が読める。
//
// Mapterhorn は日本について国土地理院の基盤地図情報 DEM
// （DEM1A = 1mメッシュ、DEM5A/5B/5C = 5mメッシュ、DEM10A/10B = 10mメッシュ）を
// 含んでいるので、水平分解能もこれに耐える。

export interface ReliefRange {
  key: string
  label: string
  /** 'abs' は TINTS の絶対標高をそのまま使う。'linear' は16色を min〜max に等間隔で割る。 */
  mode: 'abs' | 'linear'
  min: number
  max: number
  /** 凡例の目盛りの小数桁。レンジが狭いほど桁を増やさないと段の境界が読めない。 */
  decimals: number
}

export const RELIEF_RANGES: ReliefRange[] = [
  { key: 'all', label: '全国（地形図の絶対標高）', mode: 'abs', min: -10, max: 4000, decimals: 0 },
  { key: 'mountain', label: '山地 0〜1000m', mode: 'linear', min: 0, max: 1000, decimals: 0 },
  { key: 'plain', label: '平野 0〜100m', mode: 'linear', min: 0, max: 100, decimals: 0 },
  { key: 'lowland', label: '低地 0〜20m', mode: 'linear', min: 0, max: 20, decimals: 1 },
  { key: 'micro', label: '微地形 0〜5m（窪地）', mode: 'linear', min: 0, max: 5, decimals: 2 },
]

/** 内水浸水の原因把握が主目的なので、既定は微地形が読めるレンジにする。 */
export const DEFAULT_RELIEF_RANGE = RELIEF_RANGES[3]

export const reliefRangeByKey = (key: string): ReliefRange =>
  RELIEF_RANGES.find((r) => r.key === key) ?? DEFAULT_RELIEF_RANGE

/**
 * レンジに応じた色の帯。凡例と LUT の両方がこれを使う。
 *
 * 引き伸ばすときは先頭の色を1つ落として 15 色にする。TINTS の -10m と 0m は
 * 意図的に同色（海面下と海面を同じ色で塗る）で、そのまま等間隔に割ると
 * 最下段の2段が同色になり、レンジの下端——低地でいちばん見たい足元——が
 * 1段ぶん潰れてしまう。
 */
export function reliefStops(range: ReliefRange): Stop[] {
  if (range.mode === 'abs') return TINTS
  const colors = TINTS.slice(1).map((t) => t.color)
  const span = range.max - range.min
  return colors.map((color, i) => ({
    from: range.min + (span * i) / (colors.length - 1),
    color,
  }))
}

/** 凡例に出す帯。 */
export function reliefLegend(range: ReliefRange): { from: number; color: string }[] {
  return reliefStops(range).map((t) => ({
    from: t.from,
    color: `rgb(${t.color[0]},${t.color[1]},${t.color[2]})`,
  }))
}

/** 標高（m）から色を線形補間で引く。 */
function tintAt(h: number, stops: Stop[]): [number, number, number] {
  if (h <= stops[0].from) return stops[0].color
  for (let i = 1; i < stops.length; i++) {
    if (h < stops[i].from) {
      const lo = stops[i - 1]
      const hi = stops[i]
      const t = (h - lo.from) / (hi.from - lo.from)
      return [
        lo.color[0] + t * (hi.color[0] - lo.color[0]),
        lo.color[1] + t * (hi.color[1] - lo.color[1]),
        lo.color[2] + t * (hi.color[2] - lo.color[2]),
      ]
    }
  }
  return stops[stops.length - 1].color
}

/**
 * 標高 → 色のルックアップテーブル。レンジごとに一度だけ作って使い回す。
 *
 * 当初は terrarium の上位2バイト `(r<<8)|g` をそのまま添字にしていた。実装は
 * 単純だが、これは **標高を 1m に丸める**ことになる。微小な窪地を読むには
 * 致命的なので、`b`（1/256m）まで含めて標高を復元してから引く。
 *
 * ピクセルごとに色の帯を線形探索すると、1タイル 512×512 = 26万回の分岐と乗算が
 * 走ってタイルが増えたときに描画が詰まる。テーブルなら「配列3回読み」で済む。
 *
 * 段数はレンジの幅から決め、**どのレンジでも標高 1cm 刻み**になるようにする。
 * 固定段数（当初 4096 段）にすると、-10〜4000m の「全国」レンジでは 1 段が約 1m に
 * なり、0〜1m や 1〜10m といった細い帯の境界を踏み外して凡例と色が食い違った。
 * 1cm は基盤地図情報 DEM の標高精度（DEM5A / DEM1A で ±0.3m 程度）より十分細かい。
 */
const LUT_RESOLUTION_M = 0.01
/** 段数の上限。全国レンジ（4010m）でも 40 万段 = 1.2MB で収まる。 */
const LUT_MAX_STEPS = 400_001

const lutCache = new Map<string, Uint8Array>()

/** そのレンジの LUT の段数。 */
function lutSteps(range: ReliefRange): number {
  const span = range.max - range.min
  return Math.min(LUT_MAX_STEPS, Math.round(span / LUT_RESOLUTION_M) + 1)
}

function lut(range: ReliefRange): Uint8Array {
  const key = `${range.mode}:${range.min}:${range.max}`
  const hit = lutCache.get(key)
  if (hit) return hit
  const stops = reliefStops(range)
  const steps = lutSteps(range)
  const t = new Uint8Array(steps * 3)
  const span = range.max - range.min
  for (let i = 0; i < steps; i++) {
    const [r, g, b] = tintAt(range.min + (span * i) / (steps - 1), stops)
    t[i * 3] = r
    t[i * 3 + 1] = g
    t[i * 3 + 2] = b
  }
  lutCache.set(key, t)
  return t
}

/**
 * 標高（m）に対して、実際にタイルへ書かれる色を返す。
 *
 * colorize と同じ経路（レンジの LUT）を通る。colorize 自体は OffscreenCanvas /
 * createImageBitmap に依存してブラウザ外で動かせないため、配色が静かに壊れるのを
 * 防ぐ検証はここを通して行う（scripts/check-relief.mjs）。
 */
export function reliefColorAt(
  h: number,
  range: ReliefRange = DEFAULT_RELIEF_RANGE,
): [number, number, number] {
  const table = lut(range)
  const last = lutSteps(range) - 1
  const t = ((h - range.min) / (range.max - range.min)) * last
  const i = (t < 0 ? 0 : t > last ? last : Math.round(t)) * 3
  return [table[i], table[i + 1], table[i + 2]]
}

/** terrarium の DEM タイル1枚を段彩の RGBA タイルに置き換える。 */
async function colorize(buffer: ArrayBuffer, range: ReliefRange): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([buffer]))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  const table = lut(range)
  const lo = range.min
  const last = lutSteps(range) - 1
  const scale = last / (range.max - range.min)
  for (let i = 0; i < d.length; i += 4) {
    // terrarium: 標高 = (r<<8) + g + b/256 - 32768。b まで使って 1/256m まで復元する。
    const h = ((d[i] << 8) | d[i + 1]) + d[i + 2] / 256 - 32768
    let t = (h - lo) * scale
    t = t < 0 ? 0 : t > last ? last : t
    // t >= 0 が保証されているので、Math.round より速い切り捨てで丸める
    const p = ((t + 0.5) | 0) * 3
    d[i] = table[p]
    d[i + 1] = table[p + 1]
    d[i + 2] = table[p + 2]
    // 海面下も塗る。海抜0m地帯こそ浸水実績を読むうえで見たい場所なので、
    // 「標高0以下は透明」にはしない。全体の透け具合はレイヤーの
    // raster-opacity で調整する。
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return blob.arrayBuffer()
}

/** MapLibre 名前空間のうち、ここで必要な部分だけ（terrain.ts と同じ理由で緩く受ける）。 */
interface MaplibreLike {
  addProtocol(name: string, fn: (...args: any[]) => any): void
}

/**
 * `relief://<mode>/<min>/<max>/<DEMタイルのURL>` を登録する。地図の生成前に一度だけ呼ぶ。
 * DEM の取得先は陰影起伏・3D地形と同じ Mapterhorn の ZXY エンドポイント。
 *
 * レンジを URL に埋めるのは、MapLibre がタイルを URL でキャッシュするため。
 * モジュール変数で持つと、レンジを変えても古い色のタイルが残ってしまう。
 */
export function registerReliefProtocol(maplibre: MaplibreLike): void {
  maplibre.addProtocol(
    RELIEF_PROTOCOL,
    async (params: { url: string }, abortController: AbortController) => {
      const rest = params.url.replace(`${RELIEF_PROTOCOL}://`, '')
      const [mode, min, max, ...urlParts] = rest.split('/')
      const range: ReliefRange = {
        key: 'url',
        label: '',
        mode: mode === 'abs' ? 'abs' : 'linear',
        min: Number(min),
        max: Number(max),
        decimals: 0,
      }
      const res = await fetch(urlParts.join('/'), { signal: abortController.signal })
      if (!res.ok) return { data: null }
      return { data: await colorize(await res.arrayBuffer(), range) }
    },
  )
}

export function reliefSourceSpec(range: ReliefRange): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: [`${RELIEF_PROTOCOL}://${range.mode}/${range.min}/${range.max}/${ZXY_TEMPLATE}`],
    tileSize: 512,
    // 微小な窪地を読むには DEM の細かさが要る。Mapterhorn が持つ基盤地図情報 DEM
    // （1m / 5m メッシュ）の細かさは深いズームにしか現れない。ここを上げるほど
    // 色に変換するタイルが増えるので、微地形が読める z15 までにする
    // （それより深いズームは overzoom で伸ばす）。
    maxzoom: 15,
    attribution: MAPTERHORN_ATTRIBUTION,
  }
}

export function reliefLayer(opacity: number): LayerSpecification {
  return {
    id: RELIEF_ID,
    type: 'raster',
    source: RELIEF_SOURCE,
    paint: {
      'raster-opacity': opacity,
      // 補間で隣接ピクセルが混ざると、窪地の縁と 1 段の差がぼやける
      'raster-resampling': 'nearest',
    },
  } as LayerSpecification
}
