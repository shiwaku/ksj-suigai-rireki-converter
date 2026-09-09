# 水害履歴（浸水実績）ビューワ

`output/sinsui_all.pmtiles` を MapLibre GL JS で表示する Web ビューワ。
[shiwaku/dm-converter](https://github.com/shiwaku/dm-converter) の `viewer/` を土台にし、
地形の重ね合わせは [shiwaku/mapterhorn-viewer](https://github.com/shiwaku/mapterhorn-viewer) から取り込んでいる。

公開先: <https://shiwaku.github.io/ksj-suigai-rireki-converter/app/>

## できること

| 機能 | 内容 |
|---|---|
| 浸水域の表示 | 14,585 件 / 60 イベント（1896〜2019 年）。塗りと輪郭の2枚、不透明度スライダー付き |
| 色分け | **年代**（5階級）/ **台風性**（台風・豪雨その他）/ **単色**。凡例に該当件数を表示 |
| 期間で絞る | 年の下限・上限スライダー。凡例と件数バッジが連動する |
| 台風性で絞る | 元ファイル名の `_t` サフィックスによる |
| イベント単位 | 60 イベントを**検索して**1件に絞り、その範囲へ移動。選択は URL に載る |
| 地形（Mapterhorn） | 陰影起伏（5方式・強調可変）/ 3D地形（起伏倍率可変）/ 等高線。DEM の配信方式は TileJSON・ZXY・PMTiles から選択 |
| 背景地図 | 淡色 / 標準（地理院 最適化ベクトルタイル）/ 写真（地理院シームレス空中写真）/ 白図 |
| その他 | ライト/ダークテーマ、クリックで属性ポップアップ（重なった浸水域を全件）、位置を URL ハッシュに保存 |

## 特定の災害だけを見る / 共有する

「水害イベント」の入力欄で災害名・年・元号・ファイル名を検索して1件に絞る。
全角括弧「（平成12）」と半角括弧「(平成8)」、全角数字が元データで混在しているため、
検索は NFKC 正規化して照合する。空白区切りは AND。

```
東海        → 2000（平成12）年 9月 台風14号・東海豪雨
2000        → 同じ
平成12 / h12 → 同じ
伊勢湾      → 1959（昭和34）年9月 伊勢湾台風
s34         → 1959年8月・9月の2件
```

選択したイベントは `?event=<元Shapefile名>` として URL に載るので、そのままリンクを渡せる。

```
# 2000年の東海豪雨だけを表示（範囲へ自動で寄る）
https://shiwaku.github.io/ksj-suigai-rireki-converter/app/?event=2000_09_h12_sinsui_t_add22.shp

# 位置も指定する（#ズーム/緯度/経度 がある場合はそちらを尊重し、自動ズームしない）
.../app/?event=2000_09_h12_sinsui_t_add22.shp#11/35.18/136.90
```

`?event=` に知らない値が来たらクエリごと捨てて全イベント表示に戻る。
地図位置は MapLibre が URL のハッシュに書くため、`?event=` はクエリ側だけを
`history.replaceState` で書き換える（絞り込み操作で戻るボタンの行き先を増やさない）。

## 使い方

```sh
cd viewer
npm install
npm run dev      # http://localhost:5175
npm run build    # 型チェック → 各種検証 → スタイル書き出し → ../app/ へビルド
npm run preview  # ビルド結果を確認
```

`npm run build` が唯一のゲートで、以下を順に通す。

1. `tsc --noEmit` — 型チェック
2. `npm run check:style` — テーマ × 色分け × 絞り込み × 地形の全組み合わせ（47通り）を
   MapLibre スタイル仕様に照らして検証する。式（`step` / `case` / `match` / `interpolate`）の
   書き間違いはブラウザで該当の組み合わせを開くまで気付けないため、総当たりで通す
3. `npm run check:search` — イベント検索の絞り込みを `public/events.json` の実データで検証する。
   括弧や数字の全角半角の正規化を間違えると「東海」や「2000」で目的の災害に当たらなくなるが、
   ブラウザで打ってみるまで気付けないため、代表的なクエリの期待結果を照合する
4. `npm run export:style` — `public/style/sinsui-{light,dark}.json` を書き出す
5. `vite build` — `../app/` へ出力

### 配信先の差し替え

浸水実績 PMTiles の既定は GitHub Pages 上の変換結果。焼き直したタイルを push 前に見る場合:

```sh
VITE_PMTILES_URL=http://localhost:8080/sinsui_all.pmtiles npm run dev
```

### イベント索引の再生成

イベント名（`disastName`）と各イベントの範囲はタイルの見えている部分からしか引けないため、
変換結果から静的な索引 `public/events.json` を作って使っている。データを差し替えたら再生成する:

```sh
uv run python viewer/scripts/build_events.py   # リポジトリのルートで
```

## 構成

```
viewer/
  index.html            パネルの静的マークアップ
  src/
    main.ts             状態 → レイヤーの組み立て、UI の配線
    layers.ts           浸水実績のソース・レイヤー・配色・絞り込み・ポップアップ
    terrain.ts          Mapterhorn の DEM（陰影起伏 / 3D地形 / 等高線）
    basemap.ts          背景地図の切替とダーク化
    events.ts           イベント索引（events.json）の読み込みと ?event= の読み書き
    eventPicker.ts      イベントの検索付き選択（コンボボックス）
    theme.ts            ライト/ダークの保存と反映
    style.css           デザイントークンとパネル
  scripts/
    check-style.mjs     全組み合わせのスタイル検証
    check-search.mjs    イベント検索の絞り込み検証
    export-style.mjs    静的スタイルの書き出し（QGIS / Maputnik 用）
    build_events.py     events.json の生成（geopandas）
  public/
    pale.json std.json  地理院 最適化ベクトルタイルのスタイル（dm-converter から取得）
    events.json         イベント索引（生成物・コミット対象）
    style/              書き出したスタイル（生成物・コミット対象）
```

## 設計上の判断

### ビルド成果物を `app/` に置いている

この Pages は `main` ブランチのルートを配信しており、`output/sinsui_all.pmtiles` も
そこから配っている。`gh-pages` ブランチへビューワを置くと Pages の配信元を切り替える
必要があり、既存のタイル URL が失われる。ビルド成果物をルートの `app/` に出して
コミットすることで、タイルとビューワを同じ Pages に共存させている
（`vite.config.ts` の `base` と `build.outDir`）。

### 自前レイヤーは背景地図のラベルの下に差し込む

積み順は下から「背景地図 → 陰影起伏 → 浸水域（塗り・輪郭）→ 等高線 → 背景地図のラベル」。
浸水域を最前面に置くと地名が読めなくなる。等高線を浸水域の上に置くのは、
浸水域を透かして地形の高低を追えるようにするため。

### 年代の配色

年は順序を持つ量なので、単一色相（青）の明→暗の順序尺度で表す。
ライトは薄→濃、ダークは背景に沈まないよう濃→薄で、どちらも「新しい年ほど目立つ」。
階級ごとの色は、単一色相・明度単調・隣接段の明度差 0.06 以上・
最も背景に近い段が地図面に対して 2:1 以上、を満たす組み合わせを選んである
（`src/layers.ts` の `YEAR_COLORS`）。段を入れ替えるときは検証をやり直すこと。

### 等高線は上流サンプルより細かい

浸水域が広がるのは起伏の小さい平野で、100m 間隔では地形が読めない。
DEM を1段深く（z13）読み、z15 で 10m / 50m まで刻む（`src/terrain.ts`）。
maplibre-contour の `DemSource` は DEM を自前の HTTP で取るため MapLibre の
プロトコルを経由できず、等高線は配信方式の選択にかかわらず常に ZXY から生成する。

## 出典

- 浸水実績: [国土数値情報（水害履歴・浸水実績）国土交通省](https://nlftp.mlit.go.jp/ksj/) を加工して作成
- 地形: [Mapterhorn](https://mapterhorn.com/)（[attribution](https://mapterhorn.com/attribution)）
- 背景: [国土地理院 最適化ベクトルタイル](https://github.com/gsi-cyberjapan/optimal_bvmap) / [地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)
