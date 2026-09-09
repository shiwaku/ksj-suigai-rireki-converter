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
 * 置き換えている（理由は RELIEF_LUT のコメント）。
 */

export const RELIEF_SOURCE = 'relief'
export const RELIEF_ID = 'relief'
export const RELIEF_PROTOCOL = 'relief'

/** 段彩の既定不透明度。背景地図の地名や水系が透ける程度に抑える。 */
export const DEFAULT_RELIEF_OPACITY = 0.55

/**
 * 標高の色。国土地理院の点群タイル閲覧サイトの既定値（全国Q地図由来）。
 *
 * `from` はその色を割り当てる標高の下限（m）。日本の地形図で見慣れた
 * 「低地は青緑 → 平野は緑 → 山地は黄〜茶 → 高山は白」の配色で、
 * 浸水実績を読む用途にも都合がよい: 標高 0m 前後（濃尾平野南部や
 * 弥富のような海抜0m地帯）が青寄りに出るため、低平地が一目で分かる。
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

/** 凡例に出す段彩の帯（下限標高と色）。 */
export const RELIEF_LEGEND = TINTS.map((t) => ({
  from: t.from,
  color: `rgb(${t.color[0]},${t.color[1]},${t.color[2]})`,
}))

/** 標高（m）から色を線形補間で引く。 */
function tintAt(h: number): [number, number, number] {
  if (h <= TINTS[0].from) return TINTS[0].color
  for (let i = 1; i < TINTS.length; i++) {
    if (h < TINTS[i].from) {
      const lo = TINTS[i - 1]
      const hi = TINTS[i]
      const t = (h - lo.from) / (hi.from - lo.from)
      return [
        lo.color[0] + t * (hi.color[0] - lo.color[0]),
        lo.color[1] + t * (hi.color[1] - lo.color[1]),
        lo.color[2] + t * (hi.color[2] - lo.color[2]),
      ]
    }
  }
  return TINTS[TINTS.length - 1].color
}

/**
 * 標高 → 色のルックアップテーブル。
 *
 * terrarium は `標高 = (r<<8) + g + b/256 - 32768`。上位2バイト `(r<<8)|g` は
 * そのまま 0〜65535 の添字になり、1m 刻みの標高に対応する。段彩の色は 1m 未満の
 * 差を持たないので、b（サブメートル）は捨ててよい。
 *
 * これを事前計算しておくと、1タイル 512×512 = 26万ピクセルの走査が
 * 「配列3回読み」だけになる。参照実装のようにピクセルごとに色の帯を線形探索
 * すると分岐と乗算が26万回走り、タイルが増えたときに描画が詰まる。
 * テーブルは 65536×3 = 192KB で、初回に一度だけ作る。
 */
let RELIEF_LUT: Uint8Array | null = null

function lut(): Uint8Array {
  if (RELIEF_LUT) return RELIEF_LUT
  const t = new Uint8Array(65536 * 3)
  for (let i = 0; i < 65536; i++) {
    const [r, g, b] = tintAt(i - 32768)
    t[i * 3] = r
    t[i * 3 + 1] = g
    t[i * 3 + 2] = b
  }
  RELIEF_LUT = t
  return t
}

/**
 * 標高（m）に対して、実際にタイルへ書かれる色を返す。
 *
 * colorize と同じ経路（terrarium の上位2バイト → ルックアップテーブル）を通る。
 * colorize 自体は OffscreenCanvas / createImageBitmap に依存してブラウザ外で
 * 動かせないため、配色が静かに壊れるのを防ぐ検証はここを通して行う
 * （scripts/check-relief.mjs）。
 */
export function reliefColorAt(h: number): [number, number, number] {
  const table = lut()
  // terrarium で標高 h が入るバイト列: (r<<8)|g = round(h) + 32768
  const idx = Math.min(65535, Math.max(0, Math.round(h) + 32768)) * 3
  return [table[idx], table[idx + 1], table[idx + 2]]
}

/** terrarium の DEM タイル1枚を段彩の RGBA タイルに置き換える。 */
async function colorize(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([buffer]))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  const table = lut()
  for (let i = 0; i < d.length; i += 4) {
    const idx = ((d[i] << 8) | d[i + 1]) * 3
    d[i] = table[idx]
    d[i + 1] = table[idx + 1]
    d[i + 2] = table[idx + 2]
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
 * `relief://<DEMタイルのURL>` を登録する。地図の生成前に一度だけ呼ぶ。
 * DEM の取得先は陰影起伏・3D地形と同じ Mapterhorn の ZXY エンドポイント。
 */
export function registerReliefProtocol(maplibre: MaplibreLike): void {
  maplibre.addProtocol(
    RELIEF_PROTOCOL,
    async (params: { url: string }, abortController: AbortController) => {
      const url = params.url.replace(`${RELIEF_PROTOCOL}://`, '')
      const res = await fetch(url, { signal: abortController.signal })
      if (!res.ok) return { data: null }
      return { data: await colorize(await res.arrayBuffer()) }
    },
  )
}

export function reliefSourceSpec(): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: [`${RELIEF_PROTOCOL}://${ZXY_TEMPLATE}`],
    tileSize: 512,
    // 段彩は面の色なので、深いズームまで焼き直す必要はない。ここを上げるほど
    // 変換するタイルが増える。z13 以降は overzoom で伸ばす。
    maxzoom: 13,
    attribution: MAPTERHORN_ATTRIBUTION,
  }
}

export function reliefLayer(opacity: number): LayerSpecification {
  return {
    id: RELIEF_ID,
    type: 'raster',
    source: RELIEF_SOURCE,
    paint: { 'raster-opacity': opacity },
  } as LayerSpecification
}
