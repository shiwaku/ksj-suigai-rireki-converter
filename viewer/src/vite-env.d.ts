/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 浸水実績 PMTiles の配信先を差し替える（既定は GitHub Pages 上の変換結果）。 */
  readonly VITE_PMTILES_URL?: string
}

/** vite.config.ts の define で埋め込むビルド時刻。 */
declare const __BUILD_TIME__: string
