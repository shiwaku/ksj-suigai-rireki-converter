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
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]


def is_typhoon(disast_name: object, typhoon_file: bool) -> bool:
    """成因が台風性かを判定する。

    災害名 (disastName) に「台風」を含むものを台風性とする。名称が無いレコード
    (37件) は元ファイル名の `_t` サフィックス (typhoon_file) で補う。

    ファイル名のフラグだけで判定すると 1961_06_s36 のように1ファイルに
    「大雨」と「台風第6号」が混在するものを取り違える (17件)。名称は
    レコード単位なのでそこまで分かれる。

    ビューワ側の src/layers.ts の isTyphoonExpr が同じ規則を MapLibre の式で
    実装している。凡例の件数はこの索引から数えるため、片方だけ変えると
    地図と凡例が食い違う。
    """
    name = "" if disast_name is None or pd.isna(disast_name) else str(disast_name)
    if name.strip() == "":
        return typhoon_file
    return "台風" in name


def pick_name(names: pd.Series) -> str | None:
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

    gdf["is_typhoon"] = [
        is_typhoon(n, bool(t))
        for n, t in zip(gdf["disastName"], gdf["typhoon_file"], strict=True)
    ]

    events = []
    for src, part in gdf.groupby("src_file", sort=True):
        minx, miny, maxx, maxy = part.total_bounds
        year = part["event_year"].dropna()
        month = part["event_month"].dropna()
        era = part["era_label"].dropna()
        n_typhoon = int(part["is_typhoon"].sum())
        events.append(
            {
                "src": str(src),
                "year": int(year.iloc[0]) if not year.empty else None,
                "month": str(month.iloc[0]) if not month.empty else None,
                "era": str(era.iloc[0]) if not era.empty else None,
                # ファイル名の `_t` サフィックス。検索の手がかりとして残す。
                "typhoon_file": bool(part["typhoon_file"].iloc[0]),
                "name": pick_name(part["disastName"]),
                "count": int(len(part)),
                # 成因ごとの件数。1ファイルに両方混在するものがあるため個別に持つ。
                "count_typhoon": n_typhoon,
                "count_other": int(len(part)) - n_typhoon,
                "bounds": [round(v, 6) for v in (minx, miny, maxx, maxy)],
            }
        )

    events.sort(key=lambda e: (e["year"] or 0, e["month"] or "", e["src"]))

    minx, miny, maxx, maxy = gdf.total_bounds
    doc = {
        "generated_by": "viewer/scripts/build_events.py",
        "features": int(len(gdf)),
        "count_typhoon": int(gdf["is_typhoon"].sum()),
        "count_other": int((~gdf["is_typhoon"]).sum()),
        "bounds": [round(v, 6) for v in (minx, miny, maxx, maxy)],
        "events": events,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(f"-> {args.output}  {len(events)}イベント / {len(gdf)}件")
    print(f"   台風性 {doc['count_typhoon']:,}件 / 大雨・その他 {doc['count_other']:,}件")


if __name__ == "__main__":
    main()
