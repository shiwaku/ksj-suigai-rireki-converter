"""浸水実績のイベント索引 (viewer/public/events.json) を生成する。

ビューワは 60 個の元 Shapefile を「水害イベント」の単位として扱い、
一覧からの絞り込みと該当範囲へのズームを行う。イベント名と範囲はタイルの
属性からは引けない (タイルに全件は載っていない) ため、変換結果から
静的な索引として書き出す。

    uv run python viewer/scripts/build_events.py

入力は output/sinsui_all.fgb (空間インデックス付きで読み込みが速い)。
出力はリポジトリにコミットする。データを差し替えたら再生成すること。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import geopandas as gpd

ROOT = Path(__file__).resolve().parents[2]

# ビューワの年代凡例と同じ区切り。凡例の件数もこの索引から数えるため、
# ここと src/layers.ts の YEAR_BINS がずれると凡例と地図が食い違う。
YEAR_BINS = [1950, 1970, 1980, 2000]


def pick_name(names: gpd.pd.Series) -> str | None:
    """イベント名は disastName の最頻値を採る。

    同じ Shapefile 内でも表記揺れ (全角丸括弧と半角、「豪雨」と「大雨」) が
    あるため、最も多いものを代表にする。全件 NULL のファイルもある。
    """
    vals = names.dropna()
    vals = vals[vals.astype(str).str.strip() != ""]
    if vals.empty:
        return None
    return str(vals.value_counts().idxmax())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", type=Path, default=ROOT / "output" / "sinsui_all.fgb")
    ap.add_argument(
        "--output", type=Path, default=ROOT / "viewer" / "public" / "events.json"
    )
    args = ap.parse_args()

    gdf = gpd.read_file(args.input)
    if gdf.crs is None or gdf.crs.to_epsg() != 4326:
        # 索引の範囲はビューワ (WGS84 経緯度) に渡すため経緯度に揃える。
        # JGD2011 と WGS84 の差は数 cm でズーム範囲には影響しない。
        gdf = gdf.to_crs("EPSG:4326")

    events = []
    for src, part in gdf.groupby("src_file", sort=True):
        minx, miny, maxx, maxy = part.total_bounds
        year = part["event_year"].dropna()
        month = part["event_month"].dropna()
        era = part["era_label"].dropna()
        events.append(
            {
                "src": str(src),
                "year": int(year.iloc[0]) if not year.empty else None,
                "month": str(month.iloc[0]) if not month.empty else None,
                "era": str(era.iloc[0]) if not era.empty else None,
                "typhoon": bool(part["typhoon_file"].iloc[0]),
                "name": pick_name(part["disastName"]),
                "count": int(len(part)),
                "bounds": [round(v, 6) for v in (minx, miny, maxx, maxy)],
            }
        )

    events.sort(key=lambda e: (e["year"] or 0, e["month"] or "", e["src"]))

    # 凡例に出す年代ビンごとの件数。
    edges = [0, *YEAR_BINS, 9999]
    bin_counts = []
    for lo, hi in zip(edges, edges[1:]):
        n = int(((gdf["event_year"] >= lo) & (gdf["event_year"] < hi)).sum())
        bin_counts.append(n)

    minx, miny, maxx, maxy = gdf.total_bounds
    doc = {
        "generated_by": "viewer/scripts/build_events.py",
        "features": int(len(gdf)),
        "year_bins": YEAR_BINS,
        "bin_counts": bin_counts,
        "bounds": [round(v, 6) for v in (minx, miny, maxx, maxy)],
        "events": events,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(f"-> {args.output}  {len(events)}イベント / {len(gdf)}件")
    print(f"   年代別件数 {bin_counts}")


if __name__ == "__main__":
    main()
