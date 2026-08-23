"""国土数値情報 水害履歴(浸水実績)Shapefile 一括変換ツール。

data/ 配下の浸水実績 Shapefile 群(Shift_JIS / UTF-8 混在)を読み込み、
属性を正規化して 1 レイヤに統合し、以下の形式で出力する。

- GeoJSON      (UTF-8, WGS84/JGD2011 地理座標)
- FlatGeobuf
- GeoPackage   (レイヤ名: sinsui)
- CSV          (属性のみ, UTF-8 BOM 付き = Excel 対応)
- PMTiles      (ベクトルタイル, GDAL PMTiles ドライバ)

使い方:
    uv run python convert.py [--input DIR] [--output DIR] [--formats geojson,fgb,gpkg,csv,pmtiles]
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely import force_2d, make_valid
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon

# JGD2011 地理座標系 (.prj は GCS_JGD_2011)
SRC_CRS = "EPSG:6668"

FILENAME_RE = re.compile(
    r"^(?P<year>\d{4})_(?P<month>\d{2}(?:-\d{2})?)_"
    r"(?P<era>[mshr]\d+)_sinsui(?P<t>_t)?(?:_add(?P<add>\d+))?$"
)

ALL_FORMATS = ["geojson", "fgb", "gpkg", "csv", "pmtiles"]


def detect_encoding(dbf_path: Path) -> str:
    """DBF のレコード部バイトから cp932 / UTF-8 を判定する。

    ヘッダ部には言語ドライバ ID 等の非テキストバイトが含まれるため、
    レコード部のみを対象に UTF-8 厳密デコードを試す。成功すれば UTF-8
    (ASCII のみでも同じ結果になるので安全)、失敗すれば cp932 とみなす。
    """
    data = dbf_path.read_bytes()
    header_len = int.from_bytes(data[8:10], "little")
    records = data[header_len:].rstrip(b"\x1a")
    try:
        records.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        return "cp932"


def normalize_date(raw: str | None) -> str | None:
    """date 属性 (YYYYMMDD / YYYYMM / YYYY) を ISO 形式に整形する。"""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s.isdigit():
        return None
    if len(s) == 8:
        y, m, d = s[:4], s[4:6], s[6:8]
        if m == "00":
            return y
        if d == "00":
            return f"{y}-{m}"
        return f"{y}-{m}-{d}"
    if len(s) == 6:
        y, m = s[:4], s[4:6]
        return y if m == "00" else f"{y}-{m}"
    if len(s) == 4:
        return s
    return None


def read_one(shp: Path) -> gpd.GeoDataFrame:
    enc = detect_encoding(shp.with_suffix(".dbf"))
    gdf = gpd.read_file(shp, encoding=enc)

    m = FILENAME_RE.match(shp.stem)
    if not m:
        print(f"  [warn] ファイル名がパターン外: {shp.name}", file=sys.stderr)
        meta = {"year": None, "month": None, "era": None, "t": None, "add": None}
    else:
        meta = m.groupdict()

    if "disastName" not in gdf.columns:
        gdf["disastName"] = pd.NA

    month = meta["month"]
    gdf["event_year"] = int(meta["year"]) if meta["year"] else pd.NA
    gdf["event_month"] = pd.NA if month in (None, "00") else month
    gdf["era_label"] = meta["era"]
    gdf["typhoon_file"] = bool(meta["t"])  # ファイル名 _t サフィックス(台風性イベント)
    gdf["date_iso"] = gdf["date"].map(normalize_date)
    gdf["src_file"] = shp.name

    # ジオメトリ整備: Z 値除去・不正ジオメトリ修復
    invalid = ~gdf.geometry.is_valid
    if invalid.any():
        gdf.loc[invalid, "geometry"] = gdf.loc[invalid, "geometry"].apply(make_valid)
    gdf["geometry"] = force_2d(gdf.geometry)

    if gdf.crs is None:
        gdf = gdf.set_crs(SRC_CRS)
    elif gdf.crs.to_epsg() != 6668:
        gdf = gdf.to_crs(SRC_CRS)  # JGD2000 混在ファイルを JGD2011 に統一
    return gdf


def convert(input_dir: Path, output_dir: Path, formats: list[str]) -> None:
    shps = sorted(input_dir.rglob("*.shp"))
    if not shps:
        sys.exit(f"エラー: {input_dir} に .shp が見つかりません")

    frames = []
    for shp in shps:
        gdf = read_one(shp)
        print(f"  {shp.name:45s} {len(gdf):5d} 件")
        frames.append(gdf)

    merged = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=SRC_CRS)
    cols = [
        "id", "code", "name", "date", "date_iso", "source", "disastName",
        "event_year", "event_month", "era_label", "typhoon_file", "src_file",
        "geometry",
    ]
    merged = merged[cols]

    # make_valid が返す GeometryCollection からポリゴン部分のみ抽出
    def to_polygonal(geom):
        if isinstance(geom, GeometryCollection):
            polys = [g for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon))]
            if not polys:
                return None
            parts = []
            for g in polys:
                parts.extend(g.geoms if isinstance(g, MultiPolygon) else [g])
            return MultiPolygon(parts)
        return geom

    merged["geometry"] = merged.geometry.apply(to_polygonal)
    empty = merged.geometry.isna() | merged.geometry.is_empty
    if empty.any():
        print(f"  [warn] 空ジオメトリ {empty.sum()} 件を除外:", file=sys.stderr)
        for _, row in merged[empty].iterrows():
            print(f"    {row['src_file']} id={row['id']}", file=sys.stderr)
        merged = merged[~empty].reset_index(drop=True)

    print(f"\n統合: {len(merged)} 件 / {len(shps)} ファイル")
    print(f"範囲: {merged.total_bounds}")

    output_dir.mkdir(parents=True, exist_ok=True)
    stem = output_dir / "sinsui_all"

    if "geojson" in formats:
        merged.to_file(stem.with_suffix(".geojson"), driver="GeoJSON",
                       COORDINATE_PRECISION=7)
        print(f"-> {stem}.geojson")
    if "fgb" in formats:
        merged.to_file(stem.with_suffix(".fgb"), driver="FlatGeobuf")
        print(f"-> {stem}.fgb")
    if "gpkg" in formats:
        merged.to_file(stem.with_suffix(".gpkg"), driver="GPKG", layer="sinsui")
        print(f"-> {stem}.gpkg")
    if "csv" in formats:
        merged.drop(columns="geometry").to_csv(
            stem.with_suffix(".csv"), index=False, encoding="utf-8-sig")
        print(f"-> {stem}.csv")
    if "pmtiles" in formats:
        # PMTiles ドライバは既存ファイルの上書きに未対応のため先に削除
        stem.with_suffix(".pmtiles").unlink(missing_ok=True)
        # PMTiles ドライバは UTF-8 対応を宣言しないため、Windows ではロケール
        # (cp932) でエンコードされてしまう。encoding を明示して防ぐ。
        merged.to_file(
            stem.with_suffix(".pmtiles"), driver="PMTiles", layer="sinsui",
            NAME="sinsui_rireki", DESCRIPTION="Flood history (sinsui) 1896-2019",
            MINZOOM=4, MAXZOOM=14, encoding="utf-8",
        )
        print(f"-> {stem}.pmtiles")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--input", type=Path,
                    default=Path("data/1896_2019_sinsui_add24"))
    ap.add_argument("--output", type=Path, default=Path("output"))
    ap.add_argument("--formats", default=",".join(ALL_FORMATS),
                    help=f"カンマ区切り: {','.join(ALL_FORMATS)}")
    args = ap.parse_args()

    formats = [f.strip() for f in args.formats.split(",") if f.strip()]
    unknown = set(formats) - set(ALL_FORMATS)
    if unknown:
        sys.exit(f"エラー: 未対応の形式 {sorted(unknown)}")
    convert(args.input, args.output, formats)


if __name__ == "__main__":
    main()
