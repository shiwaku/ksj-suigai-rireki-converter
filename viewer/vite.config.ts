import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  // GitHub Pages はこのリポジトリの main / ルートを配信している。ビューワを
  // gh-pages ブランチに置くと配信元の切替が必要になり、同じ Pages で配っている
  // output/sinsui_all.pmtiles の URL が失われる。ビルド成果物をルートの app/ に
  // 出してコミットすることで、タイルとビューワを同じ Pages に共存させる。
  base: command === 'build' ? '/ksj-suigai-rireki-converter/app/' : '/',
  build: {
    outDir: '../app',
    emptyOutDir: true,
    // maplibre-contour / pmtiles が最上位 await を含むため ES2022 が必要
    target: 'es2022',
  },
  server: {
    port: 5175,
    strictPort: true,
    // Windows 上のファイルを WSL 側から見る構成ではファイル変更イベントが
    // 届かず、dev サーバが古い変換結果を返し続ける。ポーリングで検知する。
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
  define: {
    __BUILD_TIME__: JSON.stringify(
      new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    ),
  },
}))
