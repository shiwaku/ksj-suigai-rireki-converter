import type { StyleSpecification } from 'maplibre-gl'
import type { Theme } from './theme'

// ---- 色ユーティリティ（明度反転でダーク化するため） ----

function parseColor(str: string): [number, number, number, number] | null {
  const s = str.trim()
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s)
  if (rgba) {
    return [+rgba[1], +rgba[2], +rgba[3], rgba[4] !== undefined ? +rgba[4] : 1]
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return [r, g, b, a]
  }
  return null
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v] }
  const hue = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)]
}

/** 明度を反転して暗色に変換（色相は保持、彩度は少し抑える）。 */
function darkenColor(str: string): string {
  const c = parseColor(str)
  if (!c) return str
  const [r, g, b, a] = c
  const [h, s, l] = rgbToHsl(r, g, b)
  const nl = Math.min(0.9, Math.max(0.05, 1 - l))
  const [nr, ng, nb] = hslToRgb(h, s * 0.85, nl)
  return `rgba(${nr},${ng},${nb},${a})`
}

/** paint 値（文字列 or 式配列）の中の色文字列だけを再帰的に変換する。 */
function transformValue(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return parseColor(v) ? fn(v) : v
  if (Array.isArray(v)) return v.map((x) => transformValue(x, fn))
  return v
}

/** スタイル中の色系 paint プロパティだけを一括変換する。 */
function recolor(src: StyleSpecification, fn: (s: string) => string): StyleSpecification {
  const style = structuredClone(src) as StyleSpecification
  for (const layer of style.layers) {
    const paint = (layer as { paint?: Record<string, unknown> }).paint
    if (!paint) continue
    for (const key of Object.keys(paint)) {
      if (key.includes('color')) paint[key] = transformValue(paint[key], fn)
    }
  }
  return style
}

export type Basemap = 'pale' | 'std' | 'photo' | 'blank'

export const BASEMAPS: { key: Basemap; label: string }[] = [
  { key: 'pale', label: '淡色' },
  { key: 'std', label: '標準' },
  { key: 'photo', label: '写真' },
  { key: 'blank', label: '白図' },
]

export const GLYPHS =
  'https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf'
const SPRITE = 'https://gsi-cyberjapan.github.io/optimal_bvmap/sprite/std'

const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>'

/** 素のスタイル（public/*.json）のキャッシュ。 */
const rawCache = new Map<string, StyleSpecification>()
/** `${base}-${theme}` をキーにした変換済みスタイルのキャッシュ。ダーク化は重いので一度だけ行う。 */
const styleCache = new Map<string, StyleSpecification>()

/**
 * 地理院 最適化ベクトルタイルのスタイルを実行時に読む。
 * pale.json（淡色地図風）と std.json（標準地図風）はレイヤーID・glyphs・sprite が
 * 同一構成なので、切り替えても他の注入結果は変わらない。
 */
async function loadRaw(name: 'pale' | 'std'): Promise<StyleSpecification> {
  const hit = rawCache.get(name)
  if (hit) return hit
  const res = await fetch(`${import.meta.env.BASE_URL}${name}.json`)
  const style = (await res.json()) as StyleSpecification
  rawCache.set(name, style)
  return style
}

/** 地理院の全国シームレス空中写真。浸水域と地形の関係を実地の像で見るため。 */
function photoStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sprite: SPRITE,
    sources: {
      photo: {
        type: 'raster',
        // ホストは淡色/標準（public/*.json のベクトルタイル）と同じ cyberjapandata.gsi.go.jp に
        // 揃える。地理院タイルは cyberjapandata.to.gsi.go.jp でも配信されているが、
        // 参照先を1ホストに寄せておくほうが到達性の確認が単純になる。
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'],
        tileSize: 256,
        maxzoom: 18,
        attribution: GSI_ATTRIBUTION,
      },
    },
    layers: [{ id: 'photo', type: 'raster', source: 'photo' }],
  } as StyleSpecification
}

/** 背景なし。浸水域と地形だけを見るための無地スタイル。 */
function blankStyle(theme: Theme): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sprite: SPRITE,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': theme === 'dark' ? '#14161a' : '#ffffff' },
      },
    ],
  } as StyleSpecification
}

export async function getBasemapStyle(base: Basemap, theme: Theme): Promise<StyleSpecification> {
  if (base === 'photo') return photoStyle()
  if (base === 'blank') return blankStyle(theme)

  const key = `${base}-${theme}`
  const cached = styleCache.get(key)
  if (cached) return cached

  const src = await loadRaw(base)
  // ダークテーマは、選択中のスタイルの色を明度反転して生成する。
  const style = theme === 'dark' ? recolor(src, darkenColor) : src

  styleCache.set(key, style)
  return style
}
