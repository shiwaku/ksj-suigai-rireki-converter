// -----------------------------------------
// UI で切り替わる全パターンのレイヤー定義が MapLibre スタイル仕様として
// 妥当かを検証する。
//
//   npm run check:style
//
// ビューワの見た目はテーマ × 成因の絞り込み × イベント指定 × 地形の組み合わせで変わり、
// 中身は MapLibre の式（case / index-of / match / interpolate）で組んである。
// 式の書き間違いはブラウザで該当の組み合わせを開くまで気付けないため、
// 組み合わせを総当たりで仕様検証に通す。タイルの取得は行わない。
// -----------------------------------------
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
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
  const C = await server.ssrLoadModule('/src/coverage.ts')

  const EVENT = '2000_09_h12_sinsui_t_add22.shp'
  const filters = [
    { name: '既定', f: L.DEFAULT_FILTER },
    { name: '台風のみ', f: { origin: 'typhoon', src: null } },
    { name: '大雨のみ', f: { origin: 'other', src: null } },
    { name: 'イベント指定', f: { origin: 'all', src: EVENT } },
    { name: 'イベント×台風', f: { origin: 'typhoon', src: EVENT } },
    { name: 'イベント×大雨', f: { origin: 'other', src: EVENT } },
  ]

  for (const theme of ['light', 'dark']) {
    for (const { name, f } of filters) {
      const style = {
        version: 8,
        glyphs: 'https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf',
        sources: { ...L.SOURCES },
        layers: L.buildLayers({ theme, filter: f, opacity: 0.6 }),
      }
      const errs = validateStyleMin(style)
      const tag = `${theme}/${name}`
      if (errs.length) { bad++; console.error(`FAIL ${tag}`); errs.forEach(e => console.error('   ', e.message)) }
      else console.log(`ok   ${tag}`)
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

  // DEM 被覆（透明な問い合わせ用レイヤー）
  {
    const style = {
      version: 8,
      sources: { [C.COVERAGE_SOURCE]: C.coverageSourceSpec() },
      layers: [C.coverageLayer()],
    }
    const errs = validateStyleMin(style)
    if (errs.length) { bad++; console.error('FAIL dem-coverage'); errs.forEach(e => console.error('   ', e.message)) }
    else console.log('ok   dem-coverage')
  }

  // 被覆 → 最も細かい DEM の選び方。合成規則（細かいソース優先）と一致すること
  const DEM_CASES = [
    [['glo30', 'jpdem10b', 'jpdem5a', 'jpdem1a'], 'jpdem1a', 1],   // 江東・能登・北アルプス・人吉
    [['glo30', 'jpdem10b', 'jpdem5a'], 'jpdem5a', 5],              // 十勝
    [['jpdem10b', 'glo30'], 'jpdem10b', 10],
    [['glo30'], 'glo30', 30],
    [['unknownsrc', 'jpdem10a'], 'jpdem10a', 10],                   // 分解能不明のソースは後ろへ
    [[], null, null],
  ]
  for (const [codes, code, res] of DEM_CASES) {
    const got = C.finestDem(codes)
    const okv = got === null ? code === null : got.code === code && got.resolution === res
    const tag = `dem finest [${codes.join(',')}] -> ${got ? `${got.code}/${got.resolution}m` : 'null'}`
    if (okv) console.log(`ok   ${tag}`)
    else { bad++; console.error(`FAIL ${tag}（期待 ${code}/${res}）`) }
  }

  // ---- 成因の判定を実際に評価する ----
  //
  // 「台風性か」の判定は build_events.py の is_typhoon()（凡例の件数）と
  // src/layers.ts の isTyphoonExpr（地図の色と絞り込み）に二重で実装されている。
  // 片方だけ変えると地図と凡例が食い違うため、式を本当に評価して規則を固定する。
  // 判定は filterExpr の 'typhoon' / 'other' が排他かつ網羅であることで確かめる。
  const ORIGIN_CASES = [
    ['1959(昭和34)年9月降雨(伊勢湾台風)', true, 'typhoon'],
    ['2000（平成12）年 9月 台風14号・東海豪雨', true, 'typhoon'],
    ['1974(昭和49)年7月降雨(台風8号・七夕豪雨)', true, 'typhoon'],
    // ファイル名フラグと食い違う実データ（1961_06_s36 に混在する17件）
    ['1961（昭和36）年6月台風第6号', false, 'typhoon'],
    ['1961(昭和36)年6月大雨', false, 'other'],
    ['1935(昭和10)年6月降雨(鴨川大洪水)', false, 'other'],
    ['1995(平成7)年7月降雨(豪雨)', false, 'other'],
    // 災害名が無い37件はファイル名の `_t` で補う
    [null, true, 'typhoon'],
    [null, false, 'other'],
    ['', true, 'typhoon'],
    ['', false, 'other'],
  ]

  const compile = (expr) => {
    const c = expression.createExpression(expr, { type: 'boolean' })
    if (c.result === 'error') {
      throw new Error(`式が不正: ${c.value.map((e) => e.message).join(' / ')}`)
    }
    return (props) => c.value.evaluate({ zoom: 10 }, { properties: props })
  }

  const isTyphoonOnly = compile(L.filterExpr({ origin: 'typhoon', src: null }))
  const isOtherOnly = compile(L.filterExpr({ origin: 'other', src: null }))

  for (const [disastName, typhoonFile, expected] of ORIGIN_CASES) {
    // MVT は欠けた属性を持たないため、null は「キーが無い」で表す
    const props = { typhoon_file: typhoonFile }
    if (disastName !== null) props.disastName = disastName

    const t = isTyphoonOnly(props)
    const o = isOtherOnly(props)
    const got = t && !o ? 'typhoon' : o && !t ? 'other' : `不定(台風=${t} 大雨=${o})`
    const shown = disastName === null ? '(名称なし)' : disastName === '' ? '(空文字)' : disastName
    const tag = `成因 _t=${String(typhoonFile).padEnd(5)} ${shown}`
    if (got === expected) console.log(`ok   ${tag} -> ${got}`)
    else {
      bad++
      console.error(`FAIL ${tag} -> ${got}（期待 ${expected}）`)
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
