// -----------------------------------------
// 自前レイヤーの差し込み位置（背景地図のどこに入るか）を検証する。
//
//   npm run check:stacking
//
// 自前のレイヤー（段彩・陰影起伏・浸水域・等高線）は、背景地図の注記の手前に
// 差し込む。地名や河川名だけを上に残し、それ以外の背景地図の上に載せる狙い。
//
// 以前は「最初の symbol レイヤー」を注記とみなしていた。地理院 最適化ベクトルタイルの
// 最初の symbol は水部の小さな注記（123レイヤー中の13番目）で、実際の注記は末尾の
// 114番以降。そのため自前のレイヤーが背景地図の101レイヤーの下に埋まり、市街地では
// 建築物の不透明な塗りに段彩も浸水域も潰れていた。**この壊れ方は例外を出さず、
// 「なんとなく見えにくい地図」になるだけで気付けない。**
//
// 差し込み位置が建築物より上・注記より下であることを、実際のスタイルで確かめる。
// -----------------------------------------
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** main.ts の labelBeforeId() と同じ規則。ずれたらこの検証の意味が無くなる。 */
const ANNO_SOURCE_LAYER = 'Anno'

function anchorIndex(layers) {
  const anno = layers.findIndex((l) => l['source-layer'] === ANNO_SOURCE_LAYER)
  if (anno >= 0) return anno
  return layers.findIndex((l) => l.type === 'symbol')
}

let bad = 0
const fail = (msg) => {
  bad++
  console.error(`FAIL ${msg}`)
}
const ok = (msg) => console.log(`ok   ${msg}`)

for (const name of ['pale', 'std']) {
  const style = JSON.parse(await readFile(join(ROOT, 'public', `${name}.json`), 'utf8'))
  const layers = style.layers
  const at = anchorIndex(layers)

  if (at < 0) {
    fail(`${name}: 差し込み位置が見つからない`)
    continue
  }

  // 注記より下であること
  const firstAnno = layers.findIndex((l) => l['source-layer'] === ANNO_SOURCE_LAYER)
  if (firstAnno >= 0 && at !== firstAnno) {
    fail(`${name}: 差し込み位置 ${at} が注記の先頭 ${firstAnno} と一致しない`)
  }

  // 注記以降に注記でないレイヤーが無いこと（あるとそれが自前レイヤーの上に来る）
  const strays = layers.slice(at).filter((l) => l['source-layer'] !== ANNO_SOURCE_LAYER)
  if (strays.length) {
    fail(`${name}: 注記より上に注記でないレイヤーがある: ${strays.map((l) => l.id).join(', ')}`)
  }

  // 建築物・道路・水域より上であること（ここが本題）
  const above = [
    ['建築物', 'BldA'],
    ['道路縁', 'RdEdg'],
    ['水域', 'WA'],
    ['構造物面', 'StrctArea'],
    ['等高線', 'Cntr'],
  ]
  for (const [label, src] of above) {
    const last = layers.map((l) => l['source-layer']).lastIndexOf(src)
    if (last < 0) {
      console.log(`skip ${name}: ${label}（${src}）が無い`)
      continue
    }
    if (at > last) ok(`${name.padEnd(4)} 差し込み位置 ${at} は${label}（最後 ${last}）より上`)
    else fail(`${name}: 差し込み位置 ${at} が${label}（最後 ${last}）より下 — 背景に埋まる`)
  }

  ok(`${name.padEnd(4)} 差し込み位置 ${at}/${layers.length}（手前: ${layers[at].id}）`)
}

// main.ts が同じ目印を使っているか（規則が二重にあるので食い違いを防ぐ）
const mainTs = await readFile(join(ROOT, 'src', 'main.ts'), 'utf8')
if (mainTs.includes(`ANNO_SOURCE_LAYER = '${ANNO_SOURCE_LAYER}'`)) {
  ok(`main.ts も '${ANNO_SOURCE_LAYER}' を目印にしている`)
} else {
  fail(`main.ts の目印がこの検証（'${ANNO_SOURCE_LAYER}'）と違う`)
}

console.log(bad ? `\n${bad} 件が期待と違う` : '\nすべて期待どおり')
process.exit(bad ? 1 : 0)
