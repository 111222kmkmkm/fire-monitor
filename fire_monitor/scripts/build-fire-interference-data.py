#!/usr/bin/env python

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "build-fire-interference-data.json"
GPPD_SOURCE_URL = "https://github.com/wri/global-power-plant-database"
GPPD_VERSION = "1.3.0"


def main() -> None:
    parser = argparse.ArgumentParser(description="Build photovoltaic and persistent thermal-interference candidate datasets.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    args = parser.parse_args()
    config = load_json(resolve_path(args.config))
    china_polygons = load_polygons(resolve_path(config["chinaBoundaryPath"]))

    photovoltaic_features = build_photovoltaic_features(resolve_path(config["globalPowerPlantCsvPath"]), china_polygons)
    persistent_features, viirs_stats = build_persistent_thermal_features(
        resolve_path(config["viirsCsvPath"]),
        china_polygons,
        cluster_km=float(config.get("persistentClusterKm", 1.5)),
        min_distinct_days=int(config.get("persistentMinDistinctDays", 4)),
        min_detection_count=int(config.get("persistentMinDetectionCount", 4)),
        accepted_confidence={str(value).lower() for value in config.get("acceptedViirsConfidence", ["nominal", "high", "n", "h"])},
    )
    existing_payload = load_json(resolve_path(config["existingThermalSourcePath"]))
    existing_count = len(existing_payload.get("features", []))

    photovoltaic_path = resolve_path(config["photovoltaicOutputPath"])
    persistent_path = resolve_path(config["persistentThermalOutputPath"])
    summary_path = resolve_path(config["summaryOutputPath"])
    write_json(photovoltaic_path, feature_collection(photovoltaic_features))
    write_json(persistent_path, feature_collection(persistent_features))
    summary = {
        "generatedAt": utc_now_iso(),
        "sources": {
            "globalPowerPlantDatabase": {
                "version": GPPD_VERSION,
                "url": GPPD_SOURCE_URL,
                "license": "CC BY 4.0",
                "chinaPhotovoltaicFacilityCount": len(photovoltaic_features),
                "totalCapacityMw": round(sum(float(feature["properties"]["capacityMw"]) for feature in photovoltaic_features), 2),
            },
            "viirsNoaa20SevenDay": viirs_stats,
        },
        "existingStaticThermalSourceCount": existing_count,
        "automaticInterferenceSourceCount": existing_count + len(photovoltaic_features),
        "persistentThermalCandidateCount": len(persistent_features),
        "notes": [
            "Photovoltaic facilities are registry-derived interference sources and use a conservative capacity-based radius.",
            "VIIRS persistent thermal clusters are candidates only and are not automatically rejected until imagery or infrastructure verification is completed.",
        ],
    }
    write_json(summary_path, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def build_photovoltaic_features(
    csv_path: Path,
    china_polygons: list[list[list[tuple[float, float]]]],
) -> list[dict[str, Any]]:
    features: list[dict[str, Any]] = []
    with csv_path.open("r", encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            if str(row.get("country", "")).upper() != "CHN" or str(row.get("primary_fuel", "")).lower() != "solar":
                continue
            try:
                lat = float(row.get("latitude", ""))
                lon = float(row.get("longitude", ""))
                capacity_mw = float(row.get("capacity_mw", "") or 0.0)
            except (TypeError, ValueError):
                continue
            if not point_in_any_polygon(lon, lat, china_polygons):
                continue
            radius_km = photovoltaic_radius_km(capacity_mw)
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                    "properties": {
                        "name": str(row.get("name", "")).strip(),
                        "interferenceType": "photovoltaic",
                        "verificationStatus": "registry-derived",
                        "autoReject": True,
                        "radiusKm": radius_km,
                        "radiusMethod": "sqrt(capacity_mw / (35_mw_per_km2 * pi)), clamped to 0.25-2.5 km",
                        "capacityMw": round(capacity_mw, 3),
                        "owner": str(row.get("owner", "")).strip() or None,
                        "recordId": str(row.get("gppd_idnr", "")).strip(),
                        "recordSource": str(row.get("source", "")).strip(),
                        "recordUrl": str(row.get("url", "")).strip() or None,
                        "sourceDataset": "WRI Global Power Plant Database",
                        "sourceDatasetVersion": GPPD_VERSION,
                        "sourceDatasetUrl": GPPD_SOURCE_URL,
                        "sourceDatasetLicense": "CC BY 4.0",
                    },
                }
            )
    features.sort(key=lambda feature: (feature["properties"]["name"], feature["properties"]["recordId"]))
    return features


def photovoltaic_radius_km(capacity_mw: float) -> float:
    estimated = math.sqrt(max(capacity_mw, 0.0) / (35.0 * math.pi)) if capacity_mw > 0 else 0.25
    return round(min(max(estimated, 0.25), 2.5), 3)


def build_persistent_thermal_features(
    csv_path: Path,
    china_polygons: list[list[list[tuple[float, float]]]],
    *,
    cluster_km: float,
    min_distinct_days: int,
    min_detection_count: int,
    accepted_confidence: set[str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    detections: list[dict[str, Any]] = []
    min_date: str | None = None
    max_date: str | None = None
    with csv_path.open("r", encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            confidence = str(row.get("confidence", "")).lower()
            if confidence not in accepted_confidence:
                continue
            try:
                lat = float(row.get("latitude", ""))
                lon = float(row.get("longitude", ""))
            except (TypeError, ValueError):
                continue
            if not (73.0 <= lon <= 135.5 and 18.0 <= lat <= 54.0):
                continue
            if not point_in_any_polygon(lon, lat, china_polygons):
                continue
            date_value = str(row.get("acq_date", ""))
            min_date = date_value if min_date is None or date_value < min_date else min_date
            max_date = date_value if max_date is None or date_value > max_date else max_date
            detections.append(
                {
                    "lon": lon,
                    "lat": lat,
                    "date": date_value,
                    "time": str(row.get("acq_time", "")).zfill(4),
                    "frp": to_optional_float(row.get("frp")) or 0.0,
                    "daynight": str(row.get("daynight", "")),
                }
            )

    clusters = cluster_spatial_points(detections, cluster_km)
    features: list[dict[str, Any]] = []
    for members in clusters:
        distinct_days = sorted({item["date"] for item in members})
        if len(members) < min_detection_count or len(distinct_days) < min_distinct_days:
            continue
        weights = [max(float(item["frp"]), 0.0) + 1.0 for item in members]
        total_weight = sum(weights)
        lon = sum(float(item["lon"]) * weight for item, weight in zip(members, weights, strict=True)) / total_weight
        lat = sum(float(item["lat"]) * weight for item, weight in zip(members, weights, strict=True)) / total_weight
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                "properties": {
                    "name": f"VIIRS persistent candidate {len(features) + 1}",
                    "interferenceType": "persistent-thermal-candidate",
                    "verificationStatus": "requires-imagery-or-infrastructure-review",
                    "autoReject": False,
                    "radiusKm": round(cluster_km, 3),
                    "detectionCount": len(members),
                    "distinctDayCount": len(distinct_days),
                    "firstDate": distinct_days[0],
                    "lastDate": distinct_days[-1],
                    "meanFrpMw": round(sum(float(item["frp"]) for item in members) / len(members), 3),
                    "maxFrpMw": round(max(float(item["frp"]) for item in members), 3),
                    "dayDetectionCount": sum(str(item["daynight"]).upper() == "D" for item in members),
                    "nightDetectionCount": sum(str(item["daynight"]).upper() == "N" for item in members),
                    "sourceDataset": "NASA FIRMS NOAA-20 VIIRS C2 NRT Global 7d",
                },
            }
        )
    features.sort(key=lambda feature: (-feature["properties"]["distinctDayCount"], -feature["properties"]["detectionCount"]))
    return features, {
        "path": str(csv_path),
        "dateRange": {"start": min_date, "end": max_date},
        "chinaDetectionCount": len(detections),
        "persistentCandidateCount": len(features),
        "persistentCriteria": {
            "clusterKm": cluster_km,
            "minDistinctDays": min_distinct_days,
            "minDetectionCount": min_detection_count,
        },
    }


def cluster_spatial_points(points: list[dict[str, Any]], cluster_km: float) -> list[list[dict[str, Any]]]:
    if not points:
        return []
    cell_degrees = max(cluster_km / 111.0, 0.001)
    buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
    parent = list(range(len(points)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        root_left = find(left)
        root_right = find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for index, point in enumerate(points):
        cell = (math.floor(float(point["lon"]) / cell_degrees), math.floor(float(point["lat"]) / cell_degrees))
        for delta_x in (-1, 0, 1):
            for delta_y in (-1, 0, 1):
                for other_index in buckets.get((cell[0] + delta_x, cell[1] + delta_y), []):
                    other = points[other_index]
                    if haversine_km(float(point["lon"]), float(point["lat"]), float(other["lon"]), float(other["lat"])) <= cluster_km:
                        union(index, other_index)
        buckets[cell].append(index)

    groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for index, point in enumerate(points):
        groups[find(index)].append(point)
    return list(groups.values())


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius_km = 6371.0
    dlon = math.radians(lon2 - lon1)
    dlat = math.radians(lat2 - lat1)
    value = math.sin(dlat / 2.0) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2.0) ** 2
    return 2.0 * radius_km * math.asin(math.sqrt(max(value, 0.0)))


def feature_collection(features: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": features}


def load_polygons(file_path: Path) -> list[list[list[tuple[float, float]]]]:
    payload = load_json(file_path)
    polygons: list[list[list[tuple[float, float]]]] = []
    for feature in payload.get("features", []):
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        if geometry.get("type") == "Polygon":
            polygon = normalize_polygon(coordinates)
            if polygon:
                polygons.append(polygon)
        elif geometry.get("type") == "MultiPolygon":
            for item in coordinates:
                polygon = normalize_polygon(item)
                if polygon:
                    polygons.append(polygon)
    return polygons


def normalize_polygon(coordinates: Any) -> list[list[tuple[float, float]]]:
    rings: list[list[tuple[float, float]]] = []
    for ring in coordinates if isinstance(coordinates, list) else []:
        normalized = [(float(point[0]), float(point[1])) for point in ring if isinstance(point, list) and len(point) >= 2]
        if len(normalized) >= 3:
            rings.append(normalized)
    return rings


def point_in_any_polygon(lon: float, lat: float, polygons: list[list[list[tuple[float, float]]]]) -> bool:
    return any(point_in_polygon(lon, lat, polygon) for polygon in polygons)


def point_in_polygon(lon: float, lat: float, polygon: list[list[tuple[float, float]]]) -> bool:
    if not polygon or not point_in_ring(lon, lat, polygon[0]):
        return False
    return not any(point_in_ring(lon, lat, ring) for ring in polygon[1:])


def point_in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    previous = ring[-1]
    for current in ring:
        x1, y1 = previous
        x2, y2 = current
        if (y1 > lat) != (y2 > lat):
            intersection = (x2 - x1) * (lat - y1) / ((y2 - y1) or 1e-12) + x1
            if lon < intersection:
                inside = not inside
        previous = current
    return inside


def to_optional_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def resolve_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else (PROJECT_ROOT / path).resolve()


def load_json(file_path: Path) -> dict[str, Any]:
    return json.loads(file_path.read_text(encoding="utf-8"))


def write_json(file_path: Path, payload: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    main()
