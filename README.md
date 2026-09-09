# ksj-suigai-rireki-converter

水害履歴(浸水実績)Shapefile 群を統合・正規化して各種 GIS 形式に変換するツール。

## 入力データ

`data/1896_2019_sinsui_add24/` — 1896〜2019 年の浸水実績ポリゴン 60 Shapefile
(属性: `id`, `code`, `name`, `date`, `source`, `disastName`)

入力の注意点(スクリプトが自動対応):

- 文字コードが **Shift_JIS(cp932)と UTF-8 の混在**(DBF レコード部から自動判定)
- CRS が **JGD2011 と JGD2000 の混在**(JGD2011 / EPSG:6668 に統一)
- 一部ファイルは PolygonZ(Z 値は除去)
- `1976_05_s51_sinsui.shp` のみ `disastName` 列なし(NULL 補完)
- 不正ジオメトリは `make_valid` で修復、空ジオメトリは除外(1 件)

## 使い方

```sh
uv sync
uv run python convert.py
# 形式を絞る場合
uv run python convert.py --formats geojson,pmtiles
```

## 出力 (`output/`)

| ファイル | 形式 | 備考 |
|---|---|---|
| `sinsui_all.geojson` | GeoJSON | UTF-8, 座標精度 7 桁 |
| `sinsui_all.fgb` | FlatGeobuf | 空間インデックス付き |
| `sinsui_all.gpkg` | GeoPackage | レイヤ名 `sinsui` |
| `sinsui_all.csv` | CSV(属性のみ) | UTF-8 BOM 付き(Excel 対応) |
| `sinsui_all.pmtiles` | PMTiles(ベクトルタイル) | ズーム 4–14, レイヤ名 `sinsui` |

全形式とも 14,585 フィーチャ / CRS は JGD2011 地理座標(EPSG:6668)。
PMTiles のみ Web メルカトルにタイル化される。

## 出力属性

元の属性に加えて以下を付与:

- `date_iso` — `date` (YYYYMMDD/YYYYMM) を ISO 形式に整形
- `event_year` / `event_month` — ファイル名から抽出したイベント年月
- `era_label` — 元号ラベル(m29, s56, h11, r1 など)
- `typhoon_file` — ファイル名の `_t` サフィックス有無(台風性イベントと思われる)
- `src_file` — 元 Shapefile 名

## Web での閲覧

PMTiles は GitHub Pages 経由で配信している(Range Request / CORS 対応)。

### 専用ビューワ

<https://shiwaku.github.io/ksj-suigai-rireki-converter/app/>

年代・期間・台風性・イベント単位での絞り込みと、
[Mapterhorn](https://mapterhorn.com/) の全球地形(陰影起伏 / 3D地形 / 等高線)の
重ね合わせができる。ソースと開発方法は [`viewer/`](viewer/) を参照。

特定の災害だけを見せるリンクも作れる(`?event=<元Shapefile名>`):

- 2000年の東海豪雨: <https://shiwaku.github.io/ksj-suigai-rireki-converter/app/?event=2000_09_h12_sinsui_t_add22.shp>
- 1959年の伊勢湾台風: <https://shiwaku.github.io/ksj-suigai-rireki-converter/app/?event=1959_09_s34_sinsui_t_add24.shp>

### 汎用ビューア

- pmtiles.io: <https://pmtiles.io/?url=https%3A%2F%2Fshiwaku.github.io%2Fksj-suigai-rireki-converter%2Foutput%2Fsinsui_all.pmtiles>
- タイル URL: `https://shiwaku.github.io/ksj-suigai-rireki-converter/output/sinsui_all.pmtiles`

## リポジトリ構成

| パス | 内容 |
|---|---|
| `convert.py` | Shapefile 一括変換ツール |
| `data/` | 入力 Shapefile |
| `output/` | 変換結果(Pages から配信) |
| `viewer/` | Web ビューワのソース(Vite + TypeScript + MapLibre) |
| `app/` | ビューワのビルド成果物(Pages から配信、`viewer` の `npm run build` が生成) |

## 既知の注意点

- PMTiles ドライバ(GDAL)は UTF-8 対応を宣言しないため、Windows では
  `encoding="utf-8"` を明示しないと cp932 で書かれ壊れる(スクリプトで対応済み)
- PMTiles は既存ファイルへの上書き不可のため、書き込み前に削除している
- `disastName` が NULL のレコードが 37 件ある(元データ由来)
