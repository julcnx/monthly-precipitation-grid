#!/usr/bin/env python3
"""
Build a coarse global monthly-precipitation grid as a portable SQLite file.

Source data: NOAA PSL CMAP (CPC Merged Analysis of Precipitation) long-term
monthly climatology, a public-domain NOAA product natively gridded at 2.5deg
resolution (72 lat x 144 lon), i.e. already a coarse global grid -- no
resampling needed.

  https://psl.noaa.gov/data/gridded/data.cmap.html

Usage:
    python3 scripts/build_grid.py [--out data/precip_grid.sqlite]
"""
import argparse
import sqlite3
import urllib.request
from pathlib import Path

import h5py
import numpy as np

SOURCE_URL = "https://downloads.psl.noaa.gov/Datasets/cmap/enh/precip.mon.ltm.nc"
RAW_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"
RAW_FILE = RAW_DIR / "precip.mon.ltm.nc"


def download_source() -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if RAW_FILE.exists():
        print(f"Using cached {RAW_FILE}")
        return RAW_FILE
    print(f"Downloading {SOURCE_URL}")
    urllib.request.urlretrieve(SOURCE_URL, RAW_FILE)
    print(f"Saved to {RAW_FILE}")
    return RAW_FILE


def build(out_path: Path) -> None:
    src = download_source()

    with h5py.File(src, "r") as f:
        lat = f["lat"][:].astype(float)      # 88.75 .. -88.75, descending
        lon = f["lon"][:].astype(float)      # 1.25 .. 358.75 (0-360 convention)
        precip = f["precip"][:].astype(float)  # (12, 72, 144) mm/day
        missing = float(f["precip"].attrs["missing_value"][0])
        valid_yr_count = f["valid_yr_count"][:]  # (12, 72, 144) years of data behind each mean
        climo_period = f["time"].attrs["climo_period"].decode()  # e.g. "1991/01/01 - 2020/12/31"

    n_months, n_lat, n_lon = precip.shape
    cell_size = 2.5

    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()

    conn = sqlite3.connect(out_path)
    conn.execute(
        """
        CREATE TABLE cells (
            id INTEGER PRIMARY KEY,
            row INTEGER NOT NULL,
            col INTEGER NOT NULL,
            lat_min REAL NOT NULL,
            lat_max REAL NOT NULL,
            lon_min REAL NOT NULL,
            lon_max REAL NOT NULL,
            lat_center REAL NOT NULL,
            lon_center REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE monthly_precip (
            cell_id INTEGER NOT NULL REFERENCES cells(id),
            month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
            precip_mm_day REAL,
            valid_yr_count INTEGER,
            PRIMARY KEY (cell_id, month)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE meta (
            key TEXT PRIMARY KEY,
            value TEXT
        )
        """
    )

    cell_rows = []
    precip_rows = []
    for row in range(n_lat):
        lat_center = lat[row]
        lat_min = lat_center - cell_size / 2
        lat_max = lat_center + cell_size / 2
        for col in range(n_lon):
            lon_center = lon[col]
            if lon_center > 180:
                lon_center -= 360
            lon_min = lon_center - cell_size / 2
            lon_max = lon_center + cell_size / 2
            cell_id = row * n_lon + col
            cell_rows.append(
                (cell_id, row, col, lat_min, lat_max, lon_min, lon_max, lat_center, lon_center)
            )
            for month in range(n_months):
                value = precip[month, row, col]
                if value == missing or not np.isfinite(value):
                    continue
                precip_rows.append(
                    (cell_id, month + 1, float(value), int(valid_yr_count[month, row, col]))
                )

    conn.executemany(
        "INSERT INTO cells VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", cell_rows
    )
    conn.executemany(
        "INSERT INTO monthly_precip VALUES (?, ?, ?, ?)", precip_rows
    )
    conn.executemany(
        "INSERT INTO meta VALUES (?, ?)",
        [
            ("source", "NOAA PSL CMAP long-term monthly climatology (public domain)"),
            ("source_url", "https://psl.noaa.gov/data/gridded/data.cmap.html"),
            ("units", "mm/day"),
            ("cell_size_deg", str(cell_size)),
            ("grid_shape", f"{n_lat}x{n_lon}"),
            ("climatology_period", climo_period),
        ],
    )
    conn.commit()
    conn.close()

    print(f"Wrote {len(cell_rows)} cells, {len(precip_rows)} monthly values to {out_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "data" / "precip_grid.sqlite",
    )
    args = parser.parse_args()
    build(args.out)
