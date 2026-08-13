"""Motion Lab feature extraction and machine-learning functions.

This module runs both in ordinary Python tests and in Pyodide inside the web
browser. Browser-facing functions accept and return JSON so JavaScript never
has to retain Python proxy objects.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from typing import Any

CHANNELS = ("ax", "ay", "az", "gx", "gy", "gz")
_model: dict[str, Any] | None = None


def _finite(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _standard_deviation(values: list[float], average: float | None = None) -> float:
    if len(values) < 2:
        return 0.0
    centre = _mean(values) if average is None else average
    variance = sum((value - centre) ** 2 for value in values) / len(values)
    return math.sqrt(variance)


def _channel_features(values: list[float]) -> list[float]:
    if not values:
        return [0.0] * 7

    average = _mean(values)
    deviation = _standard_deviation(values, average)
    root_mean_square = math.sqrt(_mean([value**2 for value in values]))
    absolute_changes = [
        abs(current - previous) for previous, current in zip(values, values[1:])
    ]
    crossings = sum(
        (previous - average) * (current - average) < 0
        for previous, current in zip(values, values[1:])
    )
    crossing_rate = crossings / (len(values) - 1) if len(values) > 1 else 0.0

    return [
        average,
        deviation,
        min(values),
        max(values),
        root_mean_square,
        _mean(absolute_changes),
        crossing_rate,
    ]


def _magnitude_features(
    samples: list[dict[str, Any]], keys: tuple[str, str, str]
) -> list[float]:
    magnitudes = [
        math.hypot(*(_finite(sample.get(key)) for key in keys)) for sample in samples
    ]
    average = _mean(magnitudes)
    deviation = _standard_deviation(magnitudes, average)
    value_range = max(magnitudes) - min(magnitudes) if magnitudes else 0.0
    absolute_changes = [
        abs(current - previous) for previous, current in zip(magnitudes, magnitudes[1:])
    ]
    return [average, deviation, value_range, _mean(absolute_changes)]


def extract_features(samples: list[dict[str, Any]]) -> list[float]:
    """Convert one variable-length sensor recording into 51 features."""
    if not isinstance(samples, list) or len(samples) < 2:
        raise ValueError("A recording needs at least two sensor samples.")

    features: list[float] = []
    for channel in CHANNELS:
        values = [_finite(sample.get(channel)) for sample in samples]
        features.extend(_channel_features(values))

    features.extend(_magnitude_features(samples, ("ax", "ay", "az")))
    features.extend(_magnitude_features(samples, ("gx", "gy", "gz")))

    timestamps = [_finite(sample.get("t")) for sample in samples]
    duration_seconds = max(0.001, (timestamps[-1] - timestamps[0]) / 1000)
    features.append(len(samples) / duration_seconds)
    return [_finite(feature) for feature in features]


def _validate_recordings(recordings: list[dict[str, Any]]) -> None:
    if not isinstance(recordings, list) or len(recordings) < 2:
        raise ValueError("At least two recordings are required.")
    if len({recording.get("label") for recording in recordings}) < 2:
        raise ValueError("Record at least two different movement labels.")


def _standardiser(vectors: list[list[float]]) -> tuple[list[float], list[float]]:
    columns = list(zip(*vectors))
    centres = [_mean(list(column)) for column in columns]
    scales = []
    for column, centre in zip(columns, centres):
        scale = _standard_deviation(list(column), centre)
        scales.append(scale if scale > 1e-8 else 1.0)
    return centres, scales


def _transform(
    vector: list[float], centres: list[float], scales: list[float]
) -> list[float]:
    return [
        (value - centre) / scale
        for value, centre, scale in zip(vector, centres, scales)
    ]


def fit_knn(recordings: list[dict[str, Any]], requested_k: int = 3) -> dict[str, Any]:
    """Fit a standardised, distance-weighted k-nearest-neighbour model."""
    _validate_recordings(recordings)
    raw_vectors = [extract_features(recording["samples"]) for recording in recordings]
    centres, scales = _standardiser(raw_vectors)
    examples = [
        {
            "label": recording["label"],
            "vector": _transform(vector, centres, scales),
        }
        for recording, vector in zip(recordings, raw_vectors)
    ]
    labels = list(dict.fromkeys(recording["label"] for recording in recordings))
    return {
        "type": "knn-motion-features",
        "k": max(1, min(int(requested_k), len(examples))),
        "centres": centres,
        "scales": scales,
        "examples": examples,
        "labels": labels,
    }


def _euclidean_distance(first: list[float], second: list[float]) -> float:
    return math.sqrt(sum((left - right) ** 2 for left, right in zip(first, second)))


def predict_knn(model: dict[str, Any], samples: list[dict[str, Any]]) -> dict[str, Any]:
    """Predict a movement with a fitted k-nearest-neighbour model."""
    if not model or not model.get("examples"):
        raise ValueError("Train a model before predicting.")

    vector = _transform(extract_features(samples), model["centres"], model["scales"])
    neighbours = sorted(
        (
            {
                "label": example["label"],
                "distance": _euclidean_distance(vector, example["vector"]),
            }
            for example in model["examples"]
        ),
        key=lambda neighbour: neighbour["distance"],
    )[: model["k"]]

    votes = {label: 0.0 for label in model["labels"]}
    for neighbour in neighbours:
        weight = 1 / max(0.05, neighbour["distance"])
        votes[neighbour["label"]] += weight

    total = sum(votes.values()) or 1.0
    probabilities = {label: vote / total for label, vote in votes.items()}
    label = max(probabilities, key=probabilities.get)
    return {
        "label": label,
        "confidence": probabilities[label],
        "probabilities": probabilities,
        "neighbours": neighbours,
    }


def leave_one_trial_out(
    recordings: list[dict[str, Any]], requested_k: int = 3
) -> dict[str, Any]:
    """Evaluate by holding out each complete recording in turn."""
    _validate_recordings(recordings)
    labels = list(dict.fromkeys(recording["label"] for recording in recordings))
    confusion = {actual: {predicted: 0 for predicted in labels} for actual in labels}
    correct = 0
    tested = 0
    skipped = 0

    for held_out_index, held_out in enumerate(recordings):
        training = [
            recording
            for index, recording in enumerate(recordings)
            if index != held_out_index
        ]
        if len({recording["label"] for recording in training}) < 2:
            skipped += 1
            continue
        model = fit_knn(training, requested_k)
        prediction = predict_knn(model, held_out["samples"])
        confusion[held_out["label"]][prediction["label"]] += 1
        correct += prediction["label"] == held_out["label"]
        tested += 1

    return {
        "accuracy": correct / tested if tested else None,
        "correct": correct,
        "tested": tested,
        "skipped": skipped,
        "confusion": confusion,
    }


def dataset_readiness(recordings: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarise whether every represented label has two examples."""
    counts = Counter(recording["label"] for recording in recordings or [])
    return {
        "ready": len(counts) >= 2 and all(count >= 2 for count in counts.values()),
        "counts": dict(counts),
        "labels": len(counts),
        "recordings": len(recordings or []),
    }


def train_and_evaluate_json(recordings_json: str, requested_k: int = 3) -> str:
    """Fit the browser's in-memory model and return its evaluation as JSON."""
    global _model
    recordings = json.loads(recordings_json)
    evaluation = leave_one_trial_out(recordings, requested_k)
    _model = fit_knn(recordings, requested_k)
    return json.dumps(
        {
            "evaluation": evaluation,
            "algorithm": _model["type"],
            "labels": _model["labels"],
        },
        allow_nan=False,
    )


def predict_json(samples_json: str) -> str:
    """Classify one recording with the browser's current in-memory model."""
    if _model is None:
        raise ValueError("Train a model before predicting.")
    prediction = predict_knn(_model, json.loads(samples_json))
    return json.dumps(prediction, allow_nan=False)


def reset_model() -> None:
    """Discard the model held by this browser tab."""
    global _model
    _model = None
