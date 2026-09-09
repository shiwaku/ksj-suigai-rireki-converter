// -----------------------------------------
// 段彩（標高 → 色）の引き当てを検証する。
//
//   npm run check:relief
//
// 段彩は DEM タイルをピクセル単位で色に置き換えて作る。terrarium のバイト並びの
// 解釈やルックアップテーブルの添字を間違えても例外は出ず、「なんとなく変な色の
// 地図」が出るだけで気付けない。代表的な標高で期待する色になることを確かめる。
//
// とくに低地の内水浸水を読む用途では、レンジを狭めたときに **標高の細かい差が
// 色の差として出ること** が要件になる。1m に丸めるような実装に戻ると、
// 微小な窪地が塗り潰されて見えなくなるが、地図は普通に描かれてしまう。
// そこを数値で固定する。
//
// あわせて DEM タイルの取得先が生きていることも見る。
// -----------------------------------------
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from 'vite'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
})

let bad = 0
const fail = (msg) => {
  bad++
  console.error(`FAIL ${msg}`)
}
const ok = (msg) => console.log(`ok   ${msg}`)

// LUT は標高 1cm 刻みなので、帯の境界がその格子に乗らないと 1〜2/255 ずれる
// （0〜5m を 14 分割すると境界は 0.357m 刻みで、1cm の格子に乗らない）。
// 目に見えない差なので許容する。
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 3)
const rgb = (c) => `rgb(${c.map((v) => Math.round(v)).join(',')})`

try {
  const R = await server.ssrLoadModule('/src/relief.ts')
  const abs = R.reliefRangeByKey('all')
  const micro = R.reliefRangeByKey('micro')
  const lowland = R.reliefRangeByKey('lowland')

  // ---- 1. 「全国」レンジは絶対標高の帯どおりか ----
  const ABS_CASES = [
    [-50, [83, 135, 148], '海面下（帯の下限より下はクランプ）'],
    [0, [83, 135, 148], '海抜0m'],
    [1, [0, 204, 204], '1m'],
    [10, [128, 215, 255], '10m'],
    [300, [255, 255, 0], '300m'],
    [4000, [255, 255, 255], '4000m（最上段）'],
    [9000, [255, 255, 255], '最上段より上はクランプ'],
  ]
  for (const [h, want, note] of ABS_CASES) {
    const got = R.reliefColorAt(h, abs)
    if (same(got, want)) ok(`全国   ${String(h).padStart(5)}m -> ${rgb(got)}  ${note}`)
    else fail(`全国 ${h}m -> ${rgb(got)}（期待 ${rgb(want)}） ${note}`)
  }

  // ---- 2. 指定レンジは16色が min〜max に等間隔で割られているか ----
  const stops = R.reliefStops(micro)
  const step = (micro.max - micro.min) / (stops.length - 1)
  const even = stops.every((s, i) => Math.abs(s.from - (micro.min + step * i)) < 1e-9)
  if (even) ok(`微地形 ${stops.length}段が 0〜${micro.max}m に等間隔（1段 ${step.toFixed(3)}m）`)
  else fail('微地形レンジの段が等間隔でない')

  // 引き伸ばすときは先頭の重複色（-10m と 0m が同色）を落として 15 色にする
  const absStops = R.reliefStops(abs)
  if (stops.length === absStops.length - 1) ok(`微地形 ${stops.length}色（全国の先頭の重複色を除く）`)
  else fail(`微地形の色数が ${stops.length}（期待 ${absStops.length - 1}）`)
  if (stops.every((s, i) => same(s.color, absStops[i + 1].color))) ok('微地形の配色は全国と同じ並び')
  else fail('微地形レンジの色が全国と違う')

  // ---- 3. 微小な標高差が色の差になるか（1m 丸めに戻ったら落ちる） ----
  //
  // 内水浸水の原因になる窪地は数十cm。0〜5m レンジなら 1段 33cm なので、
  // 30cm の差が色として出なければ用を成さない。
  const MICRO_PAIRS = [
    [1.0, 1.34, '34cm の差（1段ぶん）'],
    [1.0, 1.05, '5cm の差'],
    [2.5, 2.52, '2cm の差'],
  ]
  for (const [a, b, note] of MICRO_PAIRS) {
    const ca = R.reliefColorAt(a, micro)
    const cb = R.reliefColorAt(b, micro)
    const diff = Math.max(...ca.map((v, i) => Math.abs(v - cb[i])))
    if (diff > 0) ok(`微地形 ${a}m と ${b}m で色が変わる（最大差 ${diff}）  ${note}`)
    else fail(`微地形 ${a}m と ${b}m が同色になった（${note}）— 標高が丸められている`)
  }

  // レンジを狭める意味の裏付け。同じ 34cm の標高差に対する色の差を比べる。
  // 「全国」でも 1〜10m の帯の中で補間はされるが、差はごく小さい。
  const diffFor = (r, a, b) => {
    const ca = R.reliefColorAt(a, r)
    const cb = R.reliefColorAt(b, r)
    return Math.max(...ca.map((v, i) => Math.abs(v - cb[i])))
  }
  const dAbs = diffFor(abs, 1.0, 1.34)
  const dMicro = diffFor(micro, 1.0, 1.34)
  if (dMicro > dAbs * 5) {
    ok(`34cm の差の見え方: 全国 ${dAbs} → 微地形 ${dMicro}（${(dMicro / Math.max(dAbs, 1)).toFixed(0)}倍）`)
  } else {
    fail(`レンジを狭めても 34cm の差が見えやすくならない（全国 ${dAbs} / 微地形 ${dMicro}）`)
  }

  // ---- 4. 隣の段どうしが見分けられるか ----
  //
  // 段彩は「段」が読めることが要件。明度の単調性は要件ではない
  // （地形図の配色は緑の平野が明るく茶の山地が暗いので、もともと単調でない）。
  // 隣接する段の色が近すぎないことを見る。
  const MIN_BAND_DIFF = 20 // RGB のチェビシェフ距離
  for (const r of R.RELIEF_RANGES) {
    const cols = R.reliefStops(r).map((s) => s.color)
    let worst = Infinity
    let worstAt = -1
    for (let i = 1; i < cols.length; i++) {
      // 「全国」の -10m と 0m は意図的に同色（海面下と海面を同じ色で塗る）
      if (r.mode === 'abs' && i === 1) continue
      const d = Math.max(...cols[i].map((v, k) => Math.abs(v - cols[i - 1][k])))
      if (d < worst) {
        worst = d
        worstAt = i
      }
    }
    if (worst >= MIN_BAND_DIFF) ok(`${r.key.padEnd(8)} 隣の段の最小色差 ${worst}（>= ${MIN_BAND_DIFF}）`)
    else fail(`${r.key} の第${worstAt}段と第${worstAt - 1}段が近すぎる（色差 ${worst}）`)
  }
  void lowland

  // ---- 5. 凡例の色が地図の色と一致するか ----
  let legendBad = 0
  for (const r of R.RELIEF_RANGES) {
    for (const e of R.reliefLegend(r)) {
      const got = R.reliefColorAt(e.from, r)
      const want = e.color.match(/\d+/g).map(Number)
      if (!same(got, want)) {
        legendBad++
        fail(`凡例 ${r.key} ${e.from}m の色 ${e.color} が地図の色 ${rgb(got)} と違う`)
      }
    }
  }
  if (!legendBad) ok(`凡例の色が地図の色と一致（${R.RELIEF_RANGES.length}レンジ）`)

  // ---- 6. タイルURLにレンジが入っているか（入っていないとキャッシュが混ざる） ----
  const urls = R.RELIEF_RANGES.map((r) => R.reliefSourceSpec(r).tiles[0])
  if (new Set(urls).size === urls.length) ok('レンジごとにタイルURLが異なる（キャッシュが混ざらない）')
  else fail('複数のレンジが同じタイルURLになっている')

  // ---- 7. DEM タイルの取得先が生きているか ----
  const url = R.reliefSourceSpec(micro)
    .tiles[0].replace(/^relief:\/\/[^/]+\/[^/]+\/[^/]+\//, '')
    .replace('{z}', '10')
    .replace('{x}', '901')
    .replace('{y}', '405')
  try {
    const res = await fetch(url)
    if (!res.ok) fail(`DEM タイルが取得できない: ${url} -> ${res.status}`)
    else {
      const buf = new Uint8Array(await res.arrayBuffer())
      const riff = String.fromCharCode(...buf.slice(0, 4))
      const webp = String.fromCharCode(...buf.slice(8, 12))
      if (riff !== 'RIFF' || webp !== 'WEBP') fail(`DEM タイルが WebP でない: ${riff}/${webp}`)
      else ok(`DEM タイル ${buf.length} バイトの WebP を取得（${url}）`)
    }
  } catch (e) {
    console.log(`skip DEM タイルの取得を確認できない（ネットワーク）: ${String(e)}`)
  }
} finally {
  await server.close()
}

console.log(bad ? `\n${bad} 件が期待と違う` : '\nすべて期待どおり')
process.exit(bad ? 1 : 0)
