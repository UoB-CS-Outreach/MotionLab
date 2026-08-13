const PYODIDE_BASE_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.2/full/";

export class PythonMotionModel {
    constructor() {
        this.pyodide = null;
        this.ready = false;
        this.trained = false;
    }

    async initialise() {
        await this.loadRuntimeScript();
        if (typeof window.loadPyodide !== "function") {
            throw new Error("The Python runtime could not be loaded.");
        }

        this.pyodide = await window.loadPyodide({indexURL: PYODIDE_BASE_URL});
        const modelUrl = new URL("../motion_model.py", import.meta.url);
        const response = await fetch(modelUrl, {cache: "no-cache"});
        if (!response.ok) {
            throw new Error(`The Python model file could not be loaded (${response.status}).`);
        }
        await this.pyodide.runPythonAsync(await response.text());
        this.ready = true;
    }

    loadRuntimeScript() {
        if (typeof window.loadPyodide === "function") return Promise.resolve();

        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = `${PYODIDE_BASE_URL}pyodide.js`;
            script.onload = resolve;
            script.onerror = () => reject(new Error("The Python runtime could not be downloaded."));
            document.head.append(script);
        });
    }

    trainAndEvaluate(recordings, requestedK = 3) {
        this.requireReady();
        const result = this.callJsonFunction(
            "train_and_evaluate_json",
            recordings,
            requestedK,
        );
        this.trained = true;
        return result;
    }

    predict(samples) {
        this.requireReady();
        if (!this.trained) throw new Error("Train a model before predicting.");
        return this.callJsonFunction("predict_json", samples);
    }

    reset() {
        this.trained = false;
        if (this.ready) this.pyodide.runPython("reset_model()");
    }

    callJsonFunction(functionName, value, numberArgument = null) {
        const payloadName = "MOTION_LAB_JSON_PAYLOAD";
        this.pyodide.globals.set(payloadName, JSON.stringify(value));
        try {
            const suffix = numberArgument === null ? "" : `, ${Number(numberArgument)}`;
            const json = this.pyodide.runPython(
                `${functionName}(${payloadName}${suffix})`,
            );
            return JSON.parse(json);
        } finally {
            this.pyodide.globals.delete(payloadName);
        }
    }

    requireReady() {
        if (!this.ready) throw new Error("Python is still loading.");
    }
}
