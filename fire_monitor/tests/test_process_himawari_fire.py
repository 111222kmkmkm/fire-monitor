from __future__ import annotations

import importlib.util
import bz2
import math
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = PROJECT_ROOT / "scripts" / "process-himawari-fire.py"
SPEC = importlib.util.spec_from_file_location("process_himawari_fire", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"无法加载算法模块：{MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def build_thresholds() -> dict[str, float]:
    return {
        "suspiciousOffsetK": 20.0,
        "suspiciousVisibleFactor": 100.0,
        "minValidRatio": 0.2,
        "nightAbsoluteT7K": 360.0,
        "nightVisibleMax": 0.7,
        "nightZenithDeg": 87.0,
        "cloudVisibleReflectance": 0.28,
        "cloudZenithLimitDeg": 70.0,
        "cloudVisibleDelta": 0.15,
        "cloudT13DeltaK": 5.0,
        "edgeThresholdC": 8.0,
        "thermalSourceRadiusKm": 4.0,
        "minBackgroundPixels": 4.0,
        "minStdT713K": 2.0,
        "maxStdT713K": 4.0,
        "absoluteScoreScaleK": 10.0,
        "confidenceMediumScore": 2.0,
        "confidenceHighScore": 3.5,
    }


class HimawariFireAlgorithmTests(unittest.TestCase):
    def test_fire_range_features_preserve_adjacent_pixels_as_one_cluster(self) -> None:
        lon_grid = np.tile(np.linspace(100.0, 100.2, 5, dtype=np.float32), (5, 1))
        lat_grid = np.tile(np.linspace(30.0, 30.2, 5, dtype=np.float32)[:, np.newaxis], (1, 5))

        def fire(row: int, col: int, score: float) -> dict[str, object]:
            return {
                "row": row,
                "col": col,
                "sourceSat": "H09",
                "acqTimeUtc": "2026-01-01T16:00:00Z",
                "daynight": "N",
                "fireStatus": "suspected",
                "confidence": "medium",
                "score": score,
                "btTir": 380.0,
                "btDif": 80.0,
                "lon": float(lon_grid[row, col]),
                "lat": float(lat_grid[row, col]),
                "sceneId": "202601011600",
                "diagnostics": {"officialConfirmed": False},
            }

        pixels, clusters = MODULE.build_fire_range_features(
            [fire(2, 2, 4.0), fire(2, 3, 3.0), fire(0, 0, 2.0)],
            lon_grid,
            lat_grid,
        )
        self.assertEqual(len(pixels), 3)
        self.assertEqual(len(clusters), 2)
        self.assertTrue(all(item["geometry"]["type"] == "Polygon" for item in pixels))
        self.assertEqual(sum(item["properties"]["pixelCount"] for item in clusters), 3)

    def test_official_reference_match_confirms_without_removing_unmatched_pixels(self) -> None:
        fires = [{
            "row": 1,
            "col": 1,
            "lon": 110.0,
            "lat": 30.0,
            "acqTimeUtc": "2026-01-01T16:00:00Z",
            "fireStatus": "suspected",
            "confidence": "medium",
            "diagnostics": {},
        }, {
            "row": 1,
            "col": 2,
            "lon": 120.0,
            "lat": 40.0,
            "acqTimeUtc": "2026-01-01T16:00:00Z",
            "fireStatus": "suspected",
            "confidence": "medium",
            "diagnostics": {},
        }]
        references = [{
            "id": "VIIRS-1",
            "sensor": "VIIRS_NOAA20",
            "lon": 110.01,
            "lat": 30.0,
            "acquisitionTime": MODULE.parse_utc_time("2026-01-01T16:10:00Z"),
            "confidence": "nominal",
            "frp": 12.0,
        }]

        MODULE.fuse_official_fire_references(
            fires,
            references,
            {"officialFusion": {"spatialMatchKm": 4.0, "timeWindowHours": 3.0}},
        )
        self.assertTrue(fires[0]["diagnostics"]["officialConfirmed"])
        self.assertEqual(fires[0]["fireStatus"], "confirmed")
        self.assertFalse(fires[1]["diagnostics"]["officialConfirmed"])
        self.assertEqual(fires[1]["fireStatus"], "suspected")

    def test_official_reference_features_preserve_matched_and_official_only_footprints(self) -> None:
        fires = [{
            "diagnostics": {
                "officialConfirmed": True,
                "officialDetectionId": "VIIRS-1",
            },
        }, {
            "diagnostics": {"officialConfirmed": False},
        }]
        references = [{
            "id": "VIIRS-1",
            "sensor": "VIIRS_NOAA20",
            "lon": 110.0,
            "lat": 30.0,
            "acquisitionTime": MODULE.parse_utc_time("2026-01-01T16:10:00Z"),
            "confidence": "nominal",
            "frp": 12.0,
            "scanKm": 0.4,
            "trackKm": 0.3,
        }, {
            "id": "VIIRS-2",
            "sensor": "VIIRS_NOAA20",
            "lon": 111.0,
            "lat": 31.0,
            "acquisitionTime": MODULE.parse_utc_time("2026-01-01T16:10:00Z"),
            "confidence": "high",
            "frp": 18.0,
            "scanKm": 0.5,
            "trackKm": 0.4,
        }]

        features = MODULE.build_official_reference_features(fires, references)

        self.assertEqual(len(features), 2)
        feature = features[0]
        self.assertEqual(feature["geometry"]["type"], "Polygon")
        self.assertEqual(feature["properties"]["rangeSource"], "official")
        self.assertEqual(feature["properties"]["officialDetectionId"], "VIIRS-1")
        self.assertEqual(feature["properties"]["pixelWidthKm"], 0.4)
        self.assertEqual(feature["properties"]["pixelHeightKm"], 0.3)
        self.assertTrue(feature["properties"]["matchedBySelfAlgorithm"])
        self.assertEqual(feature["properties"]["fusionStatus"], "official-confirmed")
        ring = feature["geometry"]["coordinates"][0]
        self.assertEqual(len(ring), 5)
        self.assertEqual(ring[0], ring[-1])
        self.assertFalse(features[1]["properties"]["matchedBySelfAlgorithm"])
        self.assertEqual(features[1]["properties"]["fusionStatus"], "official-only")

    def test_official_references_are_clipped_to_boundary_polygon(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path = Path(temp_dir) / "J1_VIIRS_C2_Russia_Asia_24h.csv"
            csv_path.write_text(
                "latitude,longitude,scan,track,acq_date,acq_time,confidence,frp\n"
                "30.0,110.0,0.4,0.4,2026-01-01,1600,nominal,12.0\n"
                "30.0,120.0,0.4,0.4,2026-01-01,1600,nominal,18.0\n",
                encoding="utf-8",
            )
            boundary = [[[
                (109.0, 29.0),
                (111.0, 29.0),
                (111.0, 31.0),
                (109.0, 31.0),
                (109.0, 29.0),
            ]]]
            references = MODULE.load_official_fire_references(
                {
                    "officialFusion": {
                        "referencePaths": [str(csv_path)],
                        "timeWindowHours": 3,
                    },
                },
                "2026-01-01T16:00:00Z",
                {"minLon": 73.0, "maxLon": 135.5, "minLat": 18.0, "maxLat": 54.0},
                boundary,
            )

        self.assertEqual(len(references), 1)
        self.assertEqual(references[0]["lon"], 110.0)

    def test_explicit_interference_radius_is_not_inflated_to_default(self) -> None:
        database = {
            "points": [{"lon": 110.0, "lat": 30.0, "radiusKm": 0.5}],
            "polygons": [],
        }
        self.assertTrue(MODULE.matches_static_thermal_source(110.003, 30.0, database, 4.0))
        self.assertFalse(MODULE.matches_static_thermal_source(110.012, 30.0, database, 4.0))

    def test_snapshot_requires_same_configured_segments_for_every_band(self) -> None:
        bands = ["03", "07", "13", "14"]
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            incomplete = root / "202601011010"
            complete = root / "202601011000"
            incomplete.mkdir()
            complete.mkdir()

            for band in bands:
                incomplete_segments = [1, 2, 3, 5] if band == "14" else [1, 2, 3, 4]
                for segment in incomplete_segments:
                    file_name = f"HS_H09_20260101_1010_B{band}_FLDK_R20_S{segment:02d}10.DAT.bz2"
                    (incomplete / file_name).write_bytes(bz2.compress(b"valid"))
                for segment in [1, 2, 3, 4]:
                    file_name = f"HS_H09_20260101_1000_B{band}_FLDK_R20_S{segment:02d}10.DAT.bz2"
                    (complete / file_name).write_bytes(bz2.compress(b"valid"))

            snapshot_key, _ = MODULE.find_latest_complete_snapshot(root, bands, 4, {1, 2, 3, 4})
            self.assertEqual(snapshot_key, "202601011000")

    def test_dynamic_factor_uses_paper_60_degree_boundary(self) -> None:
        pv = 0.2
        pc = 0.3
        low = MODULE.compute_dynamic_threshold_factor(45.0, pv, pc)
        high = MODULE.compute_dynamic_threshold_factor(60.0, pv, pc)
        expected_low = (math.sin(math.radians(45.0)) + 1.0) * (1.0 + pv) * (1.0 + pc)
        expected_high = (1.2 * math.sin(math.radians(60.0)) + 1.0) * (1.0 + pv) * ((1.0 + pc) ** 2)
        self.assertAlmostEqual(low, expected_low)
        self.assertAlmostEqual(high, expected_high)

    def test_background_hot_filter_keeps_pixel_that_does_not_meet_equation_3(self) -> None:
        shape = (7, 7)
        b07 = np.full(shape, 300.0, dtype=np.float32)
        b13 = np.full(shape, 290.0, dtype=np.float32)
        b14 = np.full(shape, 289.0, dtype=np.float32)
        rvis = np.zeros(shape, dtype=np.float32)
        t713 = b07 - b13
        b07[2, 2] = 315.0
        b13[2, 2] = 300.0
        t713[2, 2] = 15.0
        context = MODULE.sample_background_window(
            3,
            3,
            3,
            b07,
            b13,
            b14,
            rvis,
            t713,
            np.zeros(shape, dtype=bool),
            np.ones(shape, dtype=bool),
            np.zeros(shape, dtype=bool),
            build_thresholds(),
        )
        self.assertIsNotNone(context)
        self.assertGreater(context["t7Bg"], 300.2)

    def test_daytime_seed_uses_independent_temperature_difference_and_reflectance_tests(self) -> None:
        shape = (9, 9)
        center = (4, 4)
        b07 = np.full(shape, 300.0, dtype=np.float32)
        b13 = np.full(shape, 290.0, dtype=np.float32)
        b14 = np.full(shape, 289.0, dtype=np.float32)
        rvis = np.full(shape, 0.20, dtype=np.float32)
        # 该像元符合历史真实检出样本的量级；错误地把 b13 加入反射阈值时会被漏掉。
        b07[center] = 306.33
        b13[center] = 271.37
        b14[center] = 270.50
        rvis[center] = 0.2771
        lon_grid = np.tile(np.linspace(100.0, 100.08, shape[1], dtype=np.float32), (shape[0], 1))
        lat_grid = np.tile(np.linspace(30.0, 30.08, shape[0], dtype=np.float32)[:, np.newaxis], (1, shape[1]))

        result = MODULE.detect_fire_pixels(
            acquisition_time="2026-01-01T04:00:00Z",
            source_sat="H09",
            b07=b07,
            b13=b13,
            b14=b14,
            rvis=rvis,
            lon_grid=lon_grid,
            lat_grid=lat_grid,
            roi_mask=np.ones(shape, dtype=bool),
            solar={
                "altitudeDeg": np.full(shape, 45.0, dtype=np.float32),
                "zenithDeg": np.full(shape, 45.0, dtype=np.float32),
            },
            window_sizes=[7, 9],
            thresholds=build_thresholds(),
            snapshot_key="202601010400",
            non_vegetation_mask=np.zeros(shape, dtype=bool),
            thermal_source_db={"points": [], "polygons": []},
        )

        self.assertEqual(result["stageCounts"]["suspiciousSeedPixels"], 1)
        self.assertEqual(len(result["firePixels"]), 1)
        self.assertAlmostEqual(result["firePixels"][0]["btDif"], 34.96, places=2)

    def test_t713_background_standard_deviation_is_clamped_to_paper_range(self) -> None:
        shape = (7, 7)
        available = np.ones(shape, dtype=bool)
        valid = np.ones(shape, dtype=bool)
        cloud = np.zeros(shape, dtype=bool)
        non_vegetation = np.zeros(shape, dtype=bool)
        b07 = np.full(shape, 300.0, dtype=np.float32)
        b13 = np.full(shape, 290.0, dtype=np.float32)
        rvis = np.full(shape, 0.1, dtype=np.float32)
        thresholds = build_thresholds()

        low_context = MODULE.summarize_background_pixels(
            b07,
            b13,
            rvis,
            np.full(shape, 10.0, dtype=np.float32),
            cloud,
            valid,
            non_vegetation,
            available,
            7,
            thresholds,
        )
        high_context = MODULE.summarize_background_pixels(
            b07,
            b13,
            rvis,
            np.arange(49, dtype=np.float32).reshape(shape),
            cloud,
            valid,
            non_vegetation,
            available,
            7,
            thresholds,
        )
        self.assertEqual(low_context["stdT713"], 2.0)
        self.assertEqual(high_context["stdT713"], 4.0)

    def test_night_absolute_detection_allows_missing_visible_reflectance(self) -> None:
        shape = (9, 9)
        center = (4, 4)
        b07 = np.full(shape, 300.0, dtype=np.float32)
        b13 = np.full(shape, 290.0, dtype=np.float32)
        b14 = np.full(shape, 289.0, dtype=np.float32)
        rvis = np.full(shape, np.nan, dtype=np.float32)
        b07[center] = 380.0
        b13[center] = 300.0
        lon_grid = np.tile(np.linspace(100.0, 100.08, shape[1], dtype=np.float32), (shape[0], 1))
        lat_grid = np.tile(np.linspace(30.0, 30.08, shape[0], dtype=np.float32)[:, np.newaxis], (1, shape[1]))
        result = MODULE.detect_fire_pixels(
            acquisition_time="2026-01-01T16:00:00Z",
            source_sat="H09",
            b07=b07,
            b13=b13,
            b14=b14,
            rvis=rvis,
            lon_grid=lon_grid,
            lat_grid=lat_grid,
            roi_mask=np.ones(shape, dtype=bool),
            solar={
                "altitudeDeg": np.full(shape, -10.0, dtype=np.float32),
                "zenithDeg": np.full(shape, 100.0, dtype=np.float32),
            },
            window_sizes=[7, 9],
            thresholds=build_thresholds(),
            snapshot_key="202601011600",
            non_vegetation_mask=np.zeros(shape, dtype=bool),
            thermal_source_db={"points": [], "polygons": []},
        )
        self.assertEqual(len(result["fires"]), 1)
        fire = result["fires"][0]
        self.assertEqual(fire["fireStatus"], "suspected")
        self.assertIsNone(fire["diagnostics"]["rvis"])
        self.assertTrue(fire["diagnostics"]["absoluteThresholdPassed"])

    def test_evidence_score_increases_with_thermal_anomaly(self) -> None:
        background = {
            "t7Bg": 300.0,
            "stdT7": 2.0,
            "t713Bg": 10.0,
            "stdT713": 2.0,
        }
        thresholds = build_thresholds()
        weak = MODULE.compute_fire_evidence_score(
            t7=310.0,
            t713=20.0,
            background=background,
            dynamic_factor=2.0,
            night_hot=False,
            thresholds=thresholds,
        )
        strong = MODULE.compute_fire_evidence_score(
            t7=320.0,
            t713=30.0,
            background=background,
            dynamic_factor=2.0,
            night_hot=False,
            thresholds=thresholds,
        )
        self.assertGreater(strong["score"], weak["score"])


if __name__ == "__main__":
    unittest.main()
