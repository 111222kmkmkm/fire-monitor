#!/usr/bin/env python

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config" / "evaluate-himawari-fire.json"


@dataclass
class Detection:
    detection_id: str
    sensor: str
    lon: float
    lat: float
    acquisition_time: datetime
    confidence: str
    frp: float | None
    properties: dict[str, Any]


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Himawari candidates against contemporaneous FIRMS observations.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG_PATH))
    args = parser.parse_args()
    config = load_json(resolve_path(args.config))

    candidates = load_himawari_candidates(resolve_path(config["candidateFirePath"]))
    if not candidates:
        raise SystemExit("Himawari candidate file contains no features.")
    china_polygons = load_polygons(resolve_path(config["chinaBoundaryPath"]))
    max_window_hours = max(float(value) for value in config.get("timeWindowsHours", [3]))
    references = load_reference_datasets(config, candidates, max_window_hours, china_polygons)

    spatial_match_km = float(config.get("spatialMatchKm", 5.0))
    cluster_km = float(config.get("referenceClusterKm", 2.5))
    cluster_minutes = float(config.get("referenceClusterMinutes", 30.0))
    results: list[dict[str, Any]] = []
    evaluations: dict[float, tuple[list[Detection], list[dict[str, Any]]]] = {}

    for window_value in config.get("timeWindowsHours", [1, 3, 6]):
        window_hours = float(window_value)
        window_references = [
            item for item in references
            if nearest_time_delta_hours(item.acquisition_time, candidates) <= window_hours
        ]
        clusters = cluster_reference_detections(window_references, cluster_km, cluster_minutes)
        matches = match_detections(candidates, clusters, spatial_match_km, window_hours)
        evaluations[window_hours] = (clusters, matches)
        results.append(build_metrics(window_hours, candidates, clusters, matches, spatial_match_km))

    primary_window = float(config.get("primaryTimeWindowHours", 3))
    primary_clusters, primary_matches = evaluations.get(primary_window, ([], []))
    generated_at = utc_now_iso()
    summary = {
        "generatedAt": generated_at,
        "status": "evaluated",
        "evaluationType": "apparent-object-level-validation",
        "candidateSource": str(resolve_path(config["candidateFirePath"])),
        "candidateCount": len(candidates),
        "candidateAcquisitionTimes": sorted({item.acquisition_time.isoformat().replace("+00:00", "Z") for item in candidates}),
        "referenceObservationCount": len(references),
        "referenceSensors": sorted({item.sensor for item in references}),
        "spatialMatchKm": spatial_match_km,
        "referenceClusterKm": cluster_km,
        "referenceClusterMinutes": cluster_minutes,
        "primaryTimeWindowHours": primary_window,
        "metricsByTimeWindow": results,
        "limitations": [
            "FIRMS active-fire CSV contains detections but not complete satellite swath or cloud-obscuration masks; unmatched Himawari candidates are apparent false positives, not confirmed false alarms.",
            "Himawari and polar-orbiting sensors observe at different times and spatial resolutions; longer time windows increase temporal mismatch.",
            "The evaluation uses VIIRS/MODIS detections as reference observations rather than field-confirmed ground truth.",
        ],
    }
    write_json(resolve_path(config["outputSummaryPath"]), summary)
    write_json(
        resolve_path(config["outputMatchesPath"]),
        build_match_geojson(candidates, primary_clusters, primary_matches, primary_window),
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def load_himawari_candidates(file_path: Path) -> list[Detection]:
    payload = load_json(file_path)
    detections: list[Detection] = []
    for index, feature in enumerate(payload.get("features", [])):
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        properties = feature.get("properties") or {}
        if geometry.get("type") != "Point" or len(coordinates) < 2 or not properties.get("acqTimeUtc"):
            continue
        detections.append(
            Detection(
                detection_id=f"HIMAWARI-{index + 1}",
                sensor=str(properties.get("sourceSat", "H09")),
                lon=float(coordinates[0]),
                lat=float(coordinates[1]),
                acquisition_time=parse_iso_time(str(properties["acqTimeUtc"])),
                confidence=str(properties.get("confidence", "")),
                frp=to_optional_float(properties.get("frp")),
                properties=dict(properties),
            )
        )
    return detections


def load_reference_datasets(
    config: dict[str, Any],
    candidates: list[Detection],
    max_window_hours: float,
    china_polygons: list[list[list[tuple[float, float]]]],
) -> list[Detection]:
    accepted_viirs = {str(value).strip().lower() for value in config.get("acceptedViirsConfidence", ["nominal", "high", "n", "h"])}
    min_modis_confidence = float(config.get("minModisConfidence", 30))
    references: list[Detection] = []
    for dataset in config.get("referenceDatasets", []):
        file_path = resolve_path(dataset["path"])
        if not file_path.exists():
            continue
        sensor_name = str(dataset.get("sensor", file_path.stem))
        with file_path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            for row_index, row in enumerate(reader):
                try:
                    lon = float(row.get("longitude", ""))
                    lat = float(row.get("latitude", ""))
                    acquisition_time = parse_firms_time(row.get("acq_date", ""), row.get("acq_time", ""))
                except (TypeError, ValueError):
                    continue
                if nearest_time_delta_hours(acquisition_time, candidates) > max_window_hours:
                    continue
                if not (73.0 <= lon <= 135.5 and 18.0 <= lat <= 54.0):
                    continue
                if not point_in_any_polygon(lon, lat, china_polygons):
                    continue
                confidence = str(row.get("confidence", "")).strip().lower()
                if "VIIRS" in sensor_name.upper() and confidence not in accepted_viirs:
                    continue
                if "MODIS" in sensor_name.upper():
                    numeric_confidence = to_optional_float(confidence)
                    if numeric_confidence is None or numeric_confidence < min_modis_confidence:
                        continue
                fire_type = str(row.get("type", "0")).strip()
                if fire_type and fire_type not in {"0", "0.0"}:
                    continue
                references.append(
                    Detection(
                        detection_id=f"{sensor_name}-{row_index + 1}",
                        sensor=sensor_name,
                        lon=lon,
                        lat=lat,
                        acquisition_time=acquisition_time,
                        confidence=confidence,
                        frp=to_optional_float(row.get("frp")),
                        properties={"daynight": row.get("daynight"), "sourceRow": row_index + 1},
                    )
                )
    return references


def cluster_reference_detections(
    detections: list[Detection],
    cluster_km: float,
    cluster_minutes: float,
) -> list[Detection]:
    if not detections:
        return []
    parent = list(range(len(detections)))

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

    for left in range(len(detections)):
        for right in range(left + 1, len(detections)):
            time_delta_minutes = abs((detections[left].acquisition_time - detections[right].acquisition_time).total_seconds()) / 60.0
            if time_delta_minutes > cluster_minutes:
                continue
            if haversine_km(detections[left].lon, detections[left].lat, detections[right].lon, detections[right].lat) <= cluster_km:
                union(left, right)

    groups: dict[int, list[Detection]] = {}
    for index, item in enumerate(detections):
        groups.setdefault(find(index), []).append(item)

    clusters: list[Detection] = []
    for cluster_index, members in enumerate(groups.values(), start=1):
        weights = [max((item.frp or 0.0), 0.0) + 1.0 for item in members]
        total_weight = sum(weights)
        timestamp = sum(item.acquisition_time.timestamp() * weight for item, weight in zip(members, weights, strict=True)) / total_weight
        clusters.append(
            Detection(
                detection_id=f"REFERENCE-CLUSTER-{cluster_index}",
                sensor="+".join(sorted({item.sensor for item in members})),
                lon=sum(item.lon * weight for item, weight in zip(members, weights, strict=True)) / total_weight,
                lat=sum(item.lat * weight for item, weight in zip(members, weights, strict=True)) / total_weight,
                acquisition_time=datetime.fromtimestamp(timestamp, tz=timezone.utc),
                confidence="reference",
                frp=sum(item.frp or 0.0 for item in members),
                properties={
                    "memberCount": len(members),
                    "memberIds": [item.detection_id for item in members],
                    "sensors": sorted({item.sensor for item in members}),
                },
            )
        )
    return clusters


def match_detections(
    candidates: list[Detection],
    references: list[Detection],
    spatial_match_km: float,
    time_window_hours: float,
) -> list[dict[str, Any]]:
    possible: list[tuple[float, float, int, int]] = []
    for candidate_index, candidate in enumerate(candidates):
        for reference_index, reference in enumerate(references):
            time_delta_hours = abs((candidate.acquisition_time - reference.acquisition_time).total_seconds()) / 3600.0
            if time_delta_hours > time_window_hours:
                continue
            distance_km = haversine_km(candidate.lon, candidate.lat, reference.lon, reference.lat)
            if distance_km <= spatial_match_km:
                possible.append((distance_km, time_delta_hours, candidate_index, reference_index))
    possible.sort()
    used_candidates: set[int] = set()
    used_references: set[int] = set()
    matches: list[dict[str, Any]] = []
    for distance_km, time_delta_hours, candidate_index, reference_index in possible:
        if candidate_index in used_candidates or reference_index in used_references:
            continue
        used_candidates.add(candidate_index)
        used_references.add(reference_index)
        matches.append(
            {
                "candidateIndex": candidate_index,
                "referenceIndex": reference_index,
                "distanceKm": round(distance_km, 3),
                "timeDeltaHours": round(time_delta_hours, 3),
            }
        )
    return matches


def build_metrics(
    window_hours: float,
    candidates: list[Detection],
    references: list[Detection],
    matches: list[dict[str, Any]],
    spatial_match_km: float,
) -> dict[str, Any]:
    true_positive = len(matches)
    false_positive = len(candidates) - true_positive
    false_negative = len(references) - true_positive
    if not references:
        return {
            "timeWindowHours": window_hours,
            "status": "no_reference_detections",
            "candidateCount": len(candidates),
            "referenceClusterCount": 0,
            "truePositive": None,
            "falsePositive": None,
            "falseNegative": None,
            "precision": None,
            "recall": None,
            "commissionRate": None,
            "omissionRate": None,
            "spatialMatchKm": spatial_match_km,
            "note": "No accepted reference fire detections fall inside this time window; FIRMS CSV alone cannot prove whether the candidate locations were inside a clear-sky reference-sensor swath.",
        }
    precision = true_positive / max(true_positive + false_positive, 1)
    recall = true_positive / max(true_positive + false_negative, 1)
    nearest_distances = [
        min(haversine_km(candidate.lon, candidate.lat, reference.lon, reference.lat) for reference in references)
        for candidate in candidates
    ]
    return {
        "timeWindowHours": window_hours,
        "status": "provisional",
        "candidateCount": len(candidates),
        "referenceClusterCount": len(references),
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "commissionRate": round(1.0 - precision, 4),
        "omissionRate": round(1.0 - recall, 4),
        "spatialMatchKm": spatial_match_km,
        "candidateToReferenceDistanceKm": {
            "min": round(min(nearest_distances), 3),
            "median": round(statistics.median(nearest_distances), 3),
            "max": round(max(nearest_distances), 3),
        },
        "candidateBBox": detection_bbox(candidates),
        "referenceBBox": detection_bbox(references),
    }


def detection_bbox(detections: list[Detection]) -> list[float] | None:
    if not detections:
        return None
    return [
        round(min(item.lon for item in detections), 6),
        round(min(item.lat for item in detections), 6),
        round(max(item.lon for item in detections), 6),
        round(max(item.lat for item in detections), 6),
    ]


def build_match_geojson(
    candidates: list[Detection],
    references: list[Detection],
    matches: list[dict[str, Any]],
    window_hours: float,
) -> dict[str, Any]:
    matched_candidates = {item["candidateIndex"]: item for item in matches}
    matched_references = {item["referenceIndex"]: item for item in matches}
    features: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates):
        match = matched_candidates.get(index)
        features.append(to_geojson_feature(candidate, "true-positive" if match else "apparent-false-positive", match, window_hours))
    for index, reference in enumerate(references):
        match = matched_references.get(index)
        features.append(to_geojson_feature(reference, "matched-reference" if match else "apparent-false-negative", match, window_hours))
    return {"type": "FeatureCollection", "features": features}


def to_geojson_feature(
    detection: Detection,
    evaluation_class: str,
    match: dict[str, Any] | None,
    window_hours: float,
) -> dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(detection.lon, 6), round(detection.lat, 6)]},
        "properties": {
            "detectionId": detection.detection_id,
            "sensor": detection.sensor,
            "acquisitionTime": detection.acquisition_time.isoformat().replace("+00:00", "Z"),
            "evaluationClass": evaluation_class,
            "timeWindowHours": window_hours,
            "confidence": detection.confidence,
            "frp": detection.frp,
            "matchDistanceKm": match.get("distanceKm") if match else None,
            "matchTimeDeltaHours": match.get("timeDeltaHours") if match else None,
            **detection.properties,
        },
    }


def nearest_time_delta_hours(timestamp: datetime, candidates: list[Detection]) -> float:
    return min(abs((timestamp - item.acquisition_time).total_seconds()) / 3600.0 for item in candidates)


def parse_firms_time(date_value: str, time_value: str) -> datetime:
    return datetime.strptime(f"{date_value} {str(time_value).zfill(4)}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)


def parse_iso_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius_km = 6371.0
    dlon = math.radians(lon2 - lon1)
    dlat = math.radians(lat2 - lat1)
    a = math.sin(dlat / 2.0) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2.0) ** 2
    return 2.0 * radius_km * math.asin(math.sqrt(max(a, 0.0)))


def load_polygons(file_path: Path) -> list[list[list[tuple[float, float]]]]:
    payload = load_json(file_path)
    polygons: list[list[list[tuple[float, float]]]] = []
    for feature in payload.get("features", []):
        geometry = feature.get("geometry") or {}
        coordinates = geometry.get("coordinates") or []
        if geometry.get("type") == "Polygon":
            polygons.append(normalize_polygon(coordinates))
        elif geometry.get("type") == "MultiPolygon":
            polygons.extend(normalize_polygon(item) for item in coordinates)
    return [polygon for polygon in polygons if polygon]


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
