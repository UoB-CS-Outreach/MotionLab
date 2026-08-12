function valueOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

export class PhoneMotionSensor {
    constructor(onSample, {minimumInterval = 35} = {}) {
        this.onSample = onSample;
        this.minimumInterval = minimumInterval;
        this.lastSentAt = 0;
        this.sequence = 0;
        this.running = false;
        this.boundHandler = event => this.handleMotion(event);
        this.wakeLock = null;
    }

    static support() {
        if (!("DeviceMotionEvent" in window)) {
            return {supported: false, reason: "This browser does not expose phone motion sensors."};
        }
        if (!window.isSecureContext && location.hostname !== "localhost") {
            return {supported: false, reason: "Motion sensors require an HTTPS page."};
        }
        return {supported: true, reason: ""};
    }

    async start() {
        const support = PhoneMotionSensor.support();
        if (!support.supported) throw new Error(support.reason);

        if (typeof DeviceMotionEvent.requestPermission === "function") {
            const permission = await DeviceMotionEvent.requestPermission();
            if (permission !== "granted") {
                throw new Error("Motion sensor permission was not granted.");
            }
        }

        window.addEventListener("devicemotion", this.boundHandler, {passive: true});
        this.running = true;
        await this.requestWakeLock();
    }

    stop() {
        window.removeEventListener("devicemotion", this.boundHandler);
        this.running = false;
        if (this.wakeLock) this.wakeLock.release().catch(() => {});
        this.wakeLock = null;
    }

    async requestWakeLock() {
        if (!("wakeLock" in navigator)) return;
        try {
            this.wakeLock = await navigator.wakeLock.request("screen");
        } catch {
            // Screen wake locks are a convenience; sensor capture works without one.
        }
    }

    handleMotion(event) {
        const now = performance.now();
        if (now - this.lastSentAt < this.minimumInterval) return;
        this.lastSentAt = now;

        const acceleration = event.accelerationIncludingGravity ?? event.acceleration ?? {};
        const rotation = event.rotationRate ?? {};
        this.onSample({
            type: "sensor",
            t: Date.now(),
            seq: this.sequence += 1,
            ax: valueOrZero(acceleration.x),
            ay: valueOrZero(acceleration.y),
            az: valueOrZero(acceleration.z),
            gx: valueOrZero(rotation.alpha),
            gy: valueOrZero(rotation.beta),
            gz: valueOrZero(rotation.gamma),
            interval: valueOrZero(event.interval),
            source: event.accelerationIncludingGravity ? "device-motion-with-gravity" : "device-motion-linear",
        });
    }
}
