// -----------------------------------------
// 浸水実績の MapLibre スタイルを静的な JSON として書き出す。
//
//   npm run export:style
//
// レイヤー定義は src/layers.ts がソースで、この JSON は生成物。直接編集しない。
// ビューワは背景地図・テーマ・絞り込みのためにレイヤーを実行時に組み立てているが、
// それだけでは QGIS や Maputnik のような外部ツールに渡せないため書き出す。
//
// TypeScript を読むために Vite の ssrLoadModule を使う。追加の依存は無い。
// -----------------------------------------
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { createServer } from 'vite'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, 'public', 'style')
const THEMES = ['light', 'dark']

const server = await createServer({
  root: ROOT,
  logLevel: 'warn',
  server: { middlewareMode: true },
  // 依存の事前スキャンは index.html を入口に非同期で走る。ここでは layers.ts を
  // 読むだけで即 close するため、スキャンが終わる前にサーバが閉じて
  // 「The server is being restarted or closed」で落ちる。スキャン自体が不要なので止める。
  optimizeDeps: { noDiscovery: true, include: [] },
})

try {
  const { buildStyle } = await server.ssrLoadModule('/src/layers.ts')
  await mkdir(OUT_DIR, { recursive: true })

  for (const theme of THEMES) {
    const style = buildStyle(theme)

    const errors = validateStyleMin(style)
    if (errors.length > 0) {
      console.error(`${theme}: スタイルが不正`)
      for (const e of errors) console.error(`  - ${e.message}`)
      process.exitCode = 1
      continue
    }

    const path = join(OUT_DIR, `sinsui-${theme}.json`)
    await writeFile(path, `${JSON.stringify(style, null, 2)}\n`, 'utf8')

    const counts = style.layers.reduce((acc, l) => {
      acc[l.type] = (acc[l.type] ?? 0) + 1
      return acc
    }, {})
    const detail = Object.entries(counts)
      .map(([t, n]) => `${t}:${n}`)
      .join(' ')
    console.log(`public/style/sinsui-${theme}.json  ${style.layers.length}レイヤー（${detail}）`)
  }
} finally {
  await server.close()
}
