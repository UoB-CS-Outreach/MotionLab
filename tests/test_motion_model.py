import math
import unittest

import motion_model


def synthetic_trial(
    label: str, phase: float = 0, length: int = 76, interval_ms: int = 40
) -> dict:
    samples = []
    for index in range(length):
        seconds = index * interval_ms / 1000
        jitter = math.sin(index * 1.731 + phase) * 0.04
        ax = jitter
        ay = -jitter
        az = 9.81 + jitter
        gx = jitter
        gy = -jitter
        gz = jitter

        if label == "Side-to-side":
            ax += 8 * math.sin(seconds * math.pi * 8 + phase)
            gy += 70 * math.sin(seconds * math.pi * 8 + phase)
        elif label == "Up-and-down":
            ay += 6 * math.sin(seconds * math.pi * 6 + phase)
            az += 2 * math.sin(seconds * math.pi * 12 + phase)
            gx += 50 * math.cos(seconds * math.pi * 6 + phase)
        elif label == "Circle":
            ax += 5.5 * math.sin(seconds * math.pi * 3.2 + phase)
            ay += 5.5 * math.cos(seconds * math.pi * 3.2 + phase)
            gx += 35 * math.sin(seconds * math.pi * 3.2 + phase)
            gy += 35 * math.cos(seconds * math.pi * 3.2 + phase)
            gz += 105

        samples.append(
            {
                "t": 1_000 + index * interval_ms,
                "ax": ax,
                "ay": ay,
                "az": az,
                "gx": gx,
                "gy": gy,
                "gz": gz,
            }
        )
    return {"label": label, "samples": samples}


RECORDINGS = [
    synthetic_trial(label, phase, length, interval_ms)
    for label in ("Still", "Side-to-side", "Up-and-down", "Circle")
    for phase, length, interval_ms in (
        (0.0, 61, 50),
        (0.3, 76, 40),
        (0.7, 101, 30),
    )
]


class MotionModelTests(unittest.TestCase):
    def tearDown(self) -> None:
        motion_model.reset_model()

    def test_resampling_returns_90_evenly_spaced_points(self) -> None:
        samples = synthetic_trial("Side-to-side", length=61, interval_ms=50)["samples"]
        resampled = motion_model.resample_samples(samples)
        self.assertEqual(len(resampled), 90)
        self.assertEqual(resampled[0]["t"], 0)
        self.assertEqual(resampled[-1]["t"], 3_000)
        self.assertAlmostEqual(resampled[45]["t"] - resampled[44]["t"], 3_000 / 89)

    def test_feature_extraction_returns_50_finite_values(self) -> None:
        features = motion_model.extract_features(RECORDINGS[0]["samples"])
        self.assertEqual(len(features), 50)
        self.assertTrue(all(math.isfinite(value) for value in features))

    def test_feature_extraction_rejects_too_few_readings(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least 30"):
            motion_model.extract_features([])

    def test_feature_extraction_rejects_a_short_duration(self) -> None:
        samples = synthetic_trial("Still", length=30, interval_ms=50)["samples"]
        with self.assertRaisesRegex(ValueError, "at least 2.5 seconds"):
            motion_model.extract_features(samples)

    def test_knn_separates_all_four_synthetic_movements(self) -> None:
        model = motion_model.fit_knn(RECORDINGS, 3)
        for label, phase in (
            ("Still", 0.5),
            ("Side-to-side", 0.5),
            ("Up-and-down", 0.5),
            ("Circle", 0.5),
        ):
            prediction = motion_model.predict_knn(
                model, synthetic_trial(label, phase)["samples"]
            )
            self.assertEqual(prediction["label"], label)

    def test_leave_one_trial_out_uses_complete_recordings(self) -> None:
        result = motion_model.leave_one_trial_out(RECORDINGS, 3)
        self.assertEqual(result["tested"], len(RECORDINGS))
        self.assertEqual(result["skipped"], 0)
        self.assertGreaterEqual(result["accuracy"], 0.9)

    def test_json_browser_api_trains_predicts_and_resets(self) -> None:
        import json

        training = motion_model.train_and_evaluate_json(json.dumps(RECORDINGS), 3)
        self.assertEqual(
            json.loads(training)["algorithm"], "knn-resampled-motion-features"
        )

        prediction = motion_model.predict_json(
            json.dumps(synthetic_trial("Circle", 0.5)["samples"])
        )
        self.assertEqual(json.loads(prediction)["label"], "Circle")

        motion_model.reset_model()
        with self.assertRaisesRegex(ValueError, "Train a model"):
            motion_model.predict_json(json.dumps(RECORDINGS[0]["samples"]))

    def test_dataset_readiness_requires_two_trials_per_label(self) -> None:
        self.assertTrue(motion_model.dataset_readiness(RECORDINGS)["ready"])
        self.assertFalse(
            motion_model.dataset_readiness([RECORDINGS[0], RECORDINGS[3]])["ready"]
        )


if __name__ == "__main__":
    unittest.main()
