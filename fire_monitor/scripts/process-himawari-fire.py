#!/usr/bin/env python

from __future__ import annotations

import argparse
import bz2
import csv
import json
import math
import re
import sqlite3
import struct
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "process-himawari-fire.json"
SEGMENT_PATTERN = re.compile(
    r"^HS_H09_(?P<date>\d{8})_(?P<time>\d{4})_B(?P<band>\d{2})_FLDK_.*_S(?P<segment>\d{2})10\.DAT\.bz2$"
)
PLANCK_C1 = 1.191042972e8
PLANCK_C2 = 1.4387769e4
ALGORITHM_VERSION = "nsmc-himawari-contextual-v2"
METHOD_REFERENCES = [
    "https://doi.org/10.5194/essd-15-1911-2023",
    "https://doi.org/10.5194/essd-14-3489-2022",
    "https://doi.org/10.1016/j.rse.2016.02.054",
    "https://doi.org/10.1016/j.rse.2013.12.008",
]


@dataclass
class Projection:
    sub_lon_deg: float
    cfac: int
    lfac: int
    coff: float
    loff: float
    satellite_height_km: float
    equatorial_radius_km: float
    polar_radius_km: float


@dataclass
class Calibration:
    band_number: int
    central_wavelength_um: float
    count_slope: float
    count_intercept: float
    albedo_coeff: float
    c0: float
    c1: float
    c2: float
    error_count: int
    outside_count: int


@dataclass
class SegmentData:
    acquisition_time: str
    segment_number: int
    total_segments: int
    first_line_number: int
    projection: Projection
    calibration: Calibration
    columns: int
    lines: int
    counts: np.ndarray


def main() -> None:
    args = parse_args()
    config = load_json(resolve_path(PROJECT_ROOT, args.config))
    process_latest_snapshot(config)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Decode Himawari HSD segments and publish fire candidates.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    return parser.parse_args()


def process_latest_snapshot(config: dict[str, Any]) -> None:
    validate_paper_strict_inputs(config)
    input_root = resolve_path(PROJECT_ROOT, config.get("inputRoot", "./data-source/runtime-data/himawari9_ahi"))
    output_dir = resolve_path(PROJECT_ROOT, config.get("outputDir", "./public/data/algorithm/latest"))
    state_path = resolve_path(PROJECT_ROOT, config.get("statePath", "./data-store/algorithm-state/himawari-fire.json"))
    china_boundary_path = resolve_path(PROJECT_ROOT, config.get("chinaBoundaryPath", "./public/data/china-boundary.geojson"))
    db_path = resolve_path(PROJECT_ROOT, config["databasePath"]) if config.get("databasePath") else None
    source_sat = str(config.get("sourceSat", "H09"))
    visible_band = str(config.get("visibleBand", "03")).zfill(2)
    bands = [str(item).zfill(2) for item in config.get("bands", ["03", "07", "13", "14"])]
    thermal_bands = ["07", "13", "14"]
    min_segments_per_band = max(int(config.get("minSegmentsPerBand", 10)), 1)
    required_segments = {
        int(str(item)) for item in config.get("requiredSegments", [])
        if str(item).strip()
    }
    max_snapshot_age_minutes = max(int(config.get("maxSnapshotAgeMinutes", 20)), 1)
    output_dir.mkdir(parents=True, exist_ok=True)
    state_path.parent.mkdir(parents=True, exist_ok=True)

    snapshot_key, snapshot_files = find_latest_complete_snapshot(
        input_root,
        bands,
        min_segments_per_band,
        required_segments,
    )
    acquisition_time = snapshot_to_utc(snapshot_key)
    acquisition_dt = datetime.fromisoformat(acquisition_time.replace("Z", "+00:00"))
    snapshot_age_minutes = (datetime.now(timezone.utc) - acquisition_dt).total_seconds() / 60.0
    roi = config.get("roi", {})
    roi_bbox = {
        "minLon": float(roi.get("minLon", 73.0)),
        "maxLon": float(roi.get("maxLon", 135.5)),
        "minLat": float(roi.get("minLat", 18.0)),
        "maxLat": float(roi.get("maxLat", 54.0)),
    }
    china_polygons = load_china_polygons(china_boundary_path)
    non_vegetation_mask_path = resolve_path(PROJECT_ROOT, config["nonVegetationMaskPath"])
    thermal_source_values = config.get("groundThermalSourcePaths")
    if not isinstance(thermal_source_values, list) or not thermal_source_values:
        thermal_source_values = [config["groundThermalSourcePath"]]
    ground_thermal_source_paths = [resolve_path(PROJECT_ROOT, value) for value in thermal_source_values]
    margin_pixels = max(int(config.get("cropMarginPixels", 24)), 0)

    sample_segment = decode_segment(snapshot_files["07"][0])
    crop = compute_crop_bounds(sample_segment.projection, sample_segment.columns, sample_segment.total_segments * sample_segment.lines, roi_bbox, margin_pixels)

    band_rasters: dict[str, np.ndarray] = {}
    for band in thermal_bands:
        band_rasters[band] = load_cropped_band(snapshot_files[band], crop, "bt")

    lon_grid, lat_grid, scene_mask = build_lon_lat_grid(sample_segment.projection, crop)
    roi_mask = (
        scene_mask
        & np.isfinite(lon_grid)
        & np.isfinite(lat_grid)
        & (lon_grid >= roi_bbox["minLon"])
        & (lon_grid <= roi_bbox["maxLon"])
        & (lat_grid >= roi_bbox["minLat"])
        & (lat_grid <= roi_bbox["maxLat"])
    )

    for band in thermal_bands:
        band_rasters[band][~roi_mask] = np.nan

    if config.get("visibleReflectancePath"):
        rvis = load_support_raster(
            resolve_path(PROJECT_ROOT, config["visibleReflectancePath"]),
            expected_shape=lon_grid.shape,
            value_name="visible reflectance",
        )
    else:
        rvis = load_resampled_band(
            snapshot_files[visible_band],
            lon_grid,
            lat_grid,
            roi_mask,
            roi_bbox,
            margin_pixels,
            "reflectance",
        )
    rvis[~roi_mask] = np.nan

    solar = build_solar_geometry(acquisition_time, lon_grid, lat_grid)
    non_vegetation_mask = load_support_mask(non_vegetation_mask_path, lon_grid, lat_grid, roi_mask, "non-vegetation mask")
    thermal_source_db = load_static_thermal_source_databases(ground_thermal_source_paths)
    thresholds = {
        "suspiciousOffsetK": float(config.get("thresholds", {}).get("suspiciousOffsetK", 20)),
        "suspiciousVisibleFactor": float(config.get("thresholds", {}).get("suspiciousVisibleFactor", 100)),
        "minValidRatio": float(config.get("thresholds", {}).get("minValidRatio", 0.2)),
        "nightAbsoluteT7K": float(config.get("thresholds", {}).get("nightAbsoluteT7K", 360)),
        "nightVisibleMax": float(config.get("thresholds", {}).get("nightVisibleMax", 0.7)),
        "nightZenithDeg": float(config.get("thresholds", {}).get("nightZenithDeg", 87)),
        "cloudVisibleReflectance": float(config.get("thresholds", {}).get("cloudVisibleReflectance", 0.28)),
        "cloudZenithLimitDeg": float(config.get("thresholds", {}).get("cloudZenithLimitDeg", 70)),
        "cloudVisibleDelta": float(config.get("thresholds", {}).get("cloudVisibleDelta", 0.15)),
        "cloudT13DeltaK": float(config.get("thresholds", {}).get("cloudT13DeltaK", 5)),
        "edgeThresholdC": float(config.get("thresholds", {}).get("edgeThresholdC", 8)),
        "thermalSourceRadiusKm": float(config.get("thresholds", {}).get("thermalSourceRadiusKm", 4.0)),
        "minBackgroundPixels": float(config.get("thresholds", {}).get("minBackgroundPixels", 4)),
        "minStdT713K": float(config.get("thresholds", {}).get("minStdT713K", 2.0)),
        "maxStdT713K": float(config.get("thresholds", {}).get("maxStdT713K", 4.0)),
        "absoluteScoreScaleK": float(config.get("thresholds", {}).get("absoluteScoreScaleK", 10.0)),
        "confidenceHighScore": float(config.get("thresholds", {}).get("confidenceHighScore", 3.5)),
        "confidenceMediumScore": float(config.get("thresholds", {}).get("confidenceMediumScore", 2.0)),
    }
    window_sizes = [int(size) for size in config.get("windowSizes", [7, 9, 11, 19])]

    detection = detect_fire_pixels(
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
    filtered_fires = [
        fire for fire in detection["fires"]
        if point_in_any_polygon(fire["lon"], fire["lat"], china_polygons)
    ]
    detection["fires"] = filtered_fires

    stale = snapshot_age_minutes > max_snapshot_age_minutes
    if stale and bool(config.get("failOnStaleSnapshot", False)):
        raise RuntimeError(
            f"latest usable snapshot is stale: age={snapshot_age_minutes:.1f} min, "
            f"threshold={max_snapshot_age_minutes} min"
        )

    notes = list(detection["notes"])
    if stale:
        notes.append(
            f"latest usable snapshot is stale: age={snapshot_age_minutes:.1f} min, threshold={max_snapshot_age_minutes} min"
        )

    geojson = {
        "type": "FeatureCollection",
        "features": [to_feature(item) for item in detection["fires"]],
    }
    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "snapshotKey": snapshot_key,
        "acquisitionTime": acquisition_time,
        "sourceSat": source_sat,
        "fireCount": len(detection["fires"]),
        "cloudPixelCount": detection["cloudPixelCount"],
        "stale": stale,
        "snapshotAgeMinutes": round(snapshot_age_minutes, 1),
        "confidenceCounts": summarize_confidence_counts(detection["fires"]),
        "algorithmVersion": ALGORITHM_VERSION,
        "algorithmMode": str(config.get("algorithmMode", "paper-adapted")),
        "methodReferences": METHOD_REFERENCES,
        "paperStrictMode": bool(config.get("paperStrictMode", True)),
        "thresholds": thresholds,
        "roi": roi_bbox,
        "crop": crop,
        "notes": notes,
    }

    write_json(output_dir / "candidate_fire.geojson", geojson)
    write_json(output_dir / "candidate_fire_summary.json", summary)
    write_json(state_path, {"snapshotKey": snapshot_key, "acquisitionTime": acquisition_time, "fireCount": len(detection["fires"])})
    mirror_public_output_to_dist(output_dir / "candidate_fire.geojson")
    mirror_public_output_to_dist(output_dir / "candidate_fire_summary.json")

    if db_path:
        upsert_candidate_fire_rows(db_path, detection["fires"], acquisition_time, source_sat)

    print(f"[process-himawari-fire] snapshot={snapshot_key} fire_count={len(detection['fires'])}")


def find_latest_complete_snapshot(
    input_root: Path,
    bands: list[str],
    min_segments_per_band: int,
    required_segments: set[int] | None = None,
) -> tuple[str, dict[str, list[Path]]]:
    return find_recent_complete_snapshots(input_root, bands, min_segments_per_band, 1, required_segments)[0]


def find_recent_complete_snapshots(
    input_root: Path,
    bands: list[str],
    min_segments_per_band: int,
    limit: int,
    required_segments: set[int] | None = None,
) -> list[tuple[str, dict[str, list[Path]]]]:
    if not input_root.exists():
        raise FileNotFoundError(f"input root not found: {input_root}")

    recent: list[tuple[str, dict[str, list[Path]]]] = []
    snapshot_dirs = sorted([item for item in input_root.iterdir() if item.is_dir()], key=lambda item: item.name, reverse=True)
    for snapshot_dir in snapshot_dirs:
        grouped: dict[str, list[tuple[int, Path]]] = {band: [] for band in bands}
        for file_path in snapshot_dir.iterdir():
            match = SEGMENT_PATTERN.match(file_path.name)
            if not match:
                continue
            band = match.group("band")
            if band not in grouped:
                continue
            grouped[band].append((int(match.group("segment")), file_path))
        has_minimum_count = all(len(grouped[band]) >= min_segments_per_band for band in bands)
        has_required_segments = not required_segments or all(
            required_segments.issubset({segment for segment, _ in grouped[band]})
            for band in bands
        )
        if has_minimum_count and has_required_segments:
            resolved = {
                band: [item[1] for item in sorted(grouped[band], key=lambda value: value[0])]
                for band in bands
            }
            if snapshot_is_usable(resolved):
                recent.append((snapshot_dir.name, resolved))
                if len(recent) >= limit:
                    return recent
    if recent:
        return recent
    raise RuntimeError("no complete Himawari snapshot was found")


def snapshot_is_usable(snapshot_files: dict[str, list[Path]]) -> bool:
    for band_files in snapshot_files.values():
        for file_path in band_files:
            try:
                with bz2.open(file_path, "rb") as stream:
                    while stream.read(1024 * 1024):
                        pass
            except OSError:
                return False
            except EOFError:
                return False
            except ValueError:
                return False
    return True


def snapshot_to_utc(snapshot_key: str) -> str:
    parsed = datetime.strptime(snapshot_key, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    return parsed.isoformat().replace("+00:00", "Z")


def decode_segment(file_path: Path) -> SegmentData:
    raw = bz2.decompress(file_path.read_bytes())
    block_offsets: list[tuple[int, int, int]] = []
    position = 0
    for _ in range(11):
        block_number, block_length = struct.unpack_from("<BH", raw, position)
        block_offsets.append((block_number, block_length, position))
        position += block_length

    basic_position = block_offsets[1][2]
    columns = struct.unpack_from("<H", raw, basic_position + 5)[0]
    lines = struct.unpack_from("<H", raw, basic_position + 7)[0]

    projection_position = block_offsets[2][2]
    projection = Projection(
        sub_lon_deg=struct.unpack_from("<d", raw, projection_position + 3)[0],
        cfac=struct.unpack_from("<i", raw, projection_position + 11)[0],
        lfac=struct.unpack_from("<i", raw, projection_position + 15)[0],
        coff=struct.unpack_from("<f", raw, projection_position + 19)[0],
        loff=struct.unpack_from("<f", raw, projection_position + 23)[0],
        satellite_height_km=struct.unpack_from("<d", raw, projection_position + 27)[0],
        equatorial_radius_km=struct.unpack_from("<d", raw, projection_position + 35)[0],
        polar_radius_km=struct.unpack_from("<d", raw, projection_position + 43)[0],
    )

    calibration_position = block_offsets[4][2]
    calibration = Calibration(
        band_number=struct.unpack_from("<H", raw, calibration_position + 3)[0],
        central_wavelength_um=struct.unpack_from("<d", raw, calibration_position + 5)[0],
        count_slope=struct.unpack_from("<d", raw, calibration_position + 19)[0],
        count_intercept=struct.unpack_from("<d", raw, calibration_position + 27)[0],
        albedo_coeff=struct.unpack_from("<d", raw, calibration_position + 35)[0],
        c0=struct.unpack_from("<d", raw, calibration_position + 35)[0],
        c1=struct.unpack_from("<d", raw, calibration_position + 43)[0],
        c2=struct.unpack_from("<d", raw, calibration_position + 51)[0],
        error_count=struct.unpack_from("<H", raw, calibration_position + 15)[0],
        outside_count=struct.unpack_from("<H", raw, calibration_position + 17)[0],
    )

    segment_position = block_offsets[6][2]
    total_segments = struct.unpack_from("<B", raw, segment_position + 3)[0]
    segment_number = struct.unpack_from("<B", raw, segment_position + 4)[0]
    first_line_number = struct.unpack_from("<H", raw, segment_position + 5)[0]

    counts = np.frombuffer(raw, dtype="<u2", offset=position).reshape(lines, columns)

    match = SEGMENT_PATTERN.match(file_path.name)
    if not match:
        raise RuntimeError(f"unrecognized segment filename: {file_path.name}")
    acquisition_time = snapshot_to_utc(f"{match.group('date')}{match.group('time')}")

    return SegmentData(
        acquisition_time=acquisition_time,
        segment_number=segment_number,
        total_segments=total_segments,
        first_line_number=first_line_number,
        projection=projection,
        calibration=calibration,
        columns=columns,
        lines=lines,
        counts=counts,
    )


def compute_crop_bounds(projection: Projection, full_columns: int, full_lines: int, roi_bbox: dict[str, float], margin_pixels: int) -> dict[str, int]:
    sample_points = [
        (roi_bbox["minLon"], roi_bbox["minLat"]),
        (roi_bbox["minLon"], roi_bbox["maxLat"]),
        (roi_bbox["maxLon"], roi_bbox["minLat"]),
        (roi_bbox["maxLon"], roi_bbox["maxLat"]),
        ((roi_bbox["minLon"] + roi_bbox["maxLon"]) / 2, (roi_bbox["minLat"] + roi_bbox["maxLat"]) / 2),
    ]
    columns = []
    lines = []
    for lon, lat in sample_points:
        col, line = lonlat_to_colline(lon, lat, projection)
        columns.append(col)
        lines.append(line)

    col_start = max(int(math.floor(min(columns))) - margin_pixels, 1)
    col_end = min(int(math.ceil(max(columns))) + margin_pixels, full_columns)
    line_start = max(int(math.floor(min(lines))) - margin_pixels, 1)
    line_end = min(int(math.ceil(max(lines))) + margin_pixels, full_lines)

    return {
        "lineStart": line_start,
        "lineEnd": line_end,
        "colStart": col_start,
        "colEnd": col_end,
        "height": line_end - line_start + 1,
        "width": col_end - col_start + 1,
    }


def lonlat_to_colline(lon_deg: float, lat_deg: float, projection: Projection) -> tuple[float, float]:
    lon_rad = math.radians(lon_deg - projection.sub_lon_deg)
    lat_rad = math.radians(lat_deg)
    req = projection.equatorial_radius_km
    rpol = projection.polar_radius_km
    phi_e = math.atan((rpol * rpol / (req * req)) * math.tan(lat_rad))
    re = rpol / math.sqrt(1 - (1 - (rpol * rpol) / (req * req)) * (math.cos(phi_e) ** 2))
    r1 = projection.satellite_height_km - re * math.cos(phi_e) * math.cos(lon_rad)
    r2 = -re * math.cos(phi_e) * math.sin(lon_rad)
    r3 = re * math.sin(phi_e)
    rn = math.sqrt(r1 * r1 + r2 * r2 + r3 * r3)
    x_deg = math.degrees(math.atan2(-r2, r1))
    y_deg = math.degrees(math.asin(-r3 / rn))
    column = projection.coff + x_deg * projection.cfac / (2 ** 16)
    line = projection.loff + y_deg * projection.lfac / (2 ** 16)
    return column, line


def lonlat_to_colline_grid(lon_grid: np.ndarray, lat_grid: np.ndarray, projection: Projection) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    lon_rad = np.deg2rad(lon_grid - projection.sub_lon_deg)
    lat_rad = np.deg2rad(lat_grid)
    req = projection.equatorial_radius_km
    rpol = projection.polar_radius_km
    req2 = req * req
    rpol2 = rpol * rpol

    phi_e = np.arctan((rpol2 / req2) * np.tan(lat_rad))
    re = rpol / np.sqrt(1 - (1 - rpol2 / req2) * (np.cos(phi_e) ** 2))
    r1 = projection.satellite_height_km - re * np.cos(phi_e) * np.cos(lon_rad)
    r2 = -re * np.cos(phi_e) * np.sin(lon_rad)
    r3 = re * np.sin(phi_e)
    rn = np.sqrt(r1 * r1 + r2 * r2 + r3 * r3)
    visible = (projection.satellite_height_km * (projection.satellite_height_km - r1)) > (r2 * r2 + (req2 / rpol2) * r3 * r3)

    x_deg = np.rad2deg(np.arctan2(-r2, r1))
    y_deg = np.rad2deg(np.arcsin(-r3 / rn))
    column = projection.coff + x_deg * projection.cfac / (2 ** 16)
    line = projection.loff + y_deg * projection.lfac / (2 ** 16)
    column = column.astype(np.float32)
    line = line.astype(np.float32)
    column[~visible] = np.nan
    line[~visible] = np.nan
    return column, line, visible


def load_resampled_band(
    segment_paths: list[Path],
    target_lon_grid: np.ndarray,
    target_lat_grid: np.ndarray,
    target_mask: np.ndarray,
    roi_bbox: dict[str, float],
    margin_pixels: int,
    value_kind: str,
) -> np.ndarray:
    sample_segment = decode_segment(segment_paths[0])
    full_lines = sample_segment.total_segments * sample_segment.lines
    source_crop = compute_crop_bounds(sample_segment.projection, sample_segment.columns, full_lines, roi_bbox, margin_pixels)
    source_raster = load_cropped_band(segment_paths, source_crop, value_kind)
    source_col, source_line, source_visible = lonlat_to_colline_grid(target_lon_grid, target_lat_grid, sample_segment.projection)

    source_row_index = np.zeros(target_lon_grid.shape, dtype=np.int32)
    source_col_index = np.zeros(target_lon_grid.shape, dtype=np.int32)
    finite = np.isfinite(source_col) & np.isfinite(source_line)
    source_row_index[finite] = np.rint(source_line[finite]).astype(np.int32) - source_crop["lineStart"]
    source_col_index[finite] = np.rint(source_col[finite]).astype(np.int32) - (source_crop["colStart"] - 1)
    valid = (
        target_mask
        & source_visible
        & finite
        & (source_row_index >= 0)
        & (source_row_index < source_raster.shape[0])
        & (source_col_index >= 0)
        & (source_col_index < source_raster.shape[1])
    )

    result = np.full(target_lon_grid.shape, np.nan, dtype=np.float32)
    result[valid] = source_raster[source_row_index[valid], source_col_index[valid]]
    return result


def load_cropped_band(segment_paths: list[Path], crop: dict[str, int], value_kind: str) -> np.ndarray:
    raster = np.full((crop["height"], crop["width"]), np.nan, dtype=np.float32)
    for file_path in segment_paths:
        segment = decode_segment(file_path)
        line_start = segment.first_line_number
        line_end = segment.first_line_number + segment.lines - 1
        overlap_start = max(crop["lineStart"], line_start)
        overlap_end = min(crop["lineEnd"], line_end)
        if overlap_start > overlap_end:
            continue

        source_rows = slice(overlap_start - line_start, overlap_end - line_start + 1)
        target_rows = slice(overlap_start - crop["lineStart"], overlap_end - crop["lineStart"] + 1)
        source_cols = slice(crop["colStart"] - 1, crop["colEnd"])
        counts = segment.counts[source_rows, source_cols]
        raster[target_rows, :] = counts_to_physical_value(counts, segment.calibration, value_kind)
    return raster


def counts_to_physical_value(counts: np.ndarray, calibration: Calibration, value_kind: str) -> np.ndarray:
    if value_kind == "reflectance":
        return counts_to_reflectance(counts, calibration)
    if value_kind == "bt":
        return counts_to_bt(counts, calibration)
    raise ValueError(f"unsupported value kind: {value_kind}")


def counts_to_reflectance(counts: np.ndarray, calibration: Calibration) -> np.ndarray:
    radiance = calibration.count_slope * counts.astype(np.float64) + calibration.count_intercept
    invalid = (counts == calibration.error_count) | (counts == calibration.outside_count) | (radiance <= 0)
    reflectance = (radiance * calibration.albedo_coeff).astype(np.float32)
    reflectance[invalid] = np.nan
    reflectance[reflectance < 0] = np.nan
    return reflectance


def counts_to_bt(counts: np.ndarray, calibration: Calibration) -> np.ndarray:
    radiance = calibration.count_slope * counts.astype(np.float64) + calibration.count_intercept
    invalid = (counts == calibration.error_count) | (counts == calibration.outside_count) | (radiance <= 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        te = PLANCK_C2 / (
            calibration.central_wavelength_um
            * np.log1p(PLANCK_C1 / (radiance * (calibration.central_wavelength_um ** 5)))
        )
        bt = calibration.c0 + calibration.c1 * te + calibration.c2 * te * te
    bt = bt.astype(np.float32)
    bt[invalid] = np.nan
    return bt


def build_lon_lat_grid(projection: Projection, crop: dict[str, int]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    line_values = np.arange(crop["lineStart"], crop["lineEnd"] + 1, dtype=np.float64)[:, np.newaxis]
    col_values = np.arange(crop["colStart"], crop["colEnd"] + 1, dtype=np.float64)[np.newaxis, :]
    x = np.deg2rad((col_values - projection.coff) * (2 ** 16) / projection.cfac)
    y = np.deg2rad((projection.loff - line_values) * (2 ** 16) / projection.lfac)

    cos_x = np.cos(x)
    sin_x = np.sin(x)
    cos_y = np.cos(y)
    sin_y = np.sin(y)
    req = projection.equatorial_radius_km
    rpol = projection.polar_radius_km
    req2 = req * req
    rpol2 = rpol * rpol
    visible_term = (projection.satellite_height_km * cos_x * cos_y) ** 2 - (cos_y * cos_y + (req2 / rpol2) * sin_y * sin_y) * (projection.satellite_height_km ** 2 - req2)
    scene_mask = visible_term > 0
    visible_term = np.where(scene_mask, visible_term, np.nan)
    sd = np.sqrt(visible_term)
    sn = (projection.satellite_height_km * cos_x * cos_y - sd) / (cos_y * cos_y + (req2 / rpol2) * sin_y * sin_y)
    s1 = projection.satellite_height_km - sn * cos_x * cos_y
    s2 = sn * sin_x * cos_y
    s3 = sn * sin_y
    lon = projection.sub_lon_deg + np.rad2deg(np.arctan2(s2, s1))
    lat = np.rad2deg(np.arctan((req2 / rpol2) * s3 / np.sqrt(s1 * s1 + s2 * s2)))
    lon = lon.astype(np.float32)
    lat = lat.astype(np.float32)
    lon[~scene_mask] = np.nan
    lat[~scene_mask] = np.nan
    return lon, lat, scene_mask


def build_solar_geometry(acquisition_time: str, lon_grid: np.ndarray, lat_grid: np.ndarray) -> dict[str, np.ndarray]:
    timestamp = datetime.fromisoformat(acquisition_time.replace("Z", "+00:00"))
    day_of_year = int(timestamp.strftime("%j"))
    utc_hour = timestamp.hour + timestamp.minute / 60 + timestamp.second / 3600
    declination_rad = math.radians(23.45 * math.sin(math.radians((360 / 365) * (284 + day_of_year))))
    solar_time = utc_hour + lon_grid / 15.0
    hour_angle_rad = np.deg2rad(15.0 * (solar_time - 12.0))
    lat_rad = np.deg2rad(lat_grid)
    sin_altitude = np.sin(lat_rad) * math.sin(declination_rad) + np.cos(lat_rad) * math.cos(declination_rad) * np.cos(hour_angle_rad)
    sin_altitude = np.clip(sin_altitude, -1.0, 1.0)
    altitude_deg = np.rad2deg(np.arcsin(sin_altitude)).astype(np.float32)
    zenith_deg = (90.0 - altitude_deg).astype(np.float32)
    altitude_deg[~np.isfinite(lon_grid)] = np.nan
    zenith_deg[~np.isfinite(lon_grid)] = np.nan
    return {"altitudeDeg": altitude_deg, "zenithDeg": zenith_deg}


def detect_fire_pixels(
    *,
    acquisition_time: str,
    source_sat: str,
    b07: np.ndarray,
    b13: np.ndarray,
    b14: np.ndarray,
    rvis: np.ndarray,
    lon_grid: np.ndarray,
    lat_grid: np.ndarray,
    roi_mask: np.ndarray,
    solar: dict[str, np.ndarray],
    window_sizes: list[int],
    thresholds: dict[str, float],
    snapshot_key: str,
    non_vegetation_mask: np.ndarray,
    thermal_source_db: dict[str, Any],
) -> dict[str, Any]:
    notes = [
        "NSMC-Himawari contextual tests follow ESSD 15, 1911-1931 (2023), with an engineering nighttime fallback when visible reflectance is unavailable."
    ]
    t713 = b07 - b13
    thermal_valid = roi_mask & np.isfinite(b07) & np.isfinite(b13) & np.isfinite(b14)
    night_mask = solar["zenithDeg"] > thresholds["nightZenithDeg"]
    visible_valid = np.isfinite(rvis)
    valid = thermal_valid & (night_mask | visible_valid)
    cloud_mask = valid & (
        (t713 < 4)
        | ((t713 > 20) & ((b07 < 275) | (b13 < 270)))
        | (visible_valid & (rvis > thresholds["cloudVisibleReflectance"]) & (solar["zenithDeg"] < thresholds["cloudZenithLimitDeg"]))
        | (b14 < 265)
        | ((b13 < 270) & (((b13 - b14) < 4) | ((b13 - b14) > 60)))
    )
    suspicious_mask = valid & visible_valid & ~cloud_mask & (
        b07 >= b13 + rvis * thresholds["suspiciousVisibleFactor"] + thresholds["suspiciousOffsetK"]
    )
    night_absolute_mask = valid & ~cloud_mask & night_mask & (
        (b07 > thresholds["nightAbsoluteT7K"])
        & (~visible_valid | (rvis < thresholds["nightVisibleMax"]))
    )
    seed_mask = suspicious_mask | night_absolute_mask

    candidate_indices = np.argwhere(seed_mask)
    fires: list[dict[str, Any]] = []
    for row, col in candidate_indices:
        background = build_background_context(
            row,
            col,
            b07,
            b13,
            b14,
            rvis,
            t713,
            cloud_mask,
            valid,
            non_vegetation_mask,
            window_sizes,
            thresholds,
        )
        if background is None:
            continue

        altitude = float(solar["altitudeDeg"][row, col])
        zenith = float(solar["zenithDeg"][row, col])
        night_hot = bool(night_absolute_mask[row, col])
        dynamic_factor = compute_dynamic_threshold_factor(altitude, background["pv"], background["pc"])

        relative_hot = (
            float(b07[row, col]) > background["t7Bg"] + dynamic_factor * background["stdT7"]
            and float(t713[row, col]) > background["t713Bg"] + dynamic_factor * background["stdT713"]
        )
        if not night_hot and not relative_hot:
            continue

        cloud_rejected = bool(
            np.isfinite(rvis[row, col])
            and background["rvisFiniteCount"] > 0
            and float(rvis[row, col]) >= background["rvisBg"] + thresholds["cloudVisibleDelta"]
            and float(b13[row, col]) <= background["t13Bg"] - thresholds["cloudT13DeltaK"]
        )
        if cloud_rejected:
            continue

        edge_rejected = (
            float(b07[row, col]) <= background["t7Bg"] + thresholds["edgeThresholdC"] * background["stdT7"]
            and float(t713[row, col]) <= background["t713Bg"] + thresholds["edgeThresholdC"] * background["stdT713"]
        )
        if edge_rejected:
            continue

        static_source_rejected = matches_static_thermal_source(
            float(lon_grid[row, col]),
            float(lat_grid[row, col]),
            thermal_source_db,
            thresholds["thermalSourceRadiusKm"],
        )
        if static_source_rejected:
            continue

        evidence = compute_fire_evidence_score(
            t7=float(b07[row, col]),
            t713=float(t713[row, col]),
            background=background,
            dynamic_factor=dynamic_factor,
            night_hot=night_hot,
            thresholds=thresholds,
        )

        fires.append(
            {
                "row": int(row),
                "col": int(col),
                "sourceSat": source_sat,
                "acqTimeUtc": acquisition_time,
                "daynight": "N" if zenith > thresholds["nightZenithDeg"] else "D",
                "fireStatus": "suspected",
                "score": evidence["score"],
                "btTir": round(float(b07[row, col]), 2),
                "btDif": round(float(t713[row, col]), 2),
                "lon": round(float(lon_grid[row, col]), 6),
                "lat": round(float(lat_grid[row, col]), 6),
                "minx": round(float(lon_grid[row, col]), 6),
                "maxx": round(float(lon_grid[row, col]), 6),
                "miny": round(float(lat_grid[row, col]), 6),
                "maxy": round(float(lat_grid[row, col]), 6),
                "geomWkt": f"POINT ({float(lon_grid[row, col]):.6f} {float(lat_grid[row, col]):.6f})",
                "sceneId": snapshot_key,
                "diagnostics": {
                    "dynamicFactor": round(dynamic_factor, 3),
                    "pc": round(background["pc"], 3),
                    "pv": round(background["pv"], 3),
                    "t7Bg": round(background["t7Bg"], 2),
                    "stdT7": round(background["stdT7"], 2),
                    "rvis": round(float(rvis[row, col]), 4) if np.isfinite(rvis[row, col]) else None,
                    "rvisBg": round(background["rvisBg"], 4) if background["rvisFiniteCount"] > 0 else None,
                    "t13Bg": round(background["t13Bg"], 2),
                    "t713Bg": round(background["t713Bg"], 2),
                    "stdT713": round(background["stdT713"], 2),
                    "windowSize": background["windowSize"],
                    "absoluteThresholdPassed": night_hot,
                    "dynamicThresholdPassed": relative_hot,
                    "staticThermalSourceRejected": static_source_rejected,
                    "t7ThresholdExcessSigma": evidence["t7ThresholdExcessSigma"],
                    "t713ThresholdExcessSigma": evidence["t713ThresholdExcessSigma"],
                },
            }
        )

        fires[-1]["confidence"] = classify_confidence_from_score(fires[-1]["score"], thresholds)

    deduped_fires = suppress_nearby_duplicates(fires, radius_pixels=2)
    return {
        "fires": deduped_fires,
        "cloudPixelCount": int(np.count_nonzero(cloud_mask)),
        "notes": notes,
    }


def build_background_context(
    row: int,
    col: int,
    b07: np.ndarray,
    b13: np.ndarray,
    b14: np.ndarray,
    rvis: np.ndarray,
    t713: np.ndarray,
    cloud_mask: np.ndarray,
    valid: np.ndarray,
    non_vegetation_mask: np.ndarray,
    window_sizes: list[int],
    thresholds: dict[str, float],
) -> dict[str, float] | None:
    for window_size in window_sizes:
        radius = window_size // 2
        context = sample_background_window(
            row,
            col,
            radius,
            b07,
            b13,
            b14,
            rvis,
            t713,
            cloud_mask,
            valid,
            non_vegetation_mask,
            thresholds,
        )
        if context is not None:
            return context
    return None


def sample_background_window(
    row: int,
    col: int,
    radius: int,
    b07: np.ndarray,
    b13: np.ndarray,
    b14: np.ndarray,
    rvis: np.ndarray,
    t713: np.ndarray,
    cloud_mask: np.ndarray,
    valid: np.ndarray,
    non_vegetation_mask: np.ndarray,
    thresholds: dict[str, float],
) -> dict[str, float] | None:
    row_start = max(0, row - radius)
    row_end = min(b07.shape[0], row + radius + 1)
    col_start = max(0, col - radius)
    col_end = min(b07.shape[1], col + radius + 1)

    window_valid = valid[row_start:row_end, col_start:col_end].copy()
    center_row = row - row_start
    center_col = col - col_start
    window_valid[center_row, center_col] = False
    if not np.any(window_valid):
        return None

    window_b07 = b07[row_start:row_end, col_start:col_end]
    window_b13 = b13[row_start:row_end, col_start:col_end]
    window_b14 = b14[row_start:row_end, col_start:col_end]
    window_rvis = rvis[row_start:row_end, col_start:col_end]
    window_t713 = t713[row_start:row_end, col_start:col_end]
    window_cloud = cloud_mask[row_start:row_end, col_start:col_end]
    window_non_vegetation = non_vegetation_mask[row_start:row_end, col_start:col_end]
    clear_candidates = window_valid & ~window_cloud & np.isfinite(window_b07) & np.isfinite(window_b13) & np.isfinite(window_b14)
    candidate_count = int(np.count_nonzero(window_valid))
    if candidate_count <= 0:
        return None
    clear_count = int(np.count_nonzero(clear_candidates))
    min_valid = max(int(math.ceil(candidate_count * thresholds["minValidRatio"])), int(thresholds["minBackgroundPixels"]))
    if clear_count < min_valid:
        return None

    t7_threshold = float(np.nanpercentile(window_b07[clear_candidates], 80))
    rvis_for_threshold = np.where(np.isfinite(window_rvis), window_rvis, 0.0)
    suspicious = clear_candidates & (window_b07 >= t7_threshold) & (
        window_b07 >= window_b13 + rvis_for_threshold * thresholds["suspiciousVisibleFactor"] + thresholds["suspiciousOffsetK"]
    )
    available = clear_candidates & ~suspicious
    available_count = int(np.count_nonzero(available))
    if available_count < min_valid:
        return None
    return summarize_background_pixels(
        window_b07,
        window_b13,
        window_rvis,
        window_t713,
        window_cloud,
        window_valid,
        window_non_vegetation,
        available,
        radius * 2 + 1,
        thresholds,
    )


def summarize_background_pixels(
    window_b07: np.ndarray,
    window_b13: np.ndarray,
    window_rvis: np.ndarray,
    window_t713: np.ndarray,
    window_cloud: np.ndarray,
    window_valid: np.ndarray,
    window_non_vegetation: np.ndarray,
    available: np.ndarray,
    window_size: int,
    thresholds: dict[str, float],
) -> dict[str, float]:
    t7_values = window_b07[available]
    t13_values = window_b13[available]
    rvis_available = available & np.isfinite(window_rvis)
    rvis_values = window_rvis[rvis_available]
    t713_values = window_t713[available]
    total_window = max(int(np.count_nonzero(window_valid)), 1)
    return {
        "t7Bg": float(np.nanmean(t7_values)),
        "t13Bg": float(np.nanmean(t13_values)),
        "rvisBg": float(np.nanmean(rvis_values)) if rvis_values.size > 0 else 0.0,
        "t713Bg": float(np.nanmean(t713_values)),
        "stdT7": max(float(np.nanstd(t7_values)), 0.5),
        "stdT713": min(
            max(float(np.nanstd(t713_values)), thresholds["minStdT713K"]),
            thresholds["maxStdT713K"],
        ),
        "rvisFiniteCount": int(rvis_values.size),
        "pv": float(np.count_nonzero(window_non_vegetation & window_valid)) / total_window,
        "pc": float(np.count_nonzero(window_cloud & window_valid)) / total_window,
        "windowSize": window_size,
    }


def suppress_nearby_duplicates(fires: list[dict[str, Any]], radius_pixels: int) -> list[dict[str, Any]]:
    if not fires:
        return []
    ordered = sorted(fires, key=lambda item: item["score"], reverse=True)
    selected: list[dict[str, Any]] = []
    for fire in ordered:
        if any(abs(fire["row"] - item["row"]) <= radius_pixels and abs(fire["col"] - item["col"]) <= radius_pixels for item in selected):
            continue
        selected.append(fire)
    return sorted(selected, key=lambda item: (item["acqTimeUtc"], -item["score"], item["lat"], item["lon"]))


def compute_dynamic_threshold_factor(altitude_deg: float, pv: float, pc: float) -> float:
    sin_altitude = max(math.sin(math.radians(max(altitude_deg, 0.0))), 0.0)
    if altitude_deg < 60.0:
        return (sin_altitude + 1.0) * (1.0 + pv) * (1.0 + pc)
    return (1.2 * sin_altitude + 1.0) * (1.0 + pv) * ((1.0 + pc) ** 2)


def compute_fire_evidence_score(
    *,
    t7: float,
    t713: float,
    background: dict[str, float],
    dynamic_factor: float,
    night_hot: bool,
    thresholds: dict[str, float],
) -> dict[str, float]:
    std_t7 = max(float(background["stdT7"]), 0.1)
    std_t713 = max(float(background["stdT713"]), 0.1)
    t7_excess = (t7 - (float(background["t7Bg"]) + dynamic_factor * std_t7)) / std_t7
    t713_excess = (t713 - (float(background["t713Bg"]) + dynamic_factor * std_t713)) / std_t713
    weaker_excess = max(min(t7_excess, t713_excess), 0.0)
    mean_excess = max((t7_excess + t713_excess) / 2.0, 0.0)
    relative_score = weaker_excess + 0.25 * mean_excess

    absolute_score = 0.0
    if night_hot:
        scale_k = max(float(thresholds.get("absoluteScoreScaleK", 10.0)), 0.1)
        absolute_score = 2.0 + max((t7 - float(thresholds["nightAbsoluteT7K"])) / scale_k, 0.0)

    return {
        "score": round(min(max(relative_score, absolute_score), 10.0), 3),
        "t7ThresholdExcessSigma": round(t7_excess, 3),
        "t713ThresholdExcessSigma": round(t713_excess, 3),
    }


def classify_confidence_from_score(score: float, thresholds: dict[str, float]) -> str:
    high_threshold = float(thresholds.get("confidenceHighScore", 3.5))
    medium_threshold = float(thresholds.get("confidenceMediumScore", 2.0))

    # Guard against misconfigured thresholds: medium should not exceed high.
    if medium_threshold > high_threshold:
        medium_threshold = high_threshold

    if score >= high_threshold:
        return "high"
    if score >= medium_threshold:
        return "medium"
    return "low"


def summarize_confidence_counts(fires: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"high": 0, "medium": 0, "low": 0}
    for fire in fires:
        confidence = str(fire.get("confidence", "low"))
        if confidence in counts:
            counts[confidence] += 1
    return counts


def load_support_raster(file_path: Path, expected_shape: tuple[int, int], value_name: str) -> np.ndarray:
    if file_path.suffix.lower() == ".npy":
        raster = np.load(file_path)
    elif file_path.suffix.lower() == ".npz":
        payload = np.load(file_path)
        if "data" not in payload:
            raise RuntimeError(f"{value_name} npz must contain a 'data' array: {file_path}")
        raster = payload["data"]
    else:
        raise RuntimeError(f"unsupported {value_name} raster format: {file_path.suffix}")

    if raster.shape != expected_shape:
        raise RuntimeError(f"{value_name} shape mismatch: expected={expected_shape}, actual={raster.shape}")
    return raster.astype(np.float32)


def load_support_mask(
    file_path: Path,
    lon_grid: np.ndarray,
    lat_grid: np.ndarray,
    roi_mask: np.ndarray,
    value_name: str,
) -> np.ndarray:
    suffix = file_path.suffix.lower()
    if suffix in {".npy", ".npz"}:
        return load_support_raster(file_path, lon_grid.shape, value_name).astype(bool)

    if suffix not in {".geojson", ".json"}:
        raise RuntimeError(f"unsupported {value_name} format: {file_path.suffix}")

    geojson = load_json(file_path)
    polygons = load_polygons_from_geojson(geojson)
    if not polygons:
        raise RuntimeError(f"{value_name} is empty: {file_path}")
    return rasterize_polygon_mask(polygons, lon_grid, lat_grid, roi_mask)


def load_static_thermal_source_database(file_path: Path) -> dict[str, Any]:
    suffix = file_path.suffix.lower()
    if suffix in {".geojson", ".json"}:
        geojson = load_json(file_path)
        database = parse_static_thermal_source_geojson(geojson)
    elif suffix == ".csv":
        database = parse_static_thermal_source_csv(file_path)
    else:
        raise RuntimeError(f"unsupported static thermal source format: {file_path.suffix}")

    if not database["points"] and not database["polygons"]:
        raise RuntimeError(f"static thermal source database is empty: {file_path}")
    return database


def load_static_thermal_source_databases(file_paths: list[Path]) -> dict[str, Any]:
    combined: dict[str, list[Any]] = {"points": [], "polygons": []}
    for file_path in file_paths:
        database = load_static_thermal_source_database(file_path)
        combined["points"].extend(database["points"])
        combined["polygons"].extend(database["polygons"])
    if not combined["points"] and not combined["polygons"]:
        raise RuntimeError("static thermal source databases are empty")
    return combined


def rasterize_polygon_mask(
    polygons: list[list[list[tuple[float, float]]]],
    lon_grid: np.ndarray,
    lat_grid: np.ndarray,
    roi_mask: np.ndarray,
) -> np.ndarray:
    mask = np.zeros(lon_grid.shape, dtype=bool)
    for polygon in polygons:
        outer = polygon[0]
        lon_values = [item[0] for item in outer]
        lat_values = [item[1] for item in outer]
        candidate = (
            roi_mask
            & (lon_grid >= min(lon_values))
            & (lon_grid <= max(lon_values))
            & (lat_grid >= min(lat_values))
            & (lat_grid <= max(lat_values))
        )
        candidate_indices = np.argwhere(candidate)
        for row, col in candidate_indices:
            if point_in_polygon(float(lon_grid[row, col]), float(lat_grid[row, col]), polygon):
                mask[row, col] = True
    return mask


def load_polygons_from_geojson(geojson: dict[str, Any]) -> list[list[list[tuple[float, float]]]]:
    polygons: list[list[list[tuple[float, float]]]] = []
    for feature in geojson.get("features", []):
        geometry = feature.get("geometry") or {}
        geometry_type = geometry.get("type")
        coordinates = geometry.get("coordinates", [])
        if geometry_type == "Polygon":
            polygon = normalize_polygon_rings(coordinates)
            if polygon:
                polygons.append(polygon)
        elif geometry_type == "MultiPolygon":
            for item in coordinates:
                polygon = normalize_polygon_rings(item)
                if polygon:
                    polygons.append(polygon)
    return polygons


def parse_static_thermal_source_geojson(geojson: dict[str, Any]) -> dict[str, Any]:
    points: list[dict[str, float]] = []
    polygons: list[list[list[tuple[float, float]]]] = []
    for feature in geojson.get("features", []):
        geometry = feature.get("geometry") or {}
        properties = feature.get("properties") or {}
        geometry_type = geometry.get("type")
        coordinates = geometry.get("coordinates", [])
        if geometry_type == "Point" and isinstance(coordinates, list) and len(coordinates) >= 2:
            points.append(
                {
                    "lon": float(coordinates[0]),
                    "lat": float(coordinates[1]),
                    "radiusKm": float(properties.get("radiusKm", properties.get("radius_km", 0.0)) or 0.0),
                }
            )
        elif geometry_type == "MultiPoint":
            for item in coordinates:
                if not isinstance(item, list) or len(item) < 2:
                    continue
                points.append(
                    {
                        "lon": float(item[0]),
                        "lat": float(item[1]),
                        "radiusKm": float(properties.get("radiusKm", properties.get("radius_km", 0.0)) or 0.0),
                    }
                )
        elif geometry_type == "Polygon":
            polygon = normalize_polygon_rings(coordinates)
            if polygon:
                polygons.append(polygon)
        elif geometry_type == "MultiPolygon":
            for item in coordinates:
                polygon = normalize_polygon_rings(item)
                if polygon:
                    polygons.append(polygon)
    return {"points": points, "polygons": polygons}


def parse_static_thermal_source_csv(file_path: Path) -> dict[str, Any]:
    points: list[dict[str, float]] = []
    with file_path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        for row in reader:
            try:
                lon = float(row.get("longitude") or row.get("lon") or row.get("LON"))
                lat = float(row.get("latitude") or row.get("lat") or row.get("LAT"))
            except (TypeError, ValueError):
                continue
            radius_km = float(row.get("radiusKm") or row.get("radius_km") or 0.0)
            points.append({"lon": lon, "lat": lat, "radiusKm": radius_km})
    return {"points": points, "polygons": []}


def matches_static_thermal_source(
    lon: float,
    lat: float,
    thermal_source_db: dict[str, Any],
    default_radius_km: float,
) -> bool:
    for polygon in thermal_source_db["polygons"]:
        if point_in_polygon(lon, lat, polygon):
            return True
    for point in thermal_source_db["points"]:
        radius_km = float(point.get("radiusKm", 0.0) or 0.0)
        effective_radius_km = radius_km if radius_km > 0 else default_radius_km
        if haversine_km(lon, lat, point["lon"], point["lat"]) <= effective_radius_km:
            return True
    return False


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius_km = 6371.0
    dlon = math.radians(lon2 - lon1)
    dlat = math.radians(lat2 - lat1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return 2 * radius_km * math.asin(math.sqrt(max(a, 0.0)))


def load_china_polygons(file_path: Path) -> list[list[list[tuple[float, float]]]]:
    geojson = load_json(file_path)
    polygons: list[list[list[tuple[float, float]]]] = []
    for feature in geojson.get("features", []):
        geometry = feature.get("geometry") or {}
        geometry_type = geometry.get("type")
        coordinates = geometry.get("coordinates", [])
        if geometry_type == "Polygon":
            polygon = normalize_polygon_rings(coordinates)
            if polygon:
                polygons.append(polygon)
        elif geometry_type == "MultiPolygon":
            for item in coordinates:
                polygon = normalize_polygon_rings(item)
                if polygon:
                    polygons.append(polygon)
    return polygons


def normalize_polygon_rings(coordinates: Any) -> list[list[tuple[float, float]]]:
    polygon: list[list[tuple[float, float]]] = []
    if not isinstance(coordinates, list):
        return polygon
    for ring in coordinates:
        if not isinstance(ring, list):
            continue
        normalized_ring = []
        for vertex in ring:
            if not isinstance(vertex, list) or len(vertex) < 2:
                continue
            lon = float(vertex[0])
            lat = float(vertex[1])
            normalized_ring.append((lon, lat))
        if len(normalized_ring) >= 3:
            polygon.append(normalized_ring)
    return polygon


def point_in_any_polygon(lon: float, lat: float, polygons: list[list[list[tuple[float, float]]]]) -> bool:
    return any(point_in_polygon(lon, lat, polygon) for polygon in polygons)


def point_in_polygon(lon: float, lat: float, polygon: list[list[tuple[float, float]]]) -> bool:
    if not polygon:
        return False
    if not point_in_ring(lon, lat, polygon[0]):
        return False
    for hole in polygon[1:]:
        if point_in_ring(lon, lat, hole):
            return False
    return True


def point_in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    total = len(ring)
    for index in range(total):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % total]
        intersects = ((y1 > lat) != (y2 > lat)) and (
            lon < (x2 - x1) * (lat - y1) / ((y2 - y1) if y2 != y1 else 1e-12) + x1
        )
        if intersects:
            inside = not inside
    return inside


def to_feature(fire: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [fire["lon"], fire["lat"]],
        },
        "properties": {
            "sourceSat": fire["sourceSat"],
            "acqTimeUtc": fire["acqTimeUtc"],
            "daynight": fire["daynight"],
            "fireStatus": fire["fireStatus"],
            "confidence": fire["confidence"],
            "score": fire["score"],
            "btTir": fire["btTir"],
            "btDif": fire["btDif"],
            "sceneId": fire["sceneId"],
            **fire["diagnostics"],
        },
    }


def upsert_candidate_fire_rows(db_path: Path, fires: list[dict[str, Any]], acquisition_time: str, source_sat: str) -> None:
    connection = sqlite3.connect(db_path)
    try:
        scene_id = find_scene_id(connection, acquisition_time)
        connection.execute("BEGIN")
        connection.execute("DELETE FROM candidate_fire WHERE source_sat = ? AND acq_time_utc = ?", (source_sat, acquisition_time))
        for fire in fires:
            connection.execute(
                """
                INSERT INTO candidate_fire (
                  source_sat,
                  acq_time_utc,
                  daynight,
                  fire_status,
                  score,
                  bt_tir,
                  bt_dif,
                  lon,
                  lat,
                  geom_wkt,
                  minx,
                  maxx,
                  miny,
                  maxy,
                  scene_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    fire["sourceSat"],
                    fire["acqTimeUtc"],
                    fire["daynight"],
                    fire["fireStatus"],
                    fire["score"],
                    fire["btTir"],
                    fire["btDif"],
                    fire["lon"],
                    fire["lat"],
                    fire["geomWkt"],
                    fire["minx"],
                    fire["maxx"],
                    fire["miny"],
                    fire["maxy"],
                    scene_id,
                ),
            )
        connection.commit()
    finally:
        connection.close()


def find_scene_id(connection: sqlite3.Connection, acquisition_time: str) -> int | None:
    row = connection.execute(
        """
        SELECT scene_id
        FROM raw_scene
        WHERE acq_time = ?
        ORDER BY scene_id DESC
        LIMIT 1
        """,
        (acquisition_time,),
    ).fetchone()
    return row[0] if row else None


def resolve_path(root: Path, target_path: str | Path) -> Path:
    target = Path(target_path)
    return target if target.is_absolute() else (root / target).resolve()


def load_json(file_path: Path) -> dict[str, Any]:
    return json.loads(file_path.read_text(encoding="utf-8"))


def validate_paper_strict_inputs(config: dict[str, Any]) -> None:
    if config.get("paperStrictMode", True) is not True:
        return

    missing = []
    bands = [str(item).zfill(2) for item in config.get("bands", [])]
    visible_band = str(config.get("visibleBand", "")).strip()
    visible_reflectance_path = str(config.get("visibleReflectancePath", "")).strip()
    thermal_source_values = config.get("groundThermalSourcePaths")
    if not isinstance(thermal_source_values, list) or not thermal_source_values:
        thermal_source_values = [config.get("groundThermalSourcePath", "")]
    thermal_source_paths = [str(value).strip() for value in thermal_source_values if str(value).strip()]
    non_vegetation_mask_path = str(config.get("nonVegetationMaskPath", "")).strip()

    for required_band in ("07", "13", "14"):
        if required_band not in bands:
            missing.append(f"band {required_band} is required by the paper, but is missing from config.bands")

    if not visible_band and not visible_reflectance_path:
        missing.append(
            "visible reflectance input is required by the paper for Table 2, Eq. (3), Eq. (5) and Eq. (10)"
        )
    elif visible_band and visible_band not in bands and not visible_reflectance_path:
        missing.append(
            f"visibleBand={visible_band} is not present in config.bands, and no visibleReflectancePath override was provided"
        )

    if visible_reflectance_path:
        resolved_visible = resolve_path(PROJECT_ROOT, visible_reflectance_path)
        if not resolved_visible.exists():
            missing.append(f"visibleReflectancePath not found: {resolved_visible}")

    if thermal_source_paths:
        for thermal_source_path in thermal_source_paths:
            resolved_thermal = resolve_path(PROJECT_ROOT, thermal_source_path)
            if not resolved_thermal.exists():
                missing.append(f"ground thermal source path not found: {resolved_thermal}")
    else:
        missing.append(
            "ground thermal source database is required by Section 3.3.3 of the paper"
        )

    if non_vegetation_mask_path:
        resolved_non_veg = resolve_path(PROJECT_ROOT, non_vegetation_mask_path)
        if not resolved_non_veg.exists():
            missing.append(f"nonVegetationMaskPath not found: {resolved_non_veg}")
    else:
        missing.append(
            "non-vegetation mask is required for Pv in Eq. (9)"
        )

    if missing:
        raise RuntimeError(
            "paperStrictMode is enabled, but the current realtime pipeline does not satisfy the paper's required inputs:\n- "
            + "\n- ".join(missing)
        )


def load_json_if_exists(file_path: Path) -> dict[str, Any] | None:
    if not file_path.exists():
        return None
    return load_json(file_path)


def write_json(file_path: Path, payload: dict[str, Any]) -> None:
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def mirror_public_output_to_dist(file_path: Path) -> None:
    try:
        relative = file_path.resolve().relative_to((PROJECT_ROOT / "public").resolve())
    except ValueError:
        return
    dist_path = (PROJECT_ROOT / "dist" / relative).resolve()
    dist_path.parent.mkdir(parents=True, exist_ok=True)
    dist_path.write_text(file_path.read_text(encoding="utf-8"), encoding="utf-8")


if __name__ == "__main__":
    main()
