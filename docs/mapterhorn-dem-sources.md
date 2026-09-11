# Mapterhorn の地形データの元データ — ある地点でどの解像度の DEM が使われているか

調査日: 2026-09-11。Issue #16「DEM の細かさが地域で違うことを画面で伝えていない」の
調査メモを、実データでの検証結果とあわせてまとめたもの。ビューワでの実装は
[`viewer/README.md`](../viewer/README.md) の「DEM の細かさを地点ごとに伝える」を参照。

## 結論

- **地形タイル自体からは分からない。** Mapterhorn の地形タイルは terrarium RGB で、
  画素値は標高だけ。出典やメッシュサイズは埋め込まれていない
- **公式の被覆ベクトルタイル(coverage)を読めば、実質ピクセル単位で分かる。**
  Mapterhorn の [Coverage ページ](https://mapterhorn.com/coverage)が表示に使っている
  タイルで、地点に重なるソースのうち**最も細かいものが、その地点で使われている DEM**
- 誤差は 2 つ。ポリゴンが z14 で約 0.375px(数 m)に単純化されていること、
  ソースの継ぎ目の数ピクセルはガウスぼかしで両ソースが混ざっていること
- 追加データなしで「配信される最大ズーム」から読む手もあるが、粒度が z12 マクロタイル
  (約 10km 角)なので 1m と 5m が混在する区画は区別できない

## Mapterhorn が日本について持つ DEM

[attribution.json](https://download.mapterhorn.com/attribution.json)(2026-09-11 取得、148 ソース)の `jpdem*`。
すべて国土地理院「基盤地図情報(数値標高モデル)」で、ライセンス欄は
「国土地理院コンテンツ利用規約／測量法に基づく国土地理院長承認(使用)R 7JHs 542」。

| source | メッシュ | 元データ | tarball |
|---|---|---|---|
| `jpdem1a` | 1m | DEM1A(航空レーザ測量) | 182 GB |
| `jpdem5a` | 5m | DEM5A(航空レーザ測量) | 18.5 GB |
| `jpdem5b` | 5m | DEM5B(写真測量) | 0.77 GB |
| `jpdem5c` | 5m | DEM5C(写真測量) | 0.87 GB |
| `jpdem10a` | 10m | DEM10A(火山基本図等) | 0.036 GB |
| `jpdem10b` | 10m | DEM10B(地形図等高線) | 3.6 GB |

これに全球の下敷きとして `glo30`(Copernicus GLO-30、30m)が敷かれる。
tarball のサイズ比から、1m メッシュが被覆面積のわりに圧倒的に大きいこと、
DEM5B/5C がごく限られた範囲であることが読める。

## 合成の規則(なぜ「最も細かいソース」で決まるか)

[pipelines/README.md](https://github.com/mapterhorn/mapterhorn/blob/main/pipelines/README.md) の Aggregation:

- 解像度の細かいソース(maxzoom が高い)を優先し、nodata の穴を次に細かいソースで埋める
- 継ぎ目にはガウスぼかしをかける
  ([aggregation_merge.py](https://github.com/mapterhorn/mapterhorn/blob/main/pipelines/aggregation_merge.py))

つまり、ある地点の DEM = その地点を覆うソースのうち最も細かいもの。
継ぎ目の数ピクセルだけは両ソースの混合値になる。

## 方法1: 被覆ベクトルタイル(推奨・ビューワで採用)

```
TileJSON:      https://single-archive-tiles.mapterhorn.com/coverage.json
tiles:         https://single-archive-tiles.mapterhorn.com/coverage/{z}/{x}/{y}.mvt
source-layer:  coverage(z0〜14、extent 4096)
属性:          source(String) — jpdem1a / jpdem5a / … / glo30
```

TileJSON の内容(2026-09-11):

```json
{"tilejson":"3.0.0","scheme":"xyz",
 "tiles":["https://single-archive-tiles.mapterhorn.com/coverage/{z}/{x}/{y}.mvt"],
 "vector_layers":[{"id":"coverage","fields":{"source":"String"},"minzoom":0,"maxzoom":14}],
 "bounds":[-180,-85.0511287,180,85.0511287],"minzoom":0,"maxzoom":14}
```

各ソースの GeoTIFF を実データ範囲でポリゴン化したもの(`source_polygonize.py` →
planetiler の [Coverage.java](https://github.com/mapterhorn/mapterhorn/blob/main/pipelines/Coverage.java))
なので、被覆は実際のデータ範囲に近い。

公式サイトの Coverage ページ(https://mapterhorn.com/coverage)のソースにこの
TileJSON URL が入っていることを確認した。ただし README などで「公開 API」として
明記されたものではなく、公式ページが内部で読んでいるエンドポイントである。

### 実測: z14 タイルをデコードした結果

`@mapbox/vector-tile` + `pbf` で 5 地点の z14 タイルを読み、`source` の値を集めた。

| 地点 | z/x/y | サイズ | 含まれる source | 最も細かい DEM |
|---|---|---|---|---|
| 東京・江東(低地) | 14/14555/6452 | 173 B | glo30, jpdem1a, jpdem5a, jpdem10b | **1m** |
| 北海道・十勝 | 14/14709/6026 | 1.9 KB | glo30, jpdem5a, jpdem10b | **5m** |
| 能登半島 | 14/14422/6354 | 17.7 KB | glo30, jpdem1a, jpdem5a, jpdem5c, jpdem10b | **1m** |
| 北アルプス | 14/14456/6416 | 3.5 KB | glo30, jpdem1a, jpdem5a, jpdem10b | **1m** |
| 熊本・人吉 | 14/14143/6642 | 3.2 KB | glo30, jpdem1a, jpdem5a, jpdem10b | **1m** |

- どの地点にも `jpdem10b` と `glo30` が敷かれている(全国被覆の下敷き)
- 十勝には `jpdem1a` が無く、後述の方法2(配信が z14 まで)と一致する
- 江東のタイルは 173 B で、4 つのポリゴンがタイル全面を覆う単純な形。能登は海岸線を
  含むため 17 KB になる。読み込みコストは無視できる

### 使い方

被覆タイルを `fill-opacity: 0` の fill レイヤーで載せ、地点で `queryRenderedFeatures`
→ 重なる `source` を集めて `resolution` の最小値を採る。`visibility: none` にすると
問い合わせの対象から外れるので、不透明度で隠す。

## 方法2: 配信される最大ズームから読む(追加データ不要)

配信は「ソースを解像しきる最小ズーム」までしか作られていないので、404 になるズームで
解像度クラスが分かる。`https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` を z13〜18 で
HEAD した実測:

| 地点 | 配信あり | 推定ソース |
|---|---|---|
| 東京・江東(低地) | z16 まで | 1m(jpdem1a) |
| 北アルプス | z16 まで | 1m |
| 能登半島 | z16 まで | 1m |
| 北海道・十勝 | z14 まで | 5m |

z16 の地上画素は北緯 35° で約 0.97m、z14 は約 3.9m なので、それぞれ 1m と 5m の
ソースを解像しきる最小ズームに対応する(Web メルカトルの画素サイズ × cos(緯度))。

ただし粒度は z12 マクロタイル単位(約 10km 角)。1m と 5m が混在する区画は全体が
z16 で配られるので、ピクセル単位の判定には方法1が要る。ズーム上限を見るだけなら
追加データなしで「この辺は 5m までしか無い」という注意書きには使える。

## 副次的に分かったこと: 標高のズーム別丸め

タイルは標高をズームごとに 2 のべき乗で丸めている(Mapterhorn README の表):

| z | 垂直分解能 |
|---|---|
| 12 | 50cm |
| 13 | 25cm |
| 14 | 12.5cm |
| 15 | 6.3cm |
| 16 | 3.1cm |

段彩ソースの maxzoom は 15 なので 0.5m 刻みの段彩には十分。ただし z12 以下のタイルを
そのまま読むと 1 段と同じ丸めになる。

## 参考

- Mapterhorn: https://mapterhorn.com/ 、attribution: https://mapterhorn.com/attribution
- データ源一覧: https://download.mapterhorn.com/attribution.json
- パイプライン: https://github.com/mapterhorn/mapterhorn/tree/main/pipelines
- 国土地理院 基盤地図情報(数値標高モデル): https://service.gsi.go.jp/kiban/app/
- Issue #16 のコメント(2026-09-11)にこの調査の初版がある
