const CHANNELS = ["ax", "ay", "az", "gx", "gy", "gz"];

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function mean(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, average = mean(values)) {
    if (values.length < 2) return 0;
    const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}

function channelFeatures(values) {
    if (!values.length) return [0, 0, 0, 0, 0, 0, 0];

    const average = mean(values);
    const deviation = standardDeviation(values, average);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const rms = Math.sqrt(mean(values.map(value => value ** 2)));
    const meanAbsoluteDelta = values.length < 2
        ? 0
        : mean(values.slice(1).map((value, index) => Math.abs(value - values[index])));
    const zeroCrossings = values.length < 2
        ? 0
        : values.slice(1).reduce((count, value, index) => {
            const previous = values[index] - average;
            const current = value - average;
            return count + (previous * current < 0 ? 1 : 0);
        }, 0) / (values.length - 1);

    return [average, deviation, minimum, maximum, rms, meanAbsoluteDelta, zeroCrossings];
}

function magnitudeFeatures(samples, keys) {
    const magnitudes = samples.map(sample => Math.hypot(...keys.map(key => finite(sample[key]))));
    const average = mean(magnitudes);
    const deviation = standardDeviation(magnitudes, average);
    const range = magnitudes.length ? Math.max(...magnitudes) - Math.min(...magnitudes) : 0;
    const meanAbsoluteDelta = magnitudes.length < 2
        ? 0
        : mean(magnitudes.slice(1).map((value, index) => Math.abs(value - magnitudes[index])));
    return [average, deviation, range, meanAbsoluteDelta];
}

/**
 * Convert one variable-length sensor trial into a fixed-length feature vector.
 * Statistical features make the prototype tolerant of small sampling-rate differences.
 */
export function extractFeatures(samples) {
    if (!Array.isArray(samples) || samples.length < 2) {
        throw new Error("A recording needs at least two sensor samples.");
    }

    const features = [];
    for (const channel of CHANNELS) {
        features.push(...channelFeatures(samples.map(sample => finite(sample[channel]))));
    }

    features.push(...magnitudeFeatures(samples, ["ax", "ay", "az"]));
    features.push(...magnitudeFeatures(samples, ["gx", "gy", "gz"]));

    const timestamps = samples.map(sample => finite(sample.t));
    const durationSeconds = Math.max(0.001, (timestamps.at(-1) - timestamps[0]) / 1000);
    features.push(samples.length / durationSeconds);

    return features.map(finite);
}

function standardiser(vectors) {
    const width = vectors[0].length;
    const centres = Array.from({length: width}, (_, column) => mean(vectors.map(vector => vector[column])));
    const scales = Array.from({length: width}, (_, column) => {
        const values = vectors.map(vector => vector[column]);
        const scale = standardDeviation(values, centres[column]);
        return scale > 1e-8 ? scale : 1;
    });
    return {centres, scales};
}

function transform(vector, centres, scales) {
    return vector.map((value, index) => (value - centres[index]) / scales[index]);
}

function validateRecordings(recordings) {
    if (!Array.isArray(recordings) || recordings.length < 2) {
        throw new Error("At least two recordings are required.");
    }
    const labels = new Set(recordings.map(recording => recording.label));
    if (labels.size < 2) {
        throw new Error("Record at least two different movement labels.");
    }
}

/** Build a small k-nearest-neighbours model from complete, labelled trials. */
export function fitKnn(recordings, requestedK = 3) {
    validateRecordings(recordings);
    const rawVectors = recordings.map(recording => extractFeatures(recording.samples));
    const {centres, scales} = standardiser(rawVectors);
    const examples = recordings.map((recording, index) => ({
        label: recording.label,
        vector: transform(rawVectors[index], centres, scales),
    }));

    return {
        type: "knn-motion-features",
        k: Math.max(1, Math.min(Math.floor(requestedK), examples.length)),
        centres,
        scales,
        examples,
        labels: [...new Set(recordings.map(recording => recording.label))],
    };
}

function euclideanDistance(a, b) {
    return Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
}

/** Predict a movement and return a transparent confidence heuristic. */
export function predictKnn(model, samples) {
    if (!model?.examples?.length) throw new Error("Train a model before predicting.");

    const vector = transform(extractFeatures(samples), model.centres, model.scales);
    const neighbours = model.examples
        .map(example => ({...example, distance: euclideanDistance(vector, example.vector)}))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, model.k);

    const votes = new Map(model.labels.map(label => [label, 0]));
    for (const neighbour of neighbours) {
        const weight = 1 / Math.max(0.05, neighbour.distance);
        votes.set(neighbour.label, (votes.get(neighbour.label) ?? 0) + weight);
    }

    const total = [...votes.values()].reduce((sum, value) => sum + value, 0) || 1;
    const probabilities = Object.fromEntries([...votes].map(([label, vote]) => [label, vote / total]));
    const [label, confidence] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];

    return {label, confidence, probabilities, neighbours: neighbours.map(({label: neighbourLabel, distance}) => ({label: neighbourLabel, distance}))};
}

/**
 * Leave one complete recording out at a time. Splitting by trial avoids putting
 * near-duplicate windows from the same performance in both train and test data.
 */
export function leaveOneTrialOut(recordings, requestedK = 3) {
    validateRecordings(recordings);
    const labels = [...new Set(recordings.map(recording => recording.label))];
    const confusion = Object.fromEntries(labels.map(actual => [actual, Object.fromEntries(labels.map(predicted => [predicted, 0]))]));
    let correct = 0;
    let tested = 0;
    let skipped = 0;

    recordings.forEach((heldOut, heldOutIndex) => {
        const training = recordings.filter((_, index) => index !== heldOutIndex);
        if (new Set(training.map(recording => recording.label)).size < 2) {
            skipped += 1;
            return;
        }
        const model = fitKnn(training, requestedK);
        const prediction = predictKnn(model, heldOut.samples);
        confusion[heldOut.label][prediction.label] += 1;
        correct += prediction.label === heldOut.label ? 1 : 0;
        tested += 1;
    });

    return {
        accuracy: tested ? correct / tested : null,
        correct,
        tested,
        skipped,
        confusion,
    };
}

export function datasetReadiness(recordings) {
    const counts = new Map();
    for (const recording of recordings ?? []) {
        counts.set(recording.label, (counts.get(recording.label) ?? 0) + 1);
    }
    const readyLabels = [...counts.values()].filter(count => count >= 2).length;
    return {
        ready: counts.size >= 2 && readyLabels === counts.size,
        counts,
        labels: counts.size,
        recordings: recordings?.length ?? 0,
    };
}

export {CHANNELS};
