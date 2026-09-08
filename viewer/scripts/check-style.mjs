// -----------------------------------------
// UI で切り替わる全パターンのレイヤー定義が MapLibre スタイル仕様として
// 妥当かを検証する。
//
//   npm run check:style
//
// ビューワの見た目はテーマ × 色分け × 絞り込み × 地形の組み合わせで変わり、
// 中身は MapLibre の式（match / step / case / interpolate）で組んである。
// 式の書き間違いはブラウザで該当の組み合わせを開くまで気付けないため、
// 組み合わせを総当たりで仕様検証に通す。タイルの取得は行わない。
// -----------------------------------------
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { createServer } from 'vite'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
})

let bad = 0
try {
  const L = await server.ssrLoadModule('/src/layers.ts')
  const T = await server.ssrLoadModule('/src/terrain.ts')

  const filters = [
    { name: '既定', f: L.DEFAULT_FILTER },
    { name: '年範囲', f: { yearFrom: 1950, yearTo: 1979, typhoonOnly: false, src: null } },
    { name: '台風性のみ', f: { yearFrom: 1896, yearTo: 2019, typhoonOnly: true, src: null } },
    { name: 'イベント指定', f: { yearFrom: 1896, yearTo: 2019, typhoonOnly: true, src: '1959_09_s34_sinsui_t.shp' } },
  ]

  for (const theme of ['light', 'dark']) {
    for (const mode of ['year', 'typhoon', 'plain']) {
      for (const { name, f } of filters) {
        const style = {
          version: 8,
          glyphs: 'https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf',
          sources: { ...L.SOURCES },
          layers: L.buildLayers({ mode, theme, filter: f, opacity: 0.6 }),
        }
        const errs = validateStyleMin(style)
        const tag = `${theme}/${mode}/${name}`
        if (errs.length) { bad++; console.error(`FAIL ${tag}`); errs.forEach(e => console.error('   ', e.message)) }
        else console.log(`ok   ${tag}`)
      }
    }
  }

  // 地形レイヤー（陰影起伏5方式 + 等高線）
  for (const { key } of T.HILLSHADE_METHODS) {
    for (const dem of ['tilejson', 'zxy', 'pmtiles']) {
      const style = {
        version: 8,
        sources: { [T.DEM_HILLSHADE]: T.demSourceSpec(dem) },
        layers: [T.hillshadeLayer(key, 0.3)],
      }
      const errs = validateStyleMin(style)
      const tag = `hillshade ${key}/${dem}`
      if (errs.length) { bad++; console.error(`FAIL ${tag}`); errs.forEach(e => console.error('   ', e.message)) }
      else console.log(`ok   ${tag}`)
    }
  }

  // maplibre-contour の DemSource は Web Worker を立てる。Node には Worker が
  // 無いため、URL を組むのに必要な最低限だけを持つスタブで代用する。
  // ここで検証したいのは生成される「スタイル」の妥当性だけで、実際のタイル生成ではない。
  globalThis.Worker = class {
    addEventListener() {}
    postMessage() {}
    terminate() {}
  }
  globalThis.URL.createObjectURL ??= () => 'blob:stub'
  globalThis.Blob ??= class {}
  T.registerTerrainProtocols({ addProtocol() {} })
  for (const theme of ['light', 'dark']) {
    const style = {
      version: 8,
      glyphs: 'https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf',
      sources: { [T.CONTOUR_SOURCE]: T.contourSourceSpec() },
      layers: T.contourLayers(theme),
      terrain: { source: T.DEM_TERRAIN, exaggeration: 1 },
    }
    // terrain が参照するソースも足す
    style.sources[T.DEM_TERRAIN] = T.demSourceSpec('tilejson')
    const errs = validateStyleMin(style)
    const tag = `contours+terrain ${theme}`
    if (errs.length) { bad++; console.error(`FAIL ${tag}`); errs.forEach(e => console.error('   ', e.message)) }
    else console.log(`ok   ${tag}`)
  }
} finally {
  await server.close()
}
console.log(bad ? `\n${bad} 件のスタイルが不正` : '\nすべて妥当')
process.exit(bad ? 1 : 0)
