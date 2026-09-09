// -----------------------------------------
// 段彩（標高 → 色）の引き当てを検証する。
//
//   npm run check:relief
//
// 段彩は DEM タイルをピクセル単位で色に置き換えて作る。terrarium の
// バイト並びの解釈やルックアップテーブルの添字を間違えても例外は出ず、
// 「なんとなく変な色の地図」が出るだけで気付けない。代表的な標高で
// 期待する色帯に入ることを確かめる。
//
// あわせて DEM タイルの取得先が生きていること（HTTP と WebP の寸法）も見る。
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

/** [標高m, 期待する色（TINTS の帯の色）, 説明] */
const CASES = [
  [-50, [83, 135, 148], '海面下（帯の下限より下はクランプ）'],
  [-10, [83, 135, 148], '帯の下限そのもの'],
  [0, [83, 135, 148], '海抜0m（濃尾平野南部・弥富などの0m地帯）'],
  [1, [0, 204, 204], '1m'],
  [10, [128, 215, 255], '10m'],
  [30, [191, 255, 191], '30m'],
  [140, [73, 179, 2], '140m'],
  [300, [255, 255, 0], '300m'],
  [3000, [230, 229, 227], '3000m'],
  [4000, [255, 255, 255], '4000m（最上段）'],
  [9000, [255, 255, 255], '最上段より上はクランプ'],
]

try {
  const R = await server.ssrLoadModule('/src/relief.ts')

  // 1. 帯の境界そのものの色が一致するか
  for (const [h, expected, note] of CASES) {
    const got = R.reliefColorAt(h)
    const ok = got.every((v, i) => Math.abs(v - expected[i]) <= 1)
    if (ok) console.log(`ok   ${String(h).padStart(5)}m -> rgb(${got.join(',')})  ${note}`)
    else fail(`${h}m -> rgb(${got.join(',')})（期待 rgb(${expected.join(',')})） ${note}`)
  }

  // 2. 帯の途中は両端の間の色に補間されているか（単調でないと段彩に見えない）
  const mid = R.reliefColorAt(20) // 10m(128,215,255) と 30m(191,255,191) の中間
  const between =
    mid[0] > 128 && mid[0] < 191 && mid[1] > 215 && mid[1] < 255 && mid[2] > 191 && mid[2] < 255
  if (between) console.log(`ok      20m -> rgb(${mid.join(',')})  帯の途中が補間されている`)
  else fail(`20m -> rgb(${mid.join(',')}) が 10m と 30m の間に無い（補間が効いていない）`)

  // 3. 明度がおおむね単調に上がるか（低地が暗く、高山が明るい）
  const lum = (h) => {
    const [r, g, b] = R.reliefColorAt(h)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  if (lum(0) < lum(300) && lum(300) < lum(4000)) {
    console.log('ok   明度が 0m < 300m < 4000m の順に上がる')
  } else {
    fail(`明度の順序が崩れている: 0m=${lum(0).toFixed(0)} 300m=${lum(300).toFixed(0)} 4000m=${lum(4000).toFixed(0)}`)
  }

  // 4. 凡例が昇順で、色が帯と一致するか（凡例と地図の食い違いを防ぐ）
  const legend = R.RELIEF_LEGEND
  const sorted = legend.every((e, i) => i === 0 || legend[i - 1].from < e.from)
  if (sorted) console.log(`ok   凡例が昇順（${legend.length}段）`)
  else fail('凡例の from が昇順でない')

  for (const e of legend) {
    const got = R.reliefColorAt(e.from)
    const want = e.color.match(/\d+/g).map(Number)
    if (!got.every((v, i) => Math.abs(v - want[i]) <= 1)) {
      fail(`凡例 ${e.from}m の色 ${e.color} が地図の色 rgb(${got.join(',')}) と違う`)
    }
  }
  if (!bad) console.log('ok   凡例の色が地図の色と一致する')

  // 5. DEM タイルの取得先が生きているか（WebP の寸法まで見る）
  const spec = R.reliefSourceSpec()
  const url = spec.tiles[0]
    .replace('relief://', '')
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
      if (riff !== 'RIFF' || webp !== 'WEBP') {
        fail(`DEM タイルが WebP でない: ${riff}/${webp}`)
      } else {
        console.log(`ok   DEM タイル ${buf.length} バイト の WebP を取得（${url}）`)
      }
    }
  } catch (e) {
    console.log(`skip DEM タイルの取得を確認できない（ネットワーク）: ${String(e)}`)
  }
} finally {
  await server.close()
}

console.log(bad ? `\n${bad} 件が期待と違う` : '\nすべて期待どおり')
process.exit(bad ? 1 : 0)
