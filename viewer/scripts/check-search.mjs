// -----------------------------------------
// 水害イベントの検索（コンボボックスの絞り込み）を実データで検証する。
//
//   npm run check:search
//
// 元データの災害名は全角括弧「（平成12）」と半角括弧「(平成8)」が混在し、
// 全角数字を含むものもある。正規化を間違えると「東海」や「2000」で
// 目的の災害に当たらなくなるが、ブラウザで打ってみるまで気付けない。
// public/events.json の60件に対して代表的なクエリの期待結果を照合する。
// -----------------------------------------
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

/** クエリ → そのクエリで当たるべき元Shapefile名（順不同・完全一致で照合）。 */
const CASES = [
  ['', 60],
  ['東海', ['2000_09_h12_sinsui_t_add22.shp']],
  ['東海豪雨', ['2000_09_h12_sinsui_t_add22.shp']],
  ['2000', ['2000_09_h12_sinsui_t_add22.shp']],
  ['伊勢湾', ['1959_09_s34_sinsui_t_add24.shp']],
  ['平成12', ['2000_09_h12_sinsui_t_add22.shp']],
  ['h12', ['2000_09_h12_sinsui_t_add22.shp']],
  ['令和', ['2019_10_r1_sinsui_t.shp']],
  ['s34', ['1959_08_s34_sinsui_t.shp', '1959_09_s34_sinsui_t_add24.shp']],
  // 空白区切りは AND
  ['2000 東海', ['2000_09_h12_sinsui_t_add22.shp']],
  ['2000 伊勢湾', []],
  // 全角で打っても当たる（NFKC 正規化）
  ['２０００', ['2000_09_h12_sinsui_t_add22.shp']],
  // 該当なし
  ['ありえない災害名', []],
]

try {
  const { eventHaystack, matchesQuery } = await server.ssrLoadModule('/src/eventPicker.ts')
  const idx = JSON.parse(await readFile(join(ROOT, 'public', 'events.json'), 'utf8'))
  const hays = idx.events.map((e) => ({ src: e.src, hay: eventHaystack(e) }))

  for (const [query, expected] of CASES) {
    const hit = hays.filter((h) => matchesQuery(h.hay, query)).map((h) => h.src)
    const label = query === '' ? '(空クエリ)' : query

    if (typeof expected === 'number') {
      if (hit.length === expected) console.log(`ok   ${label} -> ${hit.length}件`)
      else {
        bad++
        console.error(`FAIL ${label} -> ${hit.length}件（期待 ${expected}件）`)
      }
      continue
    }

    const a = [...hit].sort()
    const b = [...expected].sort()
    if (a.length === b.length && a.every((v, i) => v === b[i])) {
      console.log(`ok   ${label} -> ${a.length ? a.join(', ') : '該当なし'}`)
    } else {
      bad++
      console.error(`FAIL ${label}`)
      console.error(`       得た: ${a.join(', ') || '(なし)'}`)
      console.error(`       期待: ${b.join(', ') || '(なし)'}`)
    }
  }
} finally {
  await server.close()
}

console.log(bad ? `\n${bad} 件のクエリが期待と違う` : '\nすべて期待どおり')
process.exit(bad ? 1 : 0)
