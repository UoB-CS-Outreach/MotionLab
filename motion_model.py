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
MIN_RECORDING_SAMPLES = 30
MIN_RECORDING_DURATION_MS = 2_500
RECORDING_DURATION_MS = 3_000
RESAMPLED_POINTS = 90
MIN_RECORDINGS_PER_LABEL = 3
DTW_WINDOW_POINTS = 18
SUMMARY_CLASSIFIER = "summary"
DTW_CLASSIFIER = "dtw"
_model: dict[str, Any] | None = None


def _finite(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _sample_timestamp(sample: dict[str, Any]) -> float:
    for key in ("deviceTime", "t"):
        try:
            timestamp = float(sample.get(key))
        except (TypeError, ValueError):
            continue
        if math.isfinite(timestamp) and (key != "deviceTime" or timestamp != 0):
            return timestamp
    raise ValueError("Every sensor reading needs a valid timestamp.")


def resample_samples(
    samples: list[dict[str, Any]], target_length: int = RESAMPLED_POINTS
) -> list[dict[str, float]]:
    """Linearly resample six sensor channels onto a fixed three-second grid."""
    if not isinstance(samples, list) or len(samples) < MIN_RECORDING_SAMPLES:
        raise ValueError(
            f"A recording needs at least {MIN_RECORDING_SAMPLES} sensor readings."
        )
    if target_length < 2:
        raise ValueError("The resampled series needs at least two time points.")

    timed_samples = sorted(
        (
            (_sample_timestamp(sample), index, sample)
            for index, sample in enumerate(samples)
        ),
        key=lambda item: (item[0], item[1]),
    )
    source: list[dict[str, float]] = []
    for timestamp, _, sample in timed_samples:
        point = {"source_t": timestamp}
        point.update({channel: _finite(sample.get(channel)) for channel in CHANNELS})
        if source and timestamp == source[-1]["source_t"]:
            source[-1] = point
        else:
            source.append(point)

    if len(source) < MIN_RECORDING_SAMPLES:
        raise ValueError(
            f"A recording needs at least {MIN_RECORDING_SAMPLES} distinct readings."
        )

    start = source[0]["source_t"]
    end = source[-1]["source_t"]
    duration = end - start
    if duration < MIN_RECORDING_DURATION_MS:
        raise ValueError("A recording needs at least 2.5 seconds of sensor data.")

    resampled: list[dict[str, float]] = []
    right_index = 1
    for index in range(target_length):
        fraction = index / (target_length - 1)
        source_time = start + fraction * duration
        while (
            right_index < len(source) - 1
            and source[right_index]["source_t"] < source_time
        ):
            right_index += 1

        left = source[right_index - 1]
        right = source[right_index]
        interval = right["source_t"] - left["source_t"]
        weight = 0.0 if interval <= 0 else (source_time - left["source_t"]) / interval
        point = {"t": fraction * RECORDING_DURATION_MS}
        point.update(
            {
                channel: left[channel] + weight * (right[channel] - left[channel])
                for channel in CHANNELS
            }
        )
        resampled.append(point)

    return resampled


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
    """Resample one sensor recording and convert it into 50 features."""
    resampled = resample_samples(samples)

    features: list[float] = []
    for channel in CHANNELS:
        values = [sample[channel] for sample in resampled]
        features.extend(_channel_features(values))

    features.extend(_magnitude_features(resampled, ("ax", "ay", "az")))
    features.extend(_magnitude_features(resampled, ("gx", "gy", "gz")))
    return [_finite(feature) for feature in features]


def _validate_recordings(recordings: list[dict[str, Any]]) -> None:
    if not isinstance(recordings, list) or len(recordings) < 2:
        raise ValueError("At least two recordings are required.")
    if len({recording.get("label") for recording in recordings}) < 2:
        raise ValueError("Record at least two different movement labels.")


def _vector_standardiser(
    vectors: list[list[float]],
) -> tuple[list[float], list[float]]:
    columns = list(zip(*vectors))
    centres = [_mean(list(column)) for column in columns]
    scales: list[float] = []
    for column, centre in zip(columns, centres):
        scale = _standard_deviation(list(column), centre)
        scales.append(scale if scale > 1e-8 else 1.0)
    return centres, scales


def _transform_vector(
    vector: list[float], centres: list[float], scales: list[float]
) -> list[float]:
    return [
        (value - centre) / scale
        for value, centre, scale in zip(vector, centres, scales)
    ]


def _euclidean_distance(first: list[float], second: list[float]) -> float:
    return math.sqrt(sum((left - right) ** 2 for left, right in zip(first, second)))


def _weighted_vote(
    labels: list[str], neighbours: list[dict[str, Any]]
) -> dict[str, Any]:
    votes = {label: 0.0 for label in labels}
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


def fit_summary_knn(
    recordings: list[dict[str, Any]], requested_k: int = 3
) -> dict[str, Any]:
    """Fit k-NN using standardised summary-statistic feature vectors."""
    _validate_recordings(recordings)
    raw_vectors = [extract_features(recording["samples"]) for recording in recordings]
    centres, scales = _vector_standardiser(raw_vectors)
    examples = [
        {
            "label": recording["label"],
            "vector": _transform_vector(vector, centres, scales),
        }
        for recording, vector in zip(recordings, raw_vectors)
    ]
    labels = list(dict.fromkeys(recording["label"] for recording in recordings))
    return {
        "type": "summary-statistics-knn",
        "classifier": SUMMARY_CLASSIFIER,
        "k": max(1, min(int(requested_k), len(examples))),
        "resampled_points": RESAMPLED_POINTS,
        "centres": centres,
        "scales": scales,
        "examples": examples,
        "labels": labels,
    }


def predict_summary_knn(
    model: dict[str, Any], samples: list[dict[str, Any]]
) -> dict[str, Any]:
    """Predict a movement using summary-statistic feature vectors."""
    if not model or not model.get("examples"):
        raise ValueError("Train a model before predicting.")

    vector = _transform_vector(
        extract_features(samples), model["centres"], model["scales"]
    )
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
    return _weighted_vote(model["labels"], neighbours)


def _series_from_samples(samples: list[dict[str, Any]]) -> list[list[float]]:
    return [
        [sample[channel] for channel in CHANNELS]
        for sample in resample_samples(samples)
    ]


def _series_standardiser(
    series_collection: list[list[list[float]]],
) -> tuple[list[float], list[float]]:
    centres: list[float] = []
    scales: list[float] = []
    for channel_index in range(len(CHANNELS)):
        values = [
            point[channel_index] for series in series_collection for point in series
        ]
        centre = _mean(values)
        scale = _standard_deviation(values, centre)
        centres.append(centre)
        scales.append(scale if scale > 1e-8 else 1.0)
    return centres, scales


def _transform_series(
    series: list[list[float]], centres: list[float], scales: list[float]
) -> list[list[float]]:
    return [
        [
            (value - centre) / scale
            for value, centre, scale in zip(point, centres, scales)
        ]
        for point in series
    ]


def dtw_distance(
    first: list[list[float]],
    second: list[list[float]],
    window: int = DTW_WINDOW_POINTS,
) -> float:
    """Return path-length-normalised multivariate Dynamic Time Warping distance."""
    if not first or not second:
        raise ValueError("DTW needs two non-empty time series.")
    if len(first[0]) != len(second[0]):
        raise ValueError("DTW time series must have the same number of channels.")

    first_length = len(first)
    second_length = len(second)
    window = max(abs(first_length - second_length), int(window))
    infinity = math.inf
    previous_costs = [infinity] * (second_length + 1)
    previous_lengths = [0] * (second_length + 1)
    previous_costs[0] = 0.0

    for first_index in range(1, first_length + 1):
        current_costs = [infinity] * (second_length + 1)
        current_lengths = [0] * (second_length + 1)
        start = max(1, first_index - window)
        stop = min(second_length, first_index + window)
        for second_index in range(start, stop + 1):
            left = first[first_index - 1]
            right = second[second_index - 1]
            local_cost = sum(
                (left_value - right_value) ** 2
                for left_value, right_value in zip(left, right)
            ) / len(left)
            predecessor_cost, predecessor_length = min(
                (
                    (previous_costs[second_index], previous_lengths[second_index]),
                    (
                        current_costs[second_index - 1],
                        current_lengths[second_index - 1],
                    ),
                    (
                        previous_costs[second_index - 1],
                        previous_lengths[second_index - 1],
                    ),
                ),
                key=lambda candidate: candidate[0],
            )
            current_costs[second_index] = local_cost + predecessor_cost
            current_lengths[second_index] = predecessor_length + 1
        previous_costs = current_costs
        previous_lengths = current_lengths

    final_cost = previous_costs[second_length]
    path_length = previous_lengths[second_length]
    if not math.isfinite(final_cost) or path_length == 0:
        raise ValueError("The DTW alignment window is too narrow for these series.")
    return math.sqrt(final_cost / path_length)


def fit_dtw_knn(
    recordings: list[dict[str, Any]], requested_k: int = 3
) -> dict[str, Any]:
    """Fit a standardised, distance-weighted DTW nearest-neighbour model."""
    _validate_recordings(recordings)
    raw_series = [
        _series_from_samples(recording["samples"]) for recording in recordings
    ]
    centres, scales = _series_standardiser(raw_series)
    examples = [
        {
            "label": recording["label"],
            "series": _transform_series(series, centres, scales),
        }
        for recording, series in zip(recordings, raw_series)
    ]
    labels = list(dict.fromkeys(recording["label"] for recording in recordings))
    return {
        "type": "dtw-knn-resampled-series",
        "classifier": DTW_CLASSIFIER,
        "k": max(1, min(int(requested_k), len(examples))),
        "resampled_points": RESAMPLED_POINTS,
        "dtw_window": DTW_WINDOW_POINTS,
        "centres": centres,
        "scales": scales,
        "examples": examples,
        "labels": labels,
    }


def predict_dtw_knn(
    model: dict[str, Any], samples: list[dict[str, Any]]
) -> dict[str, Any]:
    """Predict a movement with a fitted DTW nearest-neighbour model."""
    if not model or not model.get("examples"):
        raise ValueError("Train a model before predicting.")

    series = _transform_series(
        _series_from_samples(samples), model["centres"], model["scales"]
    )
    neighbours = sorted(
        (
            {
                "label": example["label"],
                "distance": dtw_distance(
                    series, example["series"], model["dtw_window"]
                ),
            }
            for example in model["examples"]
        ),
        key=lambda neighbour: neighbour["distance"],
    )[: model["k"]]

    return _weighted_vote(model["labels"], neighbours)


def _normalise_classifier(classifier: str) -> str:
    value = str(classifier).strip().lower()
    if value not in {SUMMARY_CLASSIFIER, DTW_CLASSIFIER}:
        raise ValueError(f"Unsupported classifier: {classifier}")
    return value


def fit_classifier(
    recordings: list[dict[str, Any]],
    requested_k: int = 3,
    classifier: str = SUMMARY_CLASSIFIER,
) -> dict[str, Any]:
    """Fit the selected classifier, defaulting to summary statistics."""
    classifier = _normalise_classifier(classifier)
    if classifier == DTW_CLASSIFIER:
        return fit_dtw_knn(recordings, requested_k)
    return fit_summary_knn(recordings, requested_k)


def predict_classifier(
    model: dict[str, Any], samples: list[dict[str, Any]]
) -> dict[str, Any]:
    """Predict using the classifier recorded in a fitted model."""
    if model.get("classifier") == DTW_CLASSIFIER:
        return predict_dtw_knn(model, samples)
    return predict_summary_knn(model, samples)


def leave_one_trial_out(
    recordings: list[dict[str, Any]],
    requested_k: int = 3,
    classifier: str = SUMMARY_CLASSIFIER,
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
        model = fit_classifier(training, requested_k, classifier)
        prediction = predict_classifier(model, held_out["samples"])
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
    """Summarise whether every represented label has three examples."""
    counts = Counter(recording["label"] for recording in recordings or [])
    return {
        "ready": len(counts) >= 2
        and all(count >= MIN_RECORDINGS_PER_LABEL for count in counts.values()),
        "counts": dict(counts),
        "labels": len(counts),
        "recordings": len(recordings or []),
    }


def train_and_evaluate_json(
    recordings_json: str,
    requested_k: int = 3,
    classifier: str = SUMMARY_CLASSIFIER,
) -> str:
    """Fit the browser's in-memory model and return its evaluation as JSON."""
    global _model
    recordings = json.loads(recordings_json)
    classifier = _normalise_classifier(classifier)
    evaluation = leave_one_trial_out(recordings, requested_k, classifier)
    _model = fit_classifier(recordings, requested_k, classifier)
    return json.dumps(
        {
            "evaluation": evaluation,
            "algorithm": _model["type"],
            "classifier": _model["classifier"],
            "labels": _model["labels"],
        },
        allow_nan=False,
    )


def predict_json(samples_json: str) -> str:
    """Classify one recording with the browser's current in-memory model."""
    if _model is None:
        raise ValueError("Train a model before predicting.")
    prediction = predict_classifier(_model, json.loads(samples_json))
    return json.dumps(prediction, allow_nan=False)


def reset_model() -> None:
    """Discard the model held by this browser tab."""
    global _model
    _model = None
