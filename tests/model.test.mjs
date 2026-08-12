import assert from "node:assert/strict";
import test from "node:test";

import {datasetReadiness, extractFeatures, fitKnn, leaveOneTrialOut, predictKnn} from "../js/model.js";

function syntheticTrial(label, phase = 0, length = 76) {
    const samples = [];
    for (let index = 0; index < length; index += 1) {
        const seconds = index * 0.04;
        const jitter = Math.sin(index * 1.731 + phase) * 0.04;
        let ax = jitter;
        let ay = -jitter;
        let az = 9.81 + jitter;
        let gx = jitter;
        let gy = -jitter;
        let gz = jitter;

        if (label === "Shake") {
            ax += 8 * Math.sin(seconds * Math.PI * 8 + phase);
            gy += 70 * Math.sin(seconds * Math.PI * 8 + phase);
        } else if (label === "Bounce") {
            ay += 6 * Math.sin(seconds * Math.PI * 6 + phase);
            az += 2 * Math.sin(seconds * Math.PI * 12 + phase);
            gx += 50 * Math.cos(seconds * Math.PI * 6 + phase);
        }

        samples.push({t: 1_000 + index * 40, ax, ay, az, gx, gy, gz});
    }
    return {label, samples};
}

const recordings = [
    syntheticTrial("Still", 0),
    syntheticTrial("Still", 0.3),
    syntheticTrial("Still", 0.7),
    syntheticTrial("Shake", 0.1),
    syntheticTrial("Shake", 0.5),
    syntheticTrial("Shake", 0.9),
    syntheticTrial("Bounce", 0.2),
    syntheticTrial("Bounce", 0.6),
    syntheticTrial("Bounce", 1.0),
];

test("feature extraction returns a stable finite vector", () => {
    const features = extractFeatures(recordings[0].samples);
    assert.equal(features.length, 51);
    assert.ok(features.every(Number.isFinite));
});

test("feature extraction rejects an empty recording", () => {
    assert.throws(() => extractFeatures([]), /at least two/i);
});

test("k-nearest-neighbours separates synthetic activities", () => {
    const model = fitKnn(recordings, 3);
    const prediction = predictKnn(model, syntheticTrial("Shake", 0.42).samples);
    assert.equal(prediction.label, "Shake");
    assert.ok(prediction.confidence > 0.5);
});

test("leave-one-trial-out evaluates complete recordings", () => {
    const result = leaveOneTrialOut(recordings, 3);
    assert.equal(result.tested, recordings.length);
    assert.equal(result.skipped, 0);
    assert.ok(result.accuracy >= 0.88, `Expected >= 88% accuracy, received ${result.accuracy}`);
});

test("dataset readiness requires two trials for every represented label", () => {
    assert.equal(datasetReadiness(recordings).ready, true);
    assert.equal(datasetReadiness([recordings[0], recordings[3]]).ready, false);
    assert.equal(datasetReadiness([recordings[0], recordings[1], recordings[3], recordings[4]]).ready, true);
});
