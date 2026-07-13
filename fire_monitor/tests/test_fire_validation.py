from __future__ import annotations

import importlib.util
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_script_module(name: str, relative_path: str):
    module_path = PROJECT_ROOT / relative_path
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载脚本模块：{module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


EVALUATOR = load_script_module("evaluate_himawari_fire", "scripts/evaluate-himawari-fire.py")
INTERFERENCE = load_script_module("build_fire_interference_data", "scripts/build-fire-interference-data.py")


def detection(detection_id: str, lon: float, lat: float, hour: int):
    return EVALUATOR.Detection(
        detection_id=detection_id,
        sensor="test",
        lon=lon,
        lat=lat,
        acquisition_time=datetime(2026, 7, 13, hour, tzinfo=timezone.utc),
        confidence="high",
        frp=10.0,
        properties={},
    )


class FireValidationTests(unittest.TestCase):
    def test_no_reference_detections_does_not_report_zero_metrics(self) -> None:
        metrics = EVALUATOR.build_metrics(1.0, [detection("candidate", 110.0, 30.0, 9)], [], [], 5.0)
        self.assertEqual(metrics["status"], "no_reference_detections")
        self.assertIsNone(metrics["precision"])
        self.assertIsNone(metrics["recall"])

    def test_matching_is_one_to_one(self) -> None:
        candidates = [
            detection("candidate-1", 110.0, 30.0, 9),
            detection("candidate-2", 110.001, 30.001, 9),
        ]
        references = [detection("reference-1", 110.0, 30.0, 8)]
        matches = EVALUATOR.match_detections(candidates, references, 5.0, 3.0)
        metrics = EVALUATOR.build_metrics(3.0, candidates, references, matches, 5.0)
        self.assertEqual(len(matches), 1)
        self.assertEqual(metrics["truePositive"], 1)
        self.assertEqual(metrics["falsePositive"], 1)
        self.assertEqual(metrics["falseNegative"], 0)

    def test_photovoltaic_radius_is_conservative_and_bounded(self) -> None:
        self.assertEqual(INTERFERENCE.photovoltaic_radius_km(0.0), 0.25)
        self.assertGreater(INTERFERENCE.photovoltaic_radius_km(100.0), 0.25)
        self.assertEqual(INTERFERENCE.photovoltaic_radius_km(100000.0), 2.5)


if __name__ == "__main__":
    unittest.main()
