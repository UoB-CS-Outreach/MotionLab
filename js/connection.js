import {RELAY_CONFIG} from "./relay-config.js";
import {selectTransports} from "./transports/index.js";
import {randomToken} from "./transports/util.js";

// Phone and computer never connect to each other directly. Both join a
// session on one or more relay services, and the phone sends its readings
// through whichever relay is currently answering. The computer creates the
// session code itself, so the QR code appears without any network round trip.
//
// Message kinds (all carry r: sender role):
//   phone → computer: hello, ping, data, bye
//   computer → phone: welcome, pong (both name the phone currently in charge)

export const PROTOCOL_VERSION = 1;
export const TIMING = {
    batchMs: 200, // readings per relay message: ~6 at the phone's ~28 Hz
    heartbeatMs: 3000, // keeps every relay's health known, not just the active one
    healthTimeoutMs: 8000, // no reply for this long means the relay is unhealthy
    retryMs: 15000, // a relay that failed to open is retried after this long
    maxPending: 150, // readings kept while no relay is healthy (~5 s)
    resendRows: 400, // recent readings re-sent after switching relay (~14 s)
    maxRowsPerMessage: 60, // keeps each relay message small (a few KB)
};

export function newSessionCode() {
    return randomToken(20); // 100 random bits; also acts as the session's access token
}

const round = value => Math.round((Number(value) || 0) * 1000) / 1000;

export function encodeSample(sample) {
    return [
        sample.seq ?? 0,
        sample.t ?? 0,
        round(sample.ax), round(sample.ay), round(sample.az),
        round(sample.gx), round(sample.gy), round(sample.gz),
        round(sample.interval),
    ];
}

export function decodeSample(row, source = "") {
    const [seq, t, ax, ay, az, gx, gy, gz, interval] = Array.isArray(row) ? row : [];
    return {type: "sensor", seq, t, ax, ay, az, gx, gy, gz, interval, source};
}

export class PairingBridge {
    constructor({
        role,
        session = "",
        onStatus = () => {},
        onData = () => {},
        onReady = () => {},
        onRoutes = () => {},
        config = RELAY_CONFIG,
        relayOverride = "",
        transports = null,
        timing = {},
    }) {
        this.role = role;
        this.session = session;
        this.onStatus = onStatus;
        this.onData = onData;
        this.onReady = onReady;
        this.onRoutes = onRoutes;
        this.config = config;
        this.transports = transports ?? selectTransports(config, relayOverride);
        this.timing = {...TIMING, ...timing};
        this.routes = [];
        this.timers = [];
        this.destroyed = true;
        this.lastStatus = "";

        // Phone state
        this.phoneId = "";
        this.pending = [];
        this.recent = [];
        this.lastActiveRoute = "";
        this.source = "";

        // Computer state
        this.currentPhone = "";
        this.retiredPhones = new Set();
        this.lastSequence = 0;
        this.lastHeardFromPhone = 0;
        this.lastRoute = "";
        this.playback = [];
        this.playbackTimer = null;
    }

    get configured() {
        return this.transports.length > 0;
    }

    get connected() {
        if (this.destroyed) return false;
        if (this.role === "phone") return this.routes.some(route => route.healthy);
        return Boolean(this.currentPhone) && Date.now() - this.lastHeardFromPhone < this.timing.healthTimeoutMs;
    }

    get activeRoute() {
        // Plain failover: the first answering relay in the configured order. The phone
        // moves only when a relay stops answering, and back once the preferred one recovers.
        return this.routes.find(route => route.healthy) ?? null;
    }

    routeSummary() {
        const active = this.role === "phone" ? this.activeRoute?.id : this.lastRoute;
        return this.routes.map(route => ({
            id: route.id,
            label: route.label,
            state: route.state,
            healthy: route.healthy,
            rtt: route.rtt,
            detail: route.detail,
            active: route.id === active && this.connected,
        }));
    }

    start() {
        this.destroy();
        this.destroyed = false;

        if (this.role === "desktop") {
            if (!this.session) this.session = newSessionCode();
            if (!this.configured) {
                this.emitStatus("error", "No relay service configured");
                return;
            }
            this.onReady(this.session);
        } else {
            this.phoneId = randomToken(10);
            if (!this.session) {
                this.emitStatus("error", "Pairing link is incomplete");
                return;
            }
            if (!this.configured) {
                this.emitStatus("error", "No relay service configured");
                return;
            }
        }

        this.routes = this.transports.map(transport => ({
            id: transport.id,
            label: transport.label,
            factory: transport,
            instance: null,
            state: "connecting",
            detail: "",
            healthy: false,
            welcomed: false,
            lastHeard: 0,
            rtt: null,
        }));
        this.routes.forEach(route => this.openRoute(route));

        this.every(1000, () => this.refresh());
        if (this.role === "phone") {
            this.every(this.timing.heartbeatMs, () => this.heartbeat());
            this.every(this.timing.batchMs, () => this.flush());
        }
        this.refresh();
    }

    every(milliseconds, callback) {
        this.timers.push(setInterval(callback, milliseconds));
    }

    openRoute(route) {
        if (this.destroyed) return;
        route.state = "connecting";
        route.detail = "";
        route.healthy = false;
        route.welcomed = false;
        const instance = route.factory.create({
            session: this.session,
            role: this.role,
            config: this.config,
            onMessage: message => {
                if (route.instance === instance) this.receive(route, message);
            },
            onState: (state, detail) => {
                if (route.instance === instance) this.routeState(route, state, detail);
            },
        });
        route.instance = instance;
        Promise.resolve()
            .then(() => instance.open())
            .then(() => {
                if (route.instance !== instance || this.destroyed) return;
                if (route.state === "connecting") this.routeState(route, "ready", route.detail);
            })
            .catch(error => {
                if (route.instance === instance) this.routeState(route, "failed", error?.message ?? String(error));
            });
    }

    routeState(route, state, detail = "") {
        if (this.destroyed || state === "closed") return;
        const previous = route.state;
        route.state = state;
        route.detail = detail ?? "";
        if (state !== "ready") route.healthy = false;
        if (state === "ready" && previous !== "ready" && this.role === "phone") {
            route.welcomed = false;
            if (!this.sendOn(route, {k: "hello", v: PROTOCOL_VERSION, p: this.phoneId})) {
                // The relay reported ready a moment before it could send; try again shortly
                // rather than waiting a full heartbeat.
                this.timers.push(setTimeout(() => this.heartbeat(), 500));
            }
        }
        if (state === "failed") {
            const instance = route.instance;
            const timer = setTimeout(() => {
                if (!this.destroyed && route.instance === instance) {
                    try {
                        instance?.close();
                    } catch {
                        // Already unusable.
                    }
                    this.openRoute(route);
                }
            }, this.timing.retryMs);
            this.timers.push(timer);
        }
        this.refresh();
    }

    sendOn(route, message) {
        if (route.state !== "ready" || !route.instance) return false;
        try {
            return route.instance.send({...message, r: this.role}) !== false;
        } catch {
            return false;
        }
    }

    receive(route, message) {
        if (this.destroyed || !message || typeof message !== "object") return;
        if (message.r === this.role) return; // our own message echoed back by a relay
        if (this.role === "desktop") this.receiveAtDesktop(route, message);
        else this.receiveAtPhone(route, message);
    }

    // ---------------------------------------------------------------- computer

    receiveAtDesktop(route, message) {
        const phone = typeof message.p === "string" ? message.p : "";
        if (!phone) return;

        if (message.k === "hello") {
            if (phone !== this.currentPhone) {
                // A replaced phone never takes the session back. Without this, a late
                // hello (from a relay that has just reconnected, or one that waited in a
                // Firebase mailbox) would undo a takeover and push the newer phone off.
                if (this.retiredPhones.has(phone)) {
                    this.sendOn(route, {k: "welcome", v: PROTOCOL_VERSION, p: phone, cur: this.currentPhone});
                    return;
                }
                // The most recent phone to scan takes over, as before.
                if (this.currentPhone) this.retiredPhones.add(this.currentPhone);
                this.currentPhone = phone;
                this.lastSequence = 0;
            }
            this.heard(route);
            this.sendOn(route, {k: "welcome", v: PROTOCOL_VERSION, p: phone, cur: this.currentPhone});
            return;
        }
        if (message.k === "ping") {
            if (phone === this.currentPhone) this.heard(route);
            this.sendOn(route, {k: "pong", p: phone, n: message.n, cur: this.currentPhone});
            return;
        }
        if (phone !== this.currentPhone) return;
        if (message.k === "bye") {
            this.lastHeardFromPhone = 0;
            this.refresh();
            return;
        }
        if (message.k === "data" && Array.isArray(message.s)) {
            this.heard(route);
            if (this.lastRoute !== route.id) {
                this.lastRoute = route.id;
                this.refresh();
            }
            this.deliver(message.s, message.src ?? "");
        }
    }

    heard(route) {
        const wasConnected = this.connected;
        route.lastHeard = Date.now();
        route.healthy = true;
        this.lastHeardFromPhone = route.lastHeard;
        if (!this.lastRoute) this.lastRoute = route.id;
        if (!wasConnected) this.refresh();
    }

    deliver(rows, source) {
        const samples = rows
            .map(row => decodeSample(row, source))
            .filter(sample => Number.isFinite(sample.seq) && sample.seq > this.lastSequence)
            .sort((a, b) => a.seq - b.seq);
        if (!samples.length) return;
        this.lastSequence = samples.at(-1).seq;
        this.playback.push(...samples);
        if (!this.playbackTimer) this.play();
    }

    // Readings arrive in small batches. Release them one by one at their
    // original spacing so the live chart moves smoothly rather than in jumps,
    // catching up at once if a backlog builds (e.g. after a relay switch).
    play() {
        this.playbackTimer = null;
        while (this.playback.length && !this.destroyed) {
            const sample = this.playback.shift();
            this.onData(sample);
            const next = this.playback[0];
            if (!next) return;
            const backlog = this.playback.length > this.timing.batchMs / 20;
            const gap = backlog ? 0 : Math.max(0, Math.min(100, next.t - sample.t));
            if (gap > 0) {
                this.playbackTimer = setTimeout(() => this.play(), gap);
                return;
            }
        }
    }

    // ------------------------------------------------------------------ phone

    receiveAtPhone(route, message) {
        if (message.p && message.p !== this.phoneId) return; // a reply meant for another phone
        if (message.cur && message.cur !== this.phoneId) {
            this.emitStatus("error", "Another phone has taken over");
            this.destroy();
            return;
        }
        if (message.k === "welcome" || message.k === "pong") {
            route.welcomed = true;
            route.healthy = true;
            route.lastHeard = Date.now();
            if (message.k === "pong" && Number.isFinite(message.n)) route.rtt = Date.now() - message.n;
            this.refresh();
        }
    }

    heartbeat() {
        for (const route of this.routes) {
            if (route.state !== "ready") continue;
            if (!route.welcomed) this.sendOn(route, {k: "hello", v: PROTOCOL_VERSION, p: this.phoneId});
            else this.sendOn(route, {k: "ping", p: this.phoneId, n: Date.now()});
        }
    }

    send(sample) {
        if (this.destroyed || this.role !== "phone") return false;
        this.source = sample?.source ?? this.source;
        this.pending.push(encodeSample(sample));
        if (this.pending.length > this.timing.maxPending) {
            this.pending.splice(0, this.pending.length - this.timing.maxPending);
        }
        return this.connected;
    }

    flush() {
        const route = this.activeRoute;
        if (!route) return; // keep readings until a relay answers again

        let rows = this.pending;
        const previous = this.routes.find(item => item.id === this.lastActiveRoute);
        if (previous && previous !== route) {
            // Readings sent through the previous relay may have been dropped before it
            // was declared unhealthy, or still be in flight when the phone moves back to
            // the preferred one. Re-send recent readings; the computer ignores any it has.
            const oldestPending = rows.length ? rows[0][0] : Infinity;
            rows = [...this.recent.filter(row => row[0] < oldestPending), ...rows];
        }
        if (!rows.length) return;

        for (let start = 0; start < rows.length; start += this.timing.maxRowsPerMessage) {
            const chunk = rows.slice(start, start + this.timing.maxRowsPerMessage);
            if (!this.sendOn(route, {k: "data", p: this.phoneId, s: chunk, src: this.source})) return;
        }
        this.lastActiveRoute = route.id;
        this.recent.push(...this.pending);
        if (this.recent.length > this.timing.resendRows) {
            this.recent.splice(0, this.recent.length - this.timing.resendRows);
        }
        this.pending = [];
    }

    // ----------------------------------------------------------------- shared

    // Re-sends the current status, e.g. after the page showed something else in the status chip.
    announce() {
        this.lastStatus = "";
        if (!this.configured) this.emitStatus("error", "No relay service configured");
        else this.refresh();
    }

    refresh() {
        if (this.destroyed || !this.configured) return;
        const now = Date.now();
        for (const route of this.routes) {
            if (route.healthy && now - route.lastHeard > this.timing.healthTimeoutMs) route.healthy = false;
        }

        const labels = this.routes.map(route => route.label);
        const ready = this.routes.filter(route => route.state === "ready");
        const allFailed = this.routes.length > 0 && this.routes.every(route => route.state === "failed");

        if (this.role === "desktop") {
            if (this.connected) {
                this.emitStatus("connected", "Phone connected");
            } else if (allFailed) {
                this.emitStatus("error", "No relay service reachable");
            } else if (ready.length) {
                this.emitStatus("waiting", this.currentPhone ? "Phone disconnected" : "Waiting for phone");
            } else {
                this.emitStatus("waiting", `Preparing a session (${labels.join(", ")})`);
            }
        } else if (this.connected) {
            this.emitStatus("connected", "Connected to computer");
        } else if (allFailed) {
            this.emitStatus("error", "No relay service reachable");
        } else if (this.routes.some(route => route.welcomed)) {
            this.emitStatus("waiting", "Reconnecting to computer");
        } else {
            this.emitStatus("waiting", "Connecting to computer");
        }
        this.onRoutes(this.routeSummary());
    }

    emitStatus(state, message) {
        const key = `${state}|${message}`;
        if (key === this.lastStatus) return;
        this.lastStatus = key;
        this.onStatus(state, message);
    }

    destroy() {
        if (this.role === "phone" && !this.destroyed) {
            for (const route of this.routes) this.sendOn(route, {k: "bye", p: this.phoneId});
        }
        this.destroyed = true;
        for (const timer of this.timers) {
            clearInterval(timer);
            clearTimeout(timer);
        }
        this.timers = [];
        for (const route of this.routes) {
            const instance = route.instance;
            route.instance = null;
            try {
                instance?.close();
            } catch {
                // Nothing further to release.
            }
        }
        this.routes = [];
        this.pending = [];
        this.recent = [];
        this.lastActiveRoute = "";
        this.currentPhone = "";
        this.retiredPhones.clear();
        this.lastSequence = 0;
        this.lastHeardFromPhone = 0;
        this.lastRoute = "";
        this.lastStatus = "";
        clearTimeout(this.playbackTimer);
        this.playbackTimer = null;
        this.playback = [];
    }
}
