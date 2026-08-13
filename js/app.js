import {SignalChart} from "./chart.js";
import {PeerBridge} from "./connection.js";
import {PhoneMotionSensor} from "./sensors.js";
import {MotionSimulator} from "./simulator.js";
import {PythonMotionModel} from "./python-model.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "phone" ? "phone" : "desktop";
const wait = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds));

let toastTimer;
function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

function setStatus(element, state, message) {
    element.className = `status-chip ${state}`;
    element.innerHTML = `<span></span>${message}`;
}

function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function formatReading(value) {
    const number = safeNumber(value);
    const limited = Math.max(-999, Math.min(999, number));
    return limited.toFixed(2);
}

function datasetReadiness(recordings) {
    const counts = new Map();
    for (const recording of recordings ?? []) {
        counts.set(recording.label, (counts.get(recording.label) ?? 0) + 1);
    }
    return {
        ready: counts.size >= 2 && [...counts.values()].every(count => count >= 2),
        counts,
        labels: counts.size,
        recordings: recordings?.length ?? 0,
    };
}

if (mode === "phone") {
    initPhone();
} else {
    initDesktop();
}

function initDesktop() {
    $("desktopView").hidden = false;
    $("modePill").textContent = "Computer station";

    const state = {
        bridge: null,
        simulator: null,
        recordings: [],
        liveBuffer: [],
        rateTimes: [],
        recording: null,
        captureBusy: false,
        viewedRecordingId: null,
        pythonModel: new PythonMotionModel(),
        modelEngineReady: false,
        modelLoadError: false,
        modelTrained: false,
        lastSampleAt: 0,
        lastPredictionAt: 0,
        source: "none",
    };

    const accelerationChart = new SignalChart($("accelChart"), ["ax", "ay", "az"], {minimumRange: 12});
    const gyroscopeChart = new SignalChart($("gyroChart"), ["gx", "gy", "gz"], {minimumRange: 90});
    const recordedAccelerationChart = new SignalChart($("recordedAccelChart"), ["ax", "ay", "az"], {minimumRange: 12, maxPoints: 1000, fitWidth: true});
    const recordedGyroscopeChart = new SignalChart($("recordedGyroChart"), ["gx", "gy", "gz"], {minimumRange: 90, maxPoints: 1000, fitWidth: true});
    state.simulator = new MotionSimulator(sample => receiveSample(sample, "simulator"));

    function updateDesktopStatus(status, message) {
        setStatus($("desktopConnectionStatus"), status, message);
        if (status === "connected") {
            state.source = "phone";
            if (state.simulator.running) stopSimulator(false);
        }
    }

    function startPairingSession() {
        state.bridge?.destroy();
        $("qrCode").innerHTML = '<div class="qr-placeholder">Creating<br>QR code...</div>';

        state.bridge = new PeerBridge({
            role: "desktop",
            onStatus: updateDesktopStatus,
            onReady: peerId => displayPairingLink(peerId),
            onData: data => {
                if (data?.type === "sensor") receiveSample(data, "phone");
            },
        });

        try {
            state.bridge.start();
        } catch (error) {
            updateDesktopStatus("error", "Online pairing unavailable");
            $("qrCode").innerHTML = '<div class="qr-placeholder">Pairing needs<br>internet access</div>';
            showToast(error.message);
        }
    }

    function displayPairingLink(peerId) {
        const url = new URL(location.href);
        url.search = "";
        url.hash = "";
        url.searchParams.set("mode", "phone");
        url.searchParams.set("peer", peerId);
        const link = url.toString();
        $("qrCode").innerHTML = "";

        if (typeof window.QRCode === "function") {
            new window.QRCode($("qrCode"), {
                text: link,
                width: 156,
                height: 156,
                colorDark: "#081f3d",
                colorLight: "#ffffff",
                correctLevel: window.QRCode.CorrectLevel.M,
            });
        } else {
            $("qrCode").innerHTML = '<div class="qr-placeholder">QR code generation is unavailable.<br>Refresh and try again.</div>';
        }

        if (["localhost", "127.0.0.1"].includes(location.hostname)) {
            showToast("This local link only works on this computer. Publish with HTTPS before scanning it on a phone.");
        }
    }

    function receiveSample(incoming, source) {
        const now = Date.now();
        const sample = {
            t: now,
            deviceTime: safeNumber(incoming.t),
            ax: safeNumber(incoming.ax),
            ay: safeNumber(incoming.ay),
            az: safeNumber(incoming.az),
            gx: safeNumber(incoming.gx),
            gy: safeNumber(incoming.gy),
            gz: safeNumber(incoming.gz),
            interval: safeNumber(incoming.interval),
            source: incoming.source ?? source,
        };

        state.source = source;
        state.lastSampleAt = now;
        state.rateTimes.push(now);
        state.rateTimes = state.rateTimes.filter(time => now - time <= 2000);
        state.liveBuffer.push(sample);
        state.liveBuffer = state.liveBuffer.filter(item => now - item.t <= 5000);

        if (state.recording) state.recording.samples.push({...sample});

        accelerationChart.add(sample);
        gyroscopeChart.add(sample);
        updateReadingCards(sample);
        $("sampleRate").textContent = `${Math.round(state.rateTimes.length / 2)} samples/s`;
        updateRecordButton();

        if (state.modelTrained && now - state.lastPredictionAt >= 350) {
            state.lastPredictionAt = now;
            updatePrediction();
        }
    }

    function updateReadingCards(sample) {
        $("desktopAx").textContent = formatReading(sample.ax);
        $("desktopAy").textContent = formatReading(sample.ay);
        $("desktopAz").textContent = formatReading(sample.az);
        $("desktopGx").textContent = formatReading(sample.gx);
        $("desktopGy").textContent = formatReading(sample.gy);
        $("desktopGz").textContent = formatReading(sample.gz);
    }

    function streamIsFresh() {
        return Date.now() - state.lastSampleAt < 1800;
    }

    function updateRecordButton() {
        const unavailable = state.captureBusy || !streamIsFresh();
        $("recordBtn").disabled = unavailable;
        $("testPredictionBtn").disabled = unavailable || !state.modelTrained;
    }

    function updatePrediction() {
        if (!state.modelTrained) return;
        const now = Date.now();
        const windowSamples = state.liveBuffer.filter(sample => now - sample.t <= 3000);
        const duration = windowSamples.length > 1 ? windowSamples.at(-1).t - windowSamples[0].t : 0;
        if (windowSamples.length < 30 || duration < 2500) {
            $("predictionLabel").textContent = "Waiting for movement...";
            $("predictionConfidence").textContent = "Collecting a three-second window";
            $("confidenceBar").style.width = "0%";
            return;
        }

        try {
            const prediction = state.pythonModel.predict(windowSamples);
            const confidencePercent = Math.round(prediction.confidence * 100);
            $("predictionLabel").textContent = prediction.label;
            $("predictionConfidence").textContent = `${confidencePercent}% of neighbour vote`;
            $("confidenceBar").style.width = `${confidencePercent}%`;
        } catch (error) {
            $("predictionLabel").textContent = "Prediction unavailable";
            $("predictionConfidence").textContent = error.message;
        }
    }

    async function recordTrial() {
        if (state.captureBusy || !streamIsFresh()) {
            showToast("Start the phone sensors or simulator before recording.");
            return;
        }

        const label = selectedLabel();
        if (!label) {
            showToast("Enter a movement label first.");
            $("customLabel").focus();
            return;
        }

        state.captureBusy = true;
        updateRecordButton();
        $("recordBtn").innerHTML = '<span class="record-dot"></span> Preparing...';
        $("recordProgress").hidden = false;
        $("recordProgressBar").style.width = "0%";

        for (let count = 3; count >= 1; count -= 1) {
            $("recordProgressText").textContent = `Get ready: ${count}`;
            await wait(650);
            if (!streamIsFresh()) {
                state.captureBusy = false;
                finishRecordingUi();
                showToast("The sensor stream stopped before recording began.");
                return;
            }
        }

        state.recording = {label, samples: [], startedAt: Date.now()};
        $("recordBtn").innerHTML = '<span class="record-dot"></span> Recording...';
        const duration = 3000;
        const progressTimer = window.setInterval(() => {
            const elapsed = Date.now() - state.recording.startedAt;
            const percentage = Math.min(100, (elapsed / duration) * 100);
            $("recordProgressBar").style.width = `${percentage}%`;
            $("recordProgressText").textContent = percentage < 100 ? "Recording..." : "Finishing...";
        }, 80);

        await wait(duration);
        window.clearInterval(progressTimer);
        const completed = state.recording;
        state.recording = null;
        state.captureBusy = false;
        finishRecordingUi();

        if (completed.samples.length < 15) {
            showToast("Too few readings arrived. Please reconnect and try again.");
            return;
        }

        completed.id = crypto.randomUUID?.() ?? `trial-${Date.now()}-${state.recordings.length + 1}`;
        completed.duration = completed.samples.at(-1).t - completed.samples[0].t;
        state.recordings.push(completed);
        state.viewedRecordingId = completed.id;
        invalidateModel();
        renderDataset();
        showToast(`Recorded “${label}” with ${completed.samples.length} samples.`);
    }

    function finishRecordingUi() {
        $("recordProgressBar").style.width = "100%";
        $("recordProgressText").textContent = "Saved";
        window.setTimeout(() => {
            $("recordProgress").hidden = true;
            $("recordProgressBar").style.width = "0%";
        }, 550);
        $("recordBtn").innerHTML = '<span class="record-dot"></span> Record 3 seconds';
        updateRecordButton();
    }

    function selectedLabel() {
        const selection = $("activityLabel").value;
        return selection === "custom" ? $("customLabel").value.trim() : selection;
    }

    function renderDataset() {
        const readiness = datasetReadiness(state.recordings);
        $("datasetEmpty").hidden = state.recordings.length > 0;
        $("datasetSummary").hidden = state.recordings.length === 0;
        $("recordingViewer").hidden = state.recordings.length === 0;
        $("clearDataBtn").disabled = state.recordings.length === 0;
        $("undoRecordingBtn").disabled = state.recordings.length === 0;
        $("deleteRecordingBtn").disabled = state.recordings.length === 0;
        $("trainBtn").disabled = !readiness.ready || !state.modelEngineReady;

        $("datasetSummary").innerHTML = [...readiness.counts]
            .map(([label, count]) => `
                <div class="dataset-label">
                    <strong title="${escapeHtml(label)}">${escapeHtml(label)}</strong>
                    <span>${count} ${count === 1 ? "recording" : "recordings"}${count >= 3 ? " · ready" : " · aim for 3"}</span>
                </div>`)
            .join("");

        renderRecordingViewer();

        if (state.modelLoadError) {
            $("trainingHint").textContent = "Python could not load. Refresh the page and check the internet connection.";
        } else if (readiness.ready && !state.modelEngineReady) {
            $("trainingHint").textContent = "Your data is ready. Waiting for Python to finish loading.";
        } else if (readiness.ready) {
            $("trainingHint").textContent = `${readiness.recordings} recordings across ${readiness.labels} movements are ready.`;
        } else if (readiness.labels < 2) {
            $("trainingHint").textContent = "Collect at least two recordings for each of two movement labels.";
        } else {
            const shortLabels = [...readiness.counts].filter(([, count]) => count < 2).map(([label]) => label);
            $("trainingHint").textContent = `Add another recording for: ${shortLabels.join(", ")}.`;
        }
    }

    function renderRecordingViewer() {
        const select = $("recordingViewerSelect");
        select.innerHTML = "";
        if (!state.recordings.length) {
            state.viewedRecordingId = null;
            recordedAccelerationChart.clear();
            recordedGyroscopeChart.clear();
            $("recordingMeta").textContent = "";
            return;
        }

        if (!state.recordings.some(recording => recording.id === state.viewedRecordingId)) {
            state.viewedRecordingId = state.recordings.at(-1).id;
        }

        state.recordings.forEach((recording, index) => {
            const option = document.createElement("option");
            option.value = recording.id;
            option.textContent = `${index + 1}. ${recording.label}`;
            option.selected = recording.id === state.viewedRecordingId;
            select.append(option);
        });
        showSelectedRecording();
    }

    function showSelectedRecording() {
        const recording = state.recordings.find(item => item.id === state.viewedRecordingId);
        if (!recording) return;
        recordedAccelerationChart.setSamples(recording.samples);
        recordedGyroscopeChart.setSamples(recording.samples);
        const durationSeconds = recording.duration / 1000;
        const rate = durationSeconds > 0 ? Math.round(recording.samples.length / durationSeconds) : 0;
        $("recordingMeta").textContent = `${recording.samples.length} samples over ${durationSeconds.toFixed(1)} seconds · approximately ${rate} samples/s`;
    }

    function invalidateModel() {
        state.pythonModel.reset();
        state.modelTrained = false;
        $("modelState").className = state.modelLoadError ? "model-state error" : "model-state";
        $("modelState").textContent = state.modelLoadError
            ? "Python unavailable"
            : state.modelEngineReady ? "Not trained" : "Loading Python";
        $("modelResults").hidden = true;
        $("testPredictionPanel").hidden = true;
        $("testPredictionResult").hidden = true;
        updateRecordButton();
    }

    function trainModel() {
        const readiness = datasetReadiness(state.recordings);
        if (!readiness.ready || !state.modelEngineReady) return;

        try {
            const result = state.pythonModel.trainAndEvaluate(state.recordings, 3);
            const evaluation = result.evaluation;
            state.modelTrained = true;
            $("modelState").className = "model-state ready";
            $("modelState").textContent = "Model trained";
            $("modelResults").hidden = false;
            $("testPredictionPanel").hidden = false;
            $("modelAccuracy").textContent = evaluation.accuracy === null ? "—" : `${Math.round(evaluation.accuracy * 100)}%`;
            $("accuracyDetail").textContent = evaluation.tested
                ? `${evaluation.correct} of ${evaluation.tested} held-out trials correct`
                : "Add more trials to evaluate";
            $("predictionLabel").textContent = "Waiting for movement...";
            $("predictionConfidence").textContent = "Collecting a three-second window";
            $("confidenceBar").style.width = "0%";
            showToast("Model trained. Try a movement without pressing record.");
            updateRecordButton();
            updatePrediction();
        } catch (error) {
            showToast(error.message);
        }
    }

    async function recordTestPrediction() {
        if (state.captureBusy || !state.modelTrained || !streamIsFresh()) {
            showToast("Train the model and start the sensor stream before recording a test movement.");
            return;
        }

        state.captureBusy = true;
        updateRecordButton();
        $("testPredictionResult").hidden = true;
        $("testPredictionBtn").textContent = "Preparing...";
        $("testProgress").hidden = false;
        $("testProgressBar").style.width = "0%";

        for (let count = 3; count >= 1; count -= 1) {
            $("testProgressText").textContent = `Get ready: ${count}`;
            await wait(650);
            if (!streamIsFresh()) {
                state.captureBusy = false;
                finishTestPredictionUi(false);
                showToast("The sensor stream stopped before the test began.");
                return;
            }
        }

        state.recording = {samples: [], startedAt: Date.now()};
        $("testPredictionBtn").textContent = "Recording...";
        const duration = 3000;
        const progressTimer = window.setInterval(() => {
            const elapsed = Date.now() - state.recording.startedAt;
            const percentage = Math.min(100, (elapsed / duration) * 100);
            $("testProgressBar").style.width = `${percentage}%`;
            $("testProgressText").textContent = percentage < 100 ? "Recording..." : "Classifying...";
        }, 80);

        await wait(duration);
        window.clearInterval(progressTimer);
        const completed = state.recording;
        state.recording = null;
        state.captureBusy = false;

        if (completed.samples.length < 15) {
            finishTestPredictionUi(false);
            showToast("Too few readings arrived. Please reconnect and try again.");
            return;
        }

        try {
            const prediction = state.pythonModel.predict(completed.samples);
            const confidencePercent = Math.round(prediction.confidence * 100);
            $("testPredictionLabel").textContent = prediction.label;
            $("testPredictionConfidence").textContent = `${confidencePercent}% of neighbour vote`;
            $("testPredictionResult").hidden = false;
            finishTestPredictionUi(true);
            showToast(`Recorded test predicted as “${prediction.label}”.`);
        } catch (error) {
            finishTestPredictionUi(false);
            showToast(error.message);
        }
    }

    function finishTestPredictionUi(success) {
        $("testProgressBar").style.width = success ? "100%" : "0%";
        $("testProgressText").textContent = success ? "Classified" : "Stopped";
        window.setTimeout(() => {
            $("testProgress").hidden = true;
            $("testProgressBar").style.width = "0%";
        }, 550);
        $("testPredictionBtn").textContent = "Record test movement";
        updateRecordButton();
    }

    async function initialisePythonModel() {
        $("modelState").className = "model-state";
        $("modelState").textContent = "Loading Python";
        try {
            await state.pythonModel.initialise();
            state.modelEngineReady = true;
            state.modelLoadError = false;
            $("modelState").textContent = "Not trained";
        } catch (error) {
            state.modelLoadError = true;
            $("modelState").className = "model-state error";
            $("modelState").textContent = "Python unavailable";
            showToast(error.message);
        }
        renderDataset();
        updateRecordButton();
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>'"]/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "'": "&#39;",
            '"': "&quot;",
        })[character]);
    }

    function startSimulator() {
        state.source = "simulator";
        state.simulator.setPattern($("demoPattern").value);
        state.simulator.start();
        $("toggleDemoBtn").textContent = "Stop simulator";
        setStatus($("desktopConnectionStatus"), "connected", "Simulator running");
        showToast("Demo signal started. Change the movement before each recording.");
    }

    function stopSimulator(updateStatus = true) {
        state.simulator.stop();
        $("toggleDemoBtn").textContent = "Start simulator";
        if (updateStatus) {
            if (state.bridge?.connected) setStatus($("desktopConnectionStatus"), "connected", "Phone connected");
            else setStatus($("desktopConnectionStatus"), "waiting", "Waiting for phone");
        }
    }

    $("newSessionBtn").addEventListener("click", startPairingSession);
    $("toggleDemoBtn").addEventListener("click", () => state.simulator.running ? stopSimulator() : startSimulator());
    $("demoPattern").addEventListener("change", () => {
        state.simulator.setPattern($("demoPattern").value);
        const labels = {still: "Still", shake: "Side-to-side shake", bounce: "Up-and-down bounce", circle: "Circle"};
        $("activityLabel").value = labels[$("demoPattern").value];
        $("customLabelWrap").hidden = true;
        $("recordControls").classList.remove("has-custom");
    });
    $("activityLabel").addEventListener("change", () => {
        const hasCustomLabel = $("activityLabel").value === "custom";
        $("customLabelWrap").hidden = !hasCustomLabel;
        $("recordControls").classList.toggle("has-custom", hasCustomLabel);
        if (hasCustomLabel) $("customLabel").focus();
    });
    $("recordingViewerSelect").addEventListener("change", () => {
        state.viewedRecordingId = $("recordingViewerSelect").value;
        showSelectedRecording();
    });
    $("recordBtn").addEventListener("click", recordTrial);
    $("trainBtn").addEventListener("click", trainModel);
    $("testPredictionBtn").addEventListener("click", recordTestPrediction);
    $("deleteRecordingBtn").addEventListener("click", () => {
        const selectedIndex = state.recordings.findIndex(recording => recording.id === state.viewedRecordingId);
        if (selectedIndex < 0) return;
        const selected = state.recordings[selectedIndex];
        if (!window.confirm(`Delete the selected “${selected.label}” recording?`)) return;

        state.recordings.splice(selectedIndex, 1);
        const nextIndex = Math.min(selectedIndex, state.recordings.length - 1);
        state.viewedRecordingId = nextIndex >= 0 ? state.recordings[nextIndex].id : null;
        invalidateModel();
        renderDataset();
        showToast(`Deleted the selected “${selected.label}” recording.`);
    });
    $("undoRecordingBtn").addEventListener("click", () => {
        const removed = state.recordings.pop();
        if (!removed) return;
        if (state.viewedRecordingId === removed.id) state.viewedRecordingId = null;
        invalidateModel();
        renderDataset();
        showToast(`Removed the last “${removed.label}” recording.`);
    });
    $("clearDataBtn").addEventListener("click", () => {
        if (!window.confirm("Clear all movement recordings and the trained model?")) return;
        state.recordings = [];
        state.viewedRecordingId = null;
        invalidateModel();
        renderDataset();
        showToast("Dataset cleared.");
    });

    window.setInterval(() => {
        if (!streamIsFresh() && !state.captureBusy) {
            updateRecordButton();
            $("sampleRate").textContent = "0 samples/s";
        }
    }, 1000);

    window.addEventListener("beforeunload", () => {
        state.simulator.stop();
        state.bridge?.destroy();
    });

    renderDataset();
    initialisePythonModel();
    startPairingSession();
}

function initPhone() {
    $("phoneView").hidden = false;
    $("modePill").textContent = "Phone sensor";
    const targetId = params.get("peer") ?? "";
    const rateTimes = [];
    let bridge;
    let sensor;

    function updatePhoneStatus(status, message) {
        setStatus($("phoneConnectionStatus"), status, message);
        const support = PhoneMotionSensor.support();
        $("enableSensorsBtn").disabled = status !== "connected" || !support.supported || sensor?.running;
        if (!support.supported) $("permissionNote").textContent = support.reason;
    }

    function handlePhoneSample(sample) {
        bridge.send(sample);
        const now = Date.now();
        rateTimes.push(now);
        while (rateTimes.length && now - rateTimes[0] > 2000) rateTimes.shift();

        $("phoneAx").textContent = formatReading(sample.ax);
        $("phoneAy").textContent = formatReading(sample.ay);
        $("phoneAz").textContent = formatReading(sample.az);
        $("phoneGx").textContent = formatReading(sample.gx);
        $("phoneGy").textContent = formatReading(sample.gy);
        $("phoneGz").textContent = formatReading(sample.gz);
        $("phoneRate").textContent = String(Math.round(rateTimes.length / 2));
    }

    sensor = new PhoneMotionSensor(handlePhoneSample);
    bridge = new PeerBridge({
        role: "phone",
        targetId,
        onStatus: updatePhoneStatus,
    });

    $("enableSensorsBtn").addEventListener("click", async () => {
        $("enableSensorsBtn").disabled = true;
        $("enableSensorsBtn").textContent = "Requesting permission...";
        try {
            await sensor.start();
            $("enableSensorsBtn").textContent = "Motion sensors enabled";
            $("permissionNote").textContent = "Keep this page open. Return to the computer to label and record movements.";
        } catch (error) {
            $("enableSensorsBtn").textContent = "Try enabling sensors again";
            $("enableSensorsBtn").disabled = !bridge.connected;
            $("permissionNote").textContent = error.message;
            showToast(error.message);
        }
    });

    if (!targetId) {
        updatePhoneStatus("error", "Pairing link is incomplete");
        $("permissionNote").textContent = "Scan a fresh QR code from the Motion Lab computer.";
    } else {
        try {
            bridge.start();
        } catch (error) {
            updatePhoneStatus("error", "Online pairing unavailable");
            $("permissionNote").textContent = error.message;
        }
    }

    window.addEventListener("beforeunload", () => {
        sensor.stop();
        bridge.destroy();
    });
}
