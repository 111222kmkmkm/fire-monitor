#!/usr/bin/env python

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "backfill-fire-training-history.json"
SEGMENT_PATTERN = re.compile(
    r"^HS_H09_(?P<date>\d{8})_(?P<time>\d{4})_B(?P<band>\d{2})_FLDK_.*_S(?P<segment>\d{2})10\.DAT\.bz2$"
)


def main() -> None:
    args = parse_args()
    config = load_json(resolve_path(args.config))
    module = load_process_module(resolve_path(config.get("processScriptPath", "./scripts/process-himawari-fire.py")))
    process_config = load_json(resolve_path(config.get("processConfigPath", "./config/process-himawari-fire.json")))

    input_root = resolve_path(config.get("inputRoot", "./data-source/runtime-data/himawari9_ahi"))
    db_path = resolve_path(config.get("databasePath", "./fire_monitor.geodatabase"))
    source_sat = str(process_config.get("sourceSat", "H09"))
    visible_band = str(process_config.get("visibleBand", "03")).zfill(2)
    bands = [str(item).zfill(2) for item in process_config.get("bands", ["03", "07", "13", "14"])]
    thermal_bands = ["07", "13", "14"]
    min_segments_per_band = max(int(process_config.get("minSegmentsPerBand", 4)), 1)
    limit = max(int(config.get("limitSnapshots", 12)), 1)
    margin_pixels = max(int(process_config.get("cropMarginPixels", 24)), 0)

    roi = process_config.get("roi", {})
    roi_bbox = {
        "minLon": float(roi.get("minLon", 73.0)),
        "maxLon": float(roi.get("maxLon", 135.5)),
        "minLat": float(roi.get("minLat", 18.0)),
        "maxLat": float(roi.get("maxLat", 54.0)),
    }
    thresholds = {
        "suspiciousOffsetK": float(process_config.get("thresholds", {}).get("suspiciousOffsetK", 20)),
        "suspiciousVisibleFactor": float(process_config.get("thresholds", {}).get("suspiciousVisibleFactor", 100)),
        "minValidRatio": float(process_config.get("thresholds", {}).get("minValidRatio", 0.2)),
        "nightAbsoluteT7K": float(process_config.get("thresholds", {}).get("nightAbsoluteT7K", 360)),
        "nightVisibleMax": float(process_config.get("thresholds", {}).get("nightVisibleMax", 0.7)),
        "nightZenithDeg": float(process_config.get("thresholds", {}).get("nightZenithDeg", 87)),
        "cloudVisibleReflectance": float(process_config.get("thresholds", {}).get("cloudVisibleReflectance", 0.28)),
        "cloudZenithLimitDeg": float(process_config.get("thresholds", {}).get("cloudZenithLimitDeg", 70)),
        "cloudVisibleDelta": float(process_config.get("thresholds", {}).get("cloudVisibleDelta", 0.15)),
        "cloudT13DeltaK": float(process_config.get("thresholds", {}).get("cloudT13DeltaK", 5)),
        "edgeThresholdC": float(process_config.get("thresholds", {}).get("edgeThresholdC", 8)),
        "thermalSourceRadiusKm": float(process_config.get("thresholds", {}).get("thermalSourceRadiusKm", 4.0)),
        "minBackgroundPixels": float(process_config.get("thresholds", {}).get("minBackgroundPixels", 4)),
        "minStdT713K": float(process_config.get("thresholds", {}).get("minStdT713K", 2.0)),
        "maxStdT713K": float(process_config.get("thresholds", {}).get("maxStdT713K", 4.0)),
        "absoluteScoreScaleK": float(process_config.get("thresholds", {}).get("absoluteScoreScaleK", 10.0)),
        "confidenceHighScore": float(process_config.get("thresholds", {}).get("confidenceHighScore", 3.5)),
        "confidenceMediumScore": float(process_config.get("thresholds", {}).get("confidenceMediumScore", 2.0)),
    }
    window_sizes = [int(size) for size in process_config.get("windowSizes", [7, 9, 11, 19])]

    china_polygons = module.load_china_polygons(
        resolve_path(process_config.get("chinaBoundaryPath", "./public/data/china-boundary.geojson"))
    )
    non_vegetation_mask_path = resolve_path(process_config["nonVegetationMaskPath"])
    thermal_source_values = process_config.get("groundThermalSourcePaths")
    if not isinstance(thermal_source_values, list) or not thermal_source_values:
        thermal_source_values = [process_config["groundThermalSourcePath"]]
    ground_thermal_source_paths = [resolve_path(value) for value in thermal_source_values]
    thermal_source_db = module.load_static_thermal_source_databases(ground_thermal_source_paths)
    visible_reflectance_override = str(process_config.get("visibleReflectancePath", "")).strip()

    snapshots = discover_candidate_snapshots(input_root, bands, min_segments_per_band, limit)

    ensure_candidate_fire_cloud_detail_table(db_path)
    existing_times = load_existing_acquisition_times(db_path)

    processed = 0
    skipped = 0
    inserted_rows = 0
    for snapshot_key, snapshot_files in snapshots:
        acquisition_time = module.snapshot_to_utc(snapshot_key)
        if config.get("skipExisting", True) and acquisition_time in existing_times:
            skipped += 1
            continue

        try:
            sample_segment = module.decode_segment(snapshot_files["07"][0])
            crop = module.compute_crop_bounds(
                sample_segment.projection,
                sample_segment.columns,
                sample_segment.total_segments * sample_segment.lines,
                roi_bbox,
                margin_pixels,
            )

            band_rasters: dict[str, Any] = {}
            for band in thermal_bands:
                band_rasters[band] = module.load_cropped_band(snapshot_files[band], crop, "bt")

            lon_grid, lat_grid, scene_mask = module.build_lon_lat_grid(sample_segment.projection, crop)
            roi_mask = (
                scene_mask
                & (lon_grid >= roi_bbox["minLon"])
                & (lon_grid <= roi_bbox["maxLon"])
                & (lat_grid >= roi_bbox["minLat"])
                & (lat_grid <= roi_bbox["maxLat"])
            )
            for band in thermal_bands:
                band_rasters[band][~roi_mask] = module.np.nan

            if visible_reflectance_override:
                rvis = module.load_support_raster(
                    resolve_path(visible_reflectance_override),
                    expected_shape=lon_grid.shape,
                    value_name="visible reflectance",
                )
            else:
                rvis = module.load_resampled_band(
                    snapshot_files[visible_band],
                    lon_grid,
                    lat_grid,
                    roi_mask,
                    roi_bbox,
                    margin_pixels,
                    "reflectance",
                )
            rvis[~roi_mask] = module.np.nan

            solar = module.build_solar_geometry(acquisition_time, lon_grid, lat_grid)
            non_vegetation_mask = module.load_support_mask(
                non_vegetation_mask_path,
                lon_grid,
                lat_grid,
                roi_mask,
                "non-vegetation mask",
            )

            detection = module.detect_fire_pixels(
                acquisition_time=acquisition_time,
                source_sat=source_sat,
                b07=band_rasters["07"],
                b13=band_rasters["13"],
                b14=band_rasters["14"],
                rvis=rvis,
                lon_grid=lon_grid,
                lat_grid=lat_grid,
                roi_mask=roi_mask,
                solar=solar,
                window_sizes=window_sizes,
                thresholds=thresholds,
                snapshot_key=snapshot_key,
                non_vegetation_mask=non_vegetation_mask,
                thermal_source_db=thermal_source_db,
            )
            fires = [
                fire for fire in detection["fires"]
                if module.point_in_any_polygon(fire["lon"], fire["lat"], china_polygons)
            ]
            module.upsert_candidate_fire_rows(db_path, fires, acquisition_time, source_sat)
            upsert_candidate_fire_cloud_detail_rows(db_path, fires, acquisition_time, snapshot_key)
            inserted_rows += len(fires)
            processed += 1
            print(f"[backfill-fire-training-history] snapshot={snapshot_key} fires={len(fires)}")
        except Exception as error:
            skipped += 1
            print(f"[backfill-fire-training-history] skipped snapshot={snapshot_key}: {error}")

    print(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "processedSnapshots": processed,
                "skippedSnapshots": skipped,
                "insertedFireRows": inserted_rows,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill historical Himawari fire detections for ML training.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    return parser.parse_args()


def load_process_module(module_path: Path):
    spec = importlib.util.spec_from_file_location("process_himawari_fire", module_path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"failed to load process module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def resolve_path(path_str: str) -> Path:
    path = Path(path_str)
    return path if path.is_absolute() else (PROJECT_ROOT / path).resolve()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def ensure_candidate_fire_cloud_detail_table(db_path: Path) -> None:
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS candidate_fire_cloud_detail (
              objectid INTEGER PRIMARY KEY AUTOINCREMENT,
              acq_time_utc TEXT NOT NULL,
              snapshot_key TEXT,
              scene_id TEXT,
              source_sat TEXT,
              daynight TEXT,
              fire_status TEXT,
              confidence TEXT,
              score REAL,
              bt_tir REAL,
              bt_dif REAL,
              dynamic_factor REAL,
              pc REAL,
              pv REAL,
              t7_bg REAL,
              std_t7 REAL,
              rvis REAL,
              rvis_bg REAL,
              t13_bg REAL,
              t713_bg REAL,
              std_t713 REAL,
              window_size REAL,
              absolute_threshold_passed INTEGER,
              dynamic_threshold_passed INTEGER,
              static_thermal_source_rejected INTEGER,
              lon REAL NOT NULL,
              lat REAL NOT NULL,
              attributes_json TEXT,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        connection.commit()


def discover_candidate_snapshots(
    input_root: Path,
    bands: list[str],
    min_segments_per_band: int,
    limit: int,
) -> list[tuple[str, dict[str, list[Path]]]]:
    snapshots: list[tuple[str, dict[str, list[Path]]]] = []
    directories = sorted([item for item in input_root.iterdir() if item.is_dir()])
    for snapshot_dir in directories:
        grouped: dict[str, list[tuple[int, Path]]] = {band: [] for band in bands}
        for file_path in snapshot_dir.iterdir():
            if not file_path.is_file() or ".partial-" in file_path.name:
                continue
            match = SEGMENT_PATTERN.match(file_path.name)
            if not match:
                continue
            band = match.group("band")
            if band not in grouped:
                continue
            grouped[band].append((int(match.group("segment")), file_path))
        if all(len(grouped[band]) >= min_segments_per_band for band in bands):
            snapshots.append(
                (
                    snapshot_dir.name,
                    {
                        band: [item[1] for item in sorted(grouped[band], key=lambda value: value[0])]
                        for band in bands
                    },
                )
            )
    return snapshots[:limit]


def load_existing_acquisition_times(db_path: Path) -> set[str]:
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            "SELECT DISTINCT acq_time_utc FROM candidate_fire_cloud_detail"
        ).fetchall()
    return {str(row[0]) for row in rows}


def upsert_candidate_fire_cloud_detail_rows(
    db_path: Path,
    fires: list[dict[str, Any]],
    acquisition_time: str,
    snapshot_key: str,
) -> None:
    with sqlite3.connect(db_path) as connection:
        connection.execute("BEGIN")
        connection.execute("DELETE FROM candidate_fire_cloud_detail WHERE acq_time_utc = ?", (acquisition_time,))
        for fire in fires:
            diagnostics = dict(fire.get("diagnostics", {}))
            payload = {
                "sourceSat": fire.get("sourceSat"),
                "acqTimeUtc": fire.get("acqTimeUtc"),
                "daynight": fire.get("daynight"),
                "fireStatus": fire.get("fireStatus"),
                "confidence": fire.get("confidence"),
                "score": fire.get("score"),
                "btTir": fire.get("btTir"),
                "btDif": fire.get("btDif"),
                "sceneId": fire.get("sceneId"),
                **diagnostics,
            }
            connection.execute(
                """
                INSERT INTO candidate_fire_cloud_detail (
                  acq_time_utc,
                  snapshot_key,
                  scene_id,
                  source_sat,
                  daynight,
                  fire_status,
                  confidence,
                  score,
                  bt_tir,
                  bt_dif,
                  dynamic_factor,
                  pc,
                  pv,
                  t7_bg,
                  std_t7,
                  rvis,
                  rvis_bg,
                  t13_bg,
                  t713_bg,
                  std_t713,
                  window_size,
                  absolute_threshold_passed,
                  dynamic_threshold_passed,
                  static_thermal_source_rejected,
                  lon,
                  lat,
                  attributes_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    acquisition_time,
                    snapshot_key,
                    fire.get("sceneId"),
                    fire.get("sourceSat"),
                    fire.get("daynight"),
                    fire.get("fireStatus"),
                    fire.get("confidence"),
                    fire.get("score"),
                    fire.get("btTir"),
                    fire.get("btDif"),
                    diagnostics.get("dynamicFactor"),
                    diagnostics.get("pc"),
                    diagnostics.get("pv"),
                    diagnostics.get("t7Bg"),
                    diagnostics.get("stdT7"),
                    diagnostics.get("rvis"),
                    diagnostics.get("rvisBg"),
                    diagnostics.get("t13Bg"),
                    diagnostics.get("t713Bg"),
                    diagnostics.get("stdT713"),
                    diagnostics.get("windowSize"),
                    bool_to_int(diagnostics.get("absoluteThresholdPassed")),
                    bool_to_int(diagnostics.get("dynamicThresholdPassed")),
                    bool_to_int(diagnostics.get("staticThermalSourceRejected")),
                    fire.get("lon"),
                    fire.get("lat"),
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                ),
            )
        connection.commit()


def bool_to_int(value: Any) -> int | None:
    if value is True:
        return 1
    if value is False:
        return 0
    return None


if __name__ == "__main__":
    main()
