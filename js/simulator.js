const PATTERNS = new Set(["still", "shake", "bounce", "circle"]);

export class MotionSimulator {
    constructor(onSample, intervalMilliseconds = 40) {
        this.onSample = onSample;
        this.intervalMilliseconds = intervalMilliseconds;
        this.pattern = "still";
        this.timer = null;
        this.startedAt = 0;
        this.sequence = 0;
    }

    setPattern(pattern) {
        this.pattern = PATTERNS.has(pattern) ? pattern : "still";
        this.startedAt = performance.now();
    }

    start() {
        if (this.timer) return;
        this.startedAt = performance.now();
        this.timer = window.setInterval(() => this.tick(), this.intervalMilliseconds);
        this.tick();
    }

    stop() {
        if (this.timer) window.clearInterval(this.timer);
        this.timer = null;
    }

    get running() {
        return Boolean(this.timer);
    }

    tick() {
        const seconds = (performance.now() - this.startedAt) / 1000;
        const noise = (amount = 0.15) => (Math.random() - 0.5) * amount;
        let ax = noise();
        let ay = noise();
        let az = 9.81 + noise();
        let gx = noise(1.5);
        let gy = noise(1.5);
        let gz = noise(1.5);

        if (this.pattern === "shake") {
            ax += 8 * Math.sin(seconds * Math.PI * 8);
            gx += 25 * Math.cos(seconds * Math.PI * 8);
            gy += 70 * Math.sin(seconds * Math.PI * 8);
        } else if (this.pattern === "bounce") {
            ay += 6.5 * Math.sin(seconds * Math.PI * 6);
            az += 2.2 * Math.sin(seconds * Math.PI * 12);
            gx += 55 * Math.cos(seconds * Math.PI * 6);
        } else if (this.pattern === "circle") {
            ax += 5.5 * Math.sin(seconds * Math.PI * 3.2);
            ay += 5.5 * Math.cos(seconds * Math.PI * 3.2);
            gx += 35 * Math.sin(seconds * Math.PI * 3.2);
            gy += 35 * Math.cos(seconds * Math.PI * 3.2);
            gz += 105;
        }

        this.onSample({
            type: "sensor",
            t: Date.now(),
            seq: this.sequence += 1,
            ax, ay, az, gx, gy, gz,
            interval: this.intervalMilliseconds,
            source: "simulator",
        });
    }
}
