const DEFAULT_COLOURS = ["#1769e0", "#00a99d", "#f05d4e"];

export class SignalChart {
    constructor(canvas, keys, {colours = DEFAULT_COLOURS, maxPoints = 150, minimumRange = 12} = {}) {
        this.canvas = canvas;
        this.context = canvas.getContext("2d");
        this.keys = keys;
        this.colours = colours;
        this.maxPoints = maxPoints;
        this.minimumRange = minimumRange;
        this.points = [];
        this.pendingDraw = false;
        this.resizeObserver = new ResizeObserver(() => this.scheduleDraw());
        this.resizeObserver.observe(canvas);
        this.draw();
    }

    add(sample) {
        this.points.push(this.keys.map(key => Number.isFinite(sample[key]) ? sample[key] : 0));
        if (this.points.length > this.maxPoints) this.points.shift();
        this.scheduleDraw();
    }

    clear() {
        this.points = [];
        this.scheduleDraw();
    }

    setSamples(samples) {
        this.points = samples
            .slice(-this.maxPoints)
            .map(sample => this.keys.map(key => Number.isFinite(sample[key]) ? sample[key] : 0));
        this.scheduleDraw();
    }

    scheduleDraw() {
        if (this.pendingDraw) return;
        this.pendingDraw = true;
        requestAnimationFrame(() => {
            this.pendingDraw = false;
            this.draw();
        });
    }

    draw() {
        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(260, rect.width || 260);
        const height = Math.max(150, rect.height || 190);
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
            this.canvas.width = Math.round(width * ratio);
            this.canvas.height = Math.round(height * ratio);
        }

        const ctx = this.context;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);

        ctx.strokeStyle = "#e5eaf0";
        ctx.lineWidth = 1;
        for (let row = 1; row < 4; row += 1) {
            const y = (height / 4) * row;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
        for (let column = 1; column < 6; column += 1) {
            const x = (width / 6) * column;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }

        const values = this.points.flat();
        const observed = values.length ? Math.max(...values.map(Math.abs)) : 0;
        const range = Math.max(this.minimumRange, observed * 1.15);
        const midY = height / 2;

        ctx.strokeStyle = "#b9c4d0";
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();

        if (this.points.length < 2) return;
        const xStep = width / Math.max(1, this.maxPoints - 1);
        const startX = width - (this.points.length - 1) * xStep;

        this.keys.forEach((_, channelIndex) => {
            ctx.strokeStyle = this.colours[channelIndex];
            ctx.lineWidth = 1.7;
            ctx.lineJoin = "round";
            ctx.beginPath();
            this.points.forEach((point, index) => {
                const x = startX + index * xStep;
                const y = midY - (point[channelIndex] / range) * midY * 0.92;
                if (index === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();
        });
    }
}
