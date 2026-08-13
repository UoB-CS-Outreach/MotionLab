import math
import unittest

import motion_model


def synthetic_trial(label: str, phase: float = 0, length: int = 76) -> dict:
    samples = []
    for index in range(length):
        seconds = index * 0.04
        jitter = math.sin(index * 1.731 + phase) * 0.04
        ax = jitter
        ay = -jitter
        az = 9.81 + jitter
        gx = jitter
        gy = -jitter
        gz = jitter

        if label == "Shake":
            ax += 8 * math.sin(seconds * math.pi * 8 + phase)
            gy += 70 * math.sin(seconds * math.pi * 8 + phase)
        elif label == "Bounce":
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
                "t": 1_000 + index * 40,
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
    synthetic_trial(label, phase)
    for label in ("Still", "Shake", "Bounce", "Circle")
    for phase in (0.0, 0.3, 0.7)
]


class MotionModelTests(unittest.TestCase):
    def tearDown(self) -> None:
        motion_model.reset_model()

    def test_feature_extraction_returns_51_finite_values(self) -> None:
        features = motion_model.extract_features(RECORDINGS[0]["samples"])
        self.assertEqual(len(features), 51)
        self.assertTrue(all(math.isfinite(value) for value in features))

    def test_feature_extraction_rejects_an_empty_recording(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least two"):
            motion_model.extract_features([])

    def test_knn_separates_all_four_synthetic_movements(self) -> None:
        model = motion_model.fit_knn(RECORDINGS, 3)
        for label, phase in (
            ("Still", 0.5),
            ("Shake", 0.5),
            ("Bounce", 0.5),
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
        self.assertEqual(json.loads(training)["algorithm"], "knn-motion-features")

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
